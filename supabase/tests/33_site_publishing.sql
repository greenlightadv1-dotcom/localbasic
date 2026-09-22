-- =============================================================================
-- LOCAL BASIC — 0060 Site Engine publishing
--
--   1  publishing freezes the draft as version 1 and makes it live
--   2  editing the draft afterwards does NOT change the published revision
--   3  a second publish makes version 2 live and demotes version 1
--   4  exactly one live revision, always
--   5  hidden sections are not published
--   6  a published revision is immutable; only is_live moves
--   7  nobody may insert, update or delete a revision directly
--   8  rollback makes a previous revision live again, unchanged
--   9  a revision id from another site is not found
--  10  unpublish clears live and leaves history intact
--  11  sites.status tracks whether a live revision exists
--  12  site.manage is required; site.read alone cannot publish
--  13  another organization cannot publish, roll back or read
--  14  anon is refused everywhere
--  15  a site with no visible section still publishes; one with no page cannot
-- =============================================================================

\set ON_ERROR_STOP on

do $$
declare
  u_owner uuid; u_reader uuid; u_other uuid;
  org uuid; br uuid; org_b uuid;
  m uuid; r uuid;
  site uuid; site_b uuid; home uuid; page2 uuid; sec1 uuid; sec2 uuid;
  v1 int; v2 int; rev1 uuid; rev2 uuid; rev_b uuid;
  snap1 jsonb; snap_after jsonb;
  ok boolean; n int; v_state text; v_status text;
