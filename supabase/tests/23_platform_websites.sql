-- =============================================================================
-- LOCAL BASIC — Platform website builder suite
--
-- What has to hold:
--
--   1. Only a Platform Admin can see or change a website. A tenant owner —
--      the most privileged tenant role there is — cannot, and neither can anon.
--   2. Authorship cannot be forged. created_by is auth.uid() whatever the
--      insert said.
--   3. A website belongs to a real, living organization, and cannot be moved.
--   4. A definition cannot contain markup, a non-https URL, an unknown section
--      type or an external link — refused on the way in, not sanitised out.
--   5. The draft and the published copy are separate. Editing one never
--      changes the other.
--   6. Publishing snapshots a version and is append-only.
--   7. Every change leaves an audit line, through the existing audit system.
--
-- Run with:  psql -v ON_ERROR_STOP=1 -f supabase/tests/23_platform_websites.sql
-- =============================================================================

\set ON_ERROR_STOP on

do $$
declare
  u_admin uuid; u_owner uuid; u_other uuid;
  org_a uuid; branch_a uuid; org_b uuid; branch_b uuid;
  w_id uuid;
  n int; ok boolean; msg text; v int;
  good jsonb;
  def jsonb;
begin
  -- ==========================================================================
  -- Fixture: one platform admin, one tenant owner, one unrelated tenant owner.
  -- ==========================================================================
  insert into auth.users (email) values ('pwadmin@test.local') returning id into u_admin;
  insert into auth.users (email) values ('pwowner@test.local') returning id into u_owner;
  insert into auth.users (email) values ('pwother@test.local') returning id into u_other;

  perform auth.login_as(u_owner);
  select out_organization_id, out_branch_id into org_a, branch_a
    from public.provision_workspace('مطعم المواقع', 'pwalpha', 'restaurant');

  perform auth.login_as(u_other);
  select out_organization_id, out_branch_id into org_b, branch_b
    from public.provision_workspace('متجر المواقع', 'pwbeta', 'retail');

  -- Back to the superuser to seed the platform roster: granting platform admin
  -- is not something a tenant session may do, which is the point.
  perform auth.logout();
  perform set_config('role', 'postgres', true);
  insert into public.platform_admins (user_id, role) values (u_admin, 'owner');

  good := jsonb_build_object(
    'version', 1,
    'metadata', jsonb_build_object('name', 'موقع', 'locale', 'ar', 'direction', 'rtl'),
    'theme', jsonb_build_object(
      'colors', jsonb_build_object('primary', '#1E2FC8', 'secondary', '#6B8BFA',
                                   'accent', '#1E2FC8', 'background', '#FFFFFF',
                                   'text', '#111827'),
      'fonts', jsonb_build_object('heading', 'cairo', 'body', 'cairo'),
      'radius', 'medium', 'style', 'minimal'),
    'navigation', jsonb_build_array(jsonb_build_object('label', 'الرئيسية', 'target', '/')),
    'pages', jsonb_build_array(jsonb_build_object(
      'slug', '/', 'title', 'الرئيسية',
      'sections', jsonb_build_array(jsonb_build_object(
        'type', 'hero', 'props', jsonb_build_object('title', 'أهلًا'))))),
    'settings', jsonb_build_object('show_branding', true, 'analytics_enabled', false)
  );

  -- ==========================================================================
  -- 1. Platform Admin creates a website.
  -- ==========================================================================
  perform auth.login_as(u_admin);

  insert into public.platform_websites (organization_id, name, slug, site_type, draft_definition)
  values (org_a, 'موقع ألفا', 'pw-alpha', 'restaurant', good)
  returning id into w_id;

  if w_id is null then raise exception 'FAIL: admin could not create a website'; end if;
  raise notice 'OK 1: platform admin created a website';

  -- ==========================================================================
  -- 2. Authorship is set by the database, not by the caller.
  -- ==========================================================================
  select count(*) into n from public.platform_websites
   where id = w_id and created_by = u_admin and updated_by = u_admin;
  if n <> 1 then raise exception 'FAIL: created_by was not set from auth.uid()'; end if;

  -- A forged creator is ignored rather than rejected: the column is assigned,
  -- so there is nothing to reject.
  insert into public.platform_websites
    (organization_id, name, slug, site_type, draft_definition, created_by, updated_by)
  values (org_a, 'موقع مزوّر', 'pw-forged', 'restaurant', good, u_owner, u_owner);

  select count(*) into n from public.platform_websites
   where slug = 'pw-forged' and created_by = u_admin;
  if n <> 1 then raise exception 'FAIL: a forged created_by was stored'; end if;
  raise notice 'OK 2: authorship cannot be forged';

  -- ==========================================================================
  -- 3. A tenant owner is outside this entirely.
  -- ==========================================================================
  perform auth.login_as(u_owner);

  select count(*) into n from public.platform_websites;
  if n <> 0 then raise exception 'FAIL: a tenant owner can read platform websites'; end if;

  select count(*) into n from public.platform_website_versions;
  if n <> 0 then raise exception 'FAIL: a tenant owner can read published versions'; end if;

  ok := false;
  begin
    insert into public.platform_websites (organization_id, name, slug, site_type, draft_definition)
    values (org_a, 'موقع المستأجر', 'pw-tenant', 'restaurant', good);
  exception when others then ok := true; end;
  assert ok, 'FAIL: a tenant owner created a platform website';

  -- Even for their OWN organization, and even holding every tenant permission.
  update public.platform_websites set name = 'مُختطَف' where id = w_id;
  get diagnostics n = row_count;
  assert n = 0, 'FAIL: a tenant owner updated a platform website';

  ok := false;
  begin perform public.platform_website_publish(w_id, null);
  exception when others then ok := true; end;
  assert ok, 'FAIL: a tenant owner published a platform website';
  raise notice 'OK 3: tenant RBAC grants nothing here';

  -- ==========================================================================
  -- 4. What a definition may not contain.
  -- ==========================================================================
  perform auth.login_as(u_admin);

  -- Unknown section type.
  ok := false;
  begin
    update public.platform_websites
       set draft_definition = jsonb_set(good, '{pages,0,sections,0,type}', '"remote_code"')
     where id = w_id;
  exception when others then ok := true; end;
  assert ok, 'FAIL: an unknown section type was stored';

  -- Markup in text.
  ok := false;
  begin
    update public.platform_websites
       set draft_definition = jsonb_set(good, '{pages,0,sections,0,props,title}',
                                        '"<script>alert(1)</script>"')
     where id = w_id;
  exception when others then ok := true; end;
  assert ok, 'FAIL: markup was stored';

  -- A URL that is not https, at any depth.
  ok := false;
  begin
    update public.platform_websites
       set draft_definition = jsonb_set(good, '{pages,0,sections,0,props,image_url}',
                                        '"javascript:alert(1)"')
     where id = w_id;
  exception when others then ok := true; end;
  assert ok, 'FAIL: a javascript: URL was stored';

  -- A link leaving the site: an open redirect on every generated page.
  ok := false;
  begin
    update public.platform_websites
       set draft_definition = jsonb_set(good, '{navigation,0,target}', '"https://evil.example"')
     where id = w_id;
  exception when others then ok := true; end;
  assert ok, 'FAIL: an external navigation target was stored';

  -- A colour that is arbitrary CSS: the renderer puts this in a style attribute.
  ok := false;
  begin
    update public.platform_websites
       set draft_definition = jsonb_set(good, '{theme,colors,primary}',
                                        '"red; background: url(//evil)"')
     where id = w_id;
  exception when others then ok := true; end;
  assert ok, 'FAIL: arbitrary CSS was stored as a colour';

  -- An unrecognised version.
  ok := false;
  begin
    update public.platform_websites
       set draft_definition = jsonb_set(good, '{version}', '2')
     where id = w_id;
  exception when others then ok := true; end;
  assert ok, 'FAIL: an unsupported definition version was stored';
  raise notice 'OK 4: markup, bad URLs, unknown sections and CSS are all refused';

  -- ==========================================================================
  -- 5. The organization must be real, and a website cannot change hands.
  -- ==========================================================================
  -- The trigger refuses this (22023) before the foreign key is even consulted.
  ok := false;
  begin
    insert into public.platform_websites (organization_id, name, slug, site_type, draft_definition)
    values ('00000000-0000-0000-0000-000000000000', 'وهمي', 'pw-ghost', 'custom', good);
  exception when others then ok := true; end;
  assert ok, 'FAIL: a website was created for an organization that does not exist';

  ok := false;
  begin update public.platform_websites set organization_id = org_b where id = w_id;
  exception when others then ok := true; end;
  assert ok, 'FAIL: a website was moved to another organization';
  raise notice 'OK 5: the organization is verified and fixed';

  -- ==========================================================================
  -- 6. Draft and published are separate.
  -- ==========================================================================
  select out_version into v from public.platform_website_publish(w_id, 'أول نشر');
  if v <> 1 then raise exception 'FAIL: first publish was not version 1'; end if;

  select count(*) into n from public.platform_websites
   where id = w_id and status = 'published' and published_definition is not null
     and published_at is not null;
  if n <> 1 then raise exception 'FAIL: publish did not set the published state'; end if;

  -- Change the draft. What is live must not move.
  update public.platform_websites
     set draft_definition = jsonb_set(good, '{pages,0,sections,0,props,title}', '"عنوان جديد"')
   where id = w_id;

  select count(*) into n from public.platform_websites
   where id = w_id
     and published_definition -> 'pages' -> 0 -> 'sections' -> 0 -> 'props' ->> 'title' = 'أهلًا'
     and draft_definition     -> 'pages' -> 0 -> 'sections' -> 0 -> 'props' ->> 'title' = 'عنوان جديد';
  if n <> 1 then raise exception 'FAIL: editing the draft changed the published copy'; end if;
  raise notice 'OK 6: the draft is editable without touching what is live';

  -- ==========================================================================
  -- 7. Versions accumulate and are append-only.
  -- ==========================================================================
  select out_version into v from public.platform_website_publish(w_id, 'ثانٍ');
  if v <> 2 then raise exception 'FAIL: second publish was not version 2'; end if;

  select count(*) into n from public.platform_website_versions where website_id = w_id;
  if n <> 2 then raise exception 'FAIL: expected two versions, found %', n; end if;

  -- No insert, update or delete policy exists on the history, so none of the
  -- three can touch it however the caller reaches it.
  begin
    delete from public.platform_website_versions where website_id = w_id;
    get diagnostics n = row_count;
    assert n = 0, 'FAIL: published history was deleted';
  exception when insufficient_privilege then null; end;

  begin
    update public.platform_website_versions set definition = good where website_id = w_id;
    get diagnostics n = row_count;
    assert n = 0, 'FAIL: published history was rewritten';
  exception when insufficient_privilege then null; end;
  raise notice 'OK 7: published history is append-only';

  -- ==========================================================================
  -- 8. Publishing validates, and refuses an empty home page.
  -- ==========================================================================
  update public.platform_websites
     set draft_definition = jsonb_set(good, '{pages,0,sections}', '[]'::jsonb)
   where id = w_id;

  ok := false;
  begin perform public.platform_website_publish(w_id, null);
  exception when others then ok := true; end;
  assert ok, 'FAIL: a site with an empty home page was published';

  -- The refusal changed nothing: version 2 is still what is live.
  select count(*) into n from public.platform_website_versions where website_id = w_id;
  if n <> 2 then raise exception 'FAIL: a refused publish still wrote a version'; end if;
  raise notice 'OK 8: publishing validates before it promotes';

  -- ==========================================================================
  -- 9. Archiving keeps the history.
  -- ==========================================================================
  update public.platform_websites set status = 'archived' where id = w_id;

  select count(*) into n from public.platform_website_versions where website_id = w_id;
  if n <> 2 then raise exception 'FAIL: archiving destroyed published history'; end if;
  raise notice 'OK 9: archiving preserves what was published';

  -- ==========================================================================
  -- 10. Audit, through the existing system.
  -- ==========================================================================
  select count(*) into n from public.audit_logs
   where entity_type = 'platform_website' and entity_id = w_id::text
     and action = 'platform.website_created';
  if n <> 1 then raise exception 'FAIL: no creation audit line'; end if;

  select count(*) into n from public.audit_logs
   where entity_type = 'platform_website' and entity_id = w_id::text
     and action = 'platform.website_published';
  if n < 2 then raise exception 'FAIL: publishes were not audited (found %)', n; end if;

  select count(*) into n from public.audit_logs
   where entity_type = 'platform_website' and entity_id = w_id::text
     and action = 'platform.website_archived';
  if n <> 1 then raise exception 'FAIL: archiving was not audited'; end if;

  -- The actor is the admin, not whoever the row named.
  select count(*) into n from public.audit_logs
   where entity_type = 'platform_website' and actor_id <> u_admin;
  if n <> 0 then raise exception 'FAIL: an audit line named the wrong actor'; end if;
  raise notice 'OK 10: every change is audited against the real actor';

  -- ==========================================================================
  -- 11. anon has nothing at all.
  -- ==========================================================================
  perform auth.logout();
  perform set_config('role', 'anon', true);

  begin
    select count(*) into n from public.platform_websites;
    assert n = 0, 'FAIL: anon read platform websites';
  exception when insufficient_privilege then null; end;

  begin
    select count(*) into n from public.platform_website_versions;
    assert n = 0, 'FAIL: anon read published versions';
  exception when insufficient_privilege then null; end;

  ok := false;
  begin perform public.platform_website_business_profile(org_a);
  exception when others then ok := true; end;
  assert ok, 'FAIL: anon read a customer business profile';
  raise notice 'OK 11: anon has no access to the builder';

  perform set_config('role', 'postgres', true);
  raise notice '--- platform website builder suite passed ---';
end $$;