begin
  perform auth.as_admin();
  insert into auth.users (email) values ('pub-owner@test.local')  returning id into u_owner;
  insert into auth.users (email) values ('pub-reader@test.local') returning id into u_reader;
  insert into auth.users (email) values ('pub-other@test.local')  returning id into u_other;

  perform auth.login_as(u_owner);
  select out_organization_id, out_branch_id into org, br
    from public.provision_workspace('Pub Alpha', 'pubalpha', 'restaurant');
  perform auth.login_as(u_other);
  select out_organization_id into org_b
    from public.provision_workspace('Pub Beta', 'pubbeta', 'restaurant');

  perform auth.as_admin();
  insert into public.organization_members (organization_id, user_id, status, all_branches)
       values (org, u_reader, 'active', true) returning id into m;
  insert into public.roles (organization_id, key, name_ar, name_en, description)
       values (org, 'pub_reader', 'قارئ', 'Reader', 'test') returning id into r;
  insert into public.role_permissions (role_id, permission_key) values (r, 'site.read');
  insert into public.user_roles (member_id, role_id) values (m, r);

  perform auth.login_as(u_owner);
  select public.site_provision(org, 'Alpha Site', 'alpha-site') into site;
  select id into home from public.site_pages where site_id = site and is_homepage;
  select public.site_page_create(site, 'من نحن', 'about') into page2;

  insert into public.site_sections (page_id, section_type, content, sort_order, is_visible)
       values (home, 'hero', '{"title":"النسخة الأولى"}'::jsonb, 0, true)
    returning id into sec1;
  insert into public.site_sections (page_id, section_type, content, sort_order, is_visible)
       values (home, 'about', '{"title":"مخفي"}'::jsonb, 1, false)
    returning id into sec2;

  perform auth.login_as(u_other);
  select public.site_provision(org_b, 'Beta Site', 'beta-site') into site_b;
  insert into public.site_sections (page_id, section_type, content, sort_order)
       values ((select id from public.site_pages where site_id = site_b), 'hero', '{}'::jsonb, 0);
  select out_version from public.site_publish(site_b) into n;
  select id into rev_b from public.site_revisions where site_id = site_b and is_live;
  perform auth.login_as(u_owner);

  -- ── 1. Publish ────────────────────────────────────────────────────────────
  select out_version, out_revision into v1, rev1 from public.site_publish(site, 'أول نشر');
  assert v1 = 1, 'the first publish should be version 1, got ' || v1;

  select count(*) into n from public.site_revisions where site_id = site;
  assert n = 1, 'expected one revision, found ' || n;
  select count(*) into n from public.site_revisions where site_id = site and is_live;
  assert n = 1, 'the first revision should be live';

  select snapshot into snap1 from public.site_revisions where id = rev1;
  assert snap1 -> 'site' ->> 'slug' = 'alpha-site', 'the snapshot lost the site slug';
  assert jsonb_array_length(snap1 -> 'pages') = 2, 'the snapshot should hold both pages';
  raise notice 'OK 1  publishing freezes the draft as version 1 and makes it live';

  -- ── 5. Hidden sections are not published ──────────────────────────────────
  assert jsonb_array_length(snap1 -> 'pages' -> 0 -> 'sections') = 1,
    'a hidden section was published';
  assert snap1 -> 'pages' -> 0 -> 'sections' -> 0 -> 'content' ->> 'title' = 'النسخة الأولى',
    'the wrong section was published';
  raise notice 'OK 5  hidden sections are not published';

  -- ── 2. The draft moves on; the revision does not ──────────────────────────
  update public.site_sections set content = '{"title":"مسودة جديدة"}'::jsonb where id = sec1;
  update public.site_pages set title = 'الرئيسية (معدّلة)' where id = home;

  select snapshot into snap_after from public.site_revisions where id = rev1;
  assert snap_after = snap1, 'editing the draft changed the published revision';
  assert snap_after -> 'pages' -> 0 -> 'sections' -> 0 -> 'content' ->> 'title' = 'النسخة الأولى',
    'the published section followed the draft';
  raise notice 'OK 2  editing the draft leaves the published revision untouched';

  -- ── 3 + 4. A second publish ───────────────────────────────────────────────
  select out_version, out_revision into v2, rev2 from public.site_publish(site);
  assert v2 = 2, 'the second publish should be version 2, got ' || v2;

  select count(*) into n from public.site_revisions where site_id = site and is_live;
  assert n = 1, 'a site has ' || n || ' live revisions';
  select count(*) into n from public.site_revisions where id = rev2 and is_live;
  assert n = 1, 'the newest revision is not live';
  select count(*) into n from public.site_revisions where id = rev1 and is_live;
  assert n = 0, 'the old revision is still live';

  select snapshot -> 'pages' -> 0 -> 'sections' -> 0 -> 'content' ->> 'title' into v_state
    from public.site_revisions where id = rev2;
  assert v_state = 'مسودة جديدة', 'version 2 did not capture the new draft';
  raise notice 'OK 3/4 a second publish supersedes the first; exactly one stays live';

  -- ── 6. Immutability ───────────────────────────────────────────────────────
  -- Attempted as admin, bypassing the missing grants, so the TRIGGER is what
  -- is being tested rather than the privilege.
  perform auth.as_admin();
  foreach v_state in array array['snapshot', 'version', 'published_at', 'note', 'site_id'] loop
    ok := false;
    begin
      case v_state
        when 'snapshot'     then update public.site_revisions set snapshot = '{"pages":[]}'::jsonb where id = rev1;
        when 'version'      then update public.site_revisions set version = 99 where id = rev1;
        -- now() is the TRANSACTION's timestamp and this whole block is one
        -- transaction, so it equals the value the insert wrote and would be a
        -- genuine no-op rather than a refused change.
        when 'published_at' then update public.site_revisions set published_at = now() - interval '1 day' where id = rev1;
        when 'note'         then update public.site_revisions set note = 'rewritten' where id = rev1;
        when 'site_id'      then update public.site_revisions set site_id = site_b where id = rev1;
      end case;
    exception when others then ok := true; end;
    assert ok, 'a published revision was rewritten: ' || v_state;
  end loop;

  select snapshot into snap_after from public.site_revisions where id = rev1;
  assert snap_after = snap1, 'the revision changed despite the refusals';

  -- is_live is the one field that moves.
  update public.site_revisions set is_live = false where id = rev2;
  update public.site_revisions set is_live = true where id = rev2;
  raise notice 'OK 6  a published revision is immutable; only is_live moves';

  -- ── 7. No direct writes ───────────────────────────────────────────────────
  perform auth.login_as(u_owner);
  foreach v_state in array array['insert', 'update', 'delete'] loop
    ok := false;
    begin
      case v_state
        when 'insert' then
          insert into public.site_revisions (site_id, organization_id, version, snapshot)
               values (site, org, 99, '{"pages":[{"slug":"x","isHomepage":true,"sections":[]}]}'::jsonb);
        when 'update' then update public.site_revisions set is_live = false where id = rev2;
        when 'delete' then delete from public.site_revisions where id = rev1;
      end case;
      -- RLS filters rather than raising for update and delete, so a zero row
      -- count is the refusal.
      get diagnostics n = row_count;
      if v_state <> 'insert' and n = 0 then ok := true; end if;
    exception when others then ok := true; end;
    assert ok, 'a member wrote site_revisions directly: ' || v_state;
  end loop;

  select count(*) into n from public.site_revisions where site_id = site;
  assert n = 2, 'the direct writes changed the ledger';
  raise notice 'OK 7  no member may insert, update or delete a revision directly';

  -- ── 8. Rollback ───────────────────────────────────────────────────────────
  select public.site_rollback(site, rev1) into n;
  assert n = 1, 'rollback should report version 1, got ' || n;

  select count(*) into n from public.site_revisions where site_id = site and is_live;
  assert n = 1, 'rollback left ' || n || ' live revisions';
  select count(*) into n from public.site_revisions where id = rev1 and is_live;
  assert n = 1, 'rollback did not make version 1 live';

  select snapshot into snap_after from public.site_revisions where id = rev1;
  assert snap_after = snap1, 'rollback altered the revision it restored';

  select count(*) into n from public.site_revisions where site_id = site;
  assert n = 2, 'rollback created or destroyed a revision';
  raise notice 'OK 8  rollback makes a previous revision live again, unchanged';

  -- ── 9. A revision from another site ───────────────────────────────────────
  v_state := null;
  begin perform public.site_rollback(site, rev_b);
  exception when others then v_state := sqlstate; end;
  assert v_state = '22023', 'rolled back to another site''s revision (' || coalesce(v_state,'none') || ')';

  v_state := null;
  begin perform public.site_rollback(site, gen_random_uuid());
  exception when others then v_state := sqlstate; end;
  assert v_state = '22023', 'rolled back to a revision that does not exist';

  select count(*) into n from public.site_revisions where id = rev1 and is_live;
  assert n = 1, 'a refused rollback changed what is live';
  raise notice 'OK 9  a revision id from another site is not found';

  -- ── 10 + 11. Unpublish and status ─────────────────────────────────────────
  select status into v_status from public.sites where id = site;
  assert v_status = 'published', 'status should be published while a revision is live';

  perform public.site_unpublish(site);
  select count(*) into n from public.site_revisions where site_id = site and is_live;
  assert n = 0, 'unpublish left a live revision';
  select count(*) into n from public.site_revisions where site_id = site;
  assert n = 2, 'unpublish destroyed history';
  select status into v_status from public.sites where id = site;
  assert v_status = 'draft', 'status should return to draft after unpublish';

  -- And history is still usable: rolling forward again needs no republish.
  perform public.site_rollback(site, rev2);
  select count(*) into n from public.site_revisions where id = rev2 and is_live;
  assert n = 1, 'could not restore a revision after unpublishing';
  select status into v_status from public.sites where id = site;
  assert v_status = 'published', 'status did not follow the restore';
  raise notice 'OK 10/11 unpublish clears live, keeps history, and status follows';

  -- ── 12. site.read alone ───────────────────────────────────────────────────
  perform auth.login_as(u_reader);
  -- Reading the history is allowed.
  select count(*) into n from public.site_revisions where site_id = site;
  assert n = 2, 'site.read cannot read the revisions it should (' || n || ')';

  foreach v_state in array array['publish', 'rollback', 'unpublish'] loop
    ok := false;
    begin
      case v_state
        when 'publish'   then perform public.site_publish(site);
        when 'rollback'  then perform public.site_rollback(site, rev1);
        when 'unpublish' then perform public.site_unpublish(site);
      end case;
    exception when others then ok := true; end;
    assert ok, 'site.read alone performed: ' || v_state;
  end loop;

  select count(*) into n from public.site_revisions where site_id = site;
  assert n = 2, 'a reader changed the ledger';
  select count(*) into n from public.site_revisions where id = rev2 and is_live;
  assert n = 1, 'a reader changed what is live';
  raise notice 'OK 12 site.read reads history and cannot publish, roll back or unpublish';

  -- ── 13. Another organization ──────────────────────────────────────────────
  perform auth.login_as(u_other);
  select count(*) into n from public.site_revisions where site_id = site;
  assert n = 0, 'another organization can read these revisions';

  foreach v_state in array array['publish', 'rollback', 'unpublish'] loop
    ok := false;
    begin
      case v_state
        when 'publish'   then perform public.site_publish(site);
        when 'rollback'  then perform public.site_rollback(site, rev1);
        when 'unpublish' then perform public.site_unpublish(site);
      end case;
    exception when others then ok := true; end;
    assert ok, 'another organization performed: ' || v_state;
  end loop;
  raise notice 'OK 13 another organization cannot read or publish this site';

  -- ── 14. Anon ──────────────────────────────────────────────────────────────
  perform auth.logout();
  v_state := null;
  begin select count(*) into n from public.site_revisions;
  exception when others then v_state := sqlstate; end;
  assert v_state = '42501', 'anon could read site_revisions (' || coalesce(v_state,'none') || ')';

  ok := false;
  begin perform public.site_publish(site);
  exception when others then ok := true; end;
  assert ok, 'anon published a site';
  raise notice 'OK 14 anon reads nothing and publishes nothing';

  -- ── 15. What cannot be published ──────────────────────────────────────────
  perform auth.login_as(u_owner);
  -- A page with every section hidden still publishes: an empty page is valid,
  -- and the snapshot only requires that a page exists.
  update public.site_sections set is_visible = false where page_id = home;
  select out_version into n from public.site_publish(site);
  assert n = 3, 'a site whose sections are all hidden should still publish';

  -- A site with no pages cannot. Reached by deleting them as admin, since
  -- site_page_delete() refuses the last one.
  perform auth.as_admin();
  delete from public.site_pages where site_id = site;
  perform auth.login_as(u_owner);
  v_state := null;
  begin perform public.site_publish(site);
  exception when others then v_state := sqlstate; end;
  assert v_state = '22023', 'a site with no pages was published (' || coalesce(v_state,'none') || ')';
  raise notice 'OK 15 an empty page publishes; a site with no page does not';

  raise notice '';
  raise notice 'SITE PUBLISHING: all assertions passed';
end $$;
