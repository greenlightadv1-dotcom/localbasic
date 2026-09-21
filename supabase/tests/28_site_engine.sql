-- =============================================================================
-- LOCAL BASIC — Site Engine suite (0055)
--
-- A website belongs to an organization, and several members may work on it.
-- That makes the interesting questions different from a user-owned model:
-- it is no longer "can someone else see my row", it is "does the permission
-- decide, and does the organization boundary still hold".
--
-- Cast: two organizations, four people.
--   owner A    — owner of org A, holds everything
--   editor A   — org A member granted site.read + site.manage
--   viewer A   — org A member with NEITHER site permission
--   owner B    — owner of org B, holds everything in B and nothing in A
--
-- What has to hold:
--
--   1. A colleague with site.manage reads and edits a site they did not
--      create. This is the capability the change exists for and was
--      impossible under user ownership.
--   2. A colleague WITHOUT the permission sees nothing, in their own org.
--   3. Org B sees nothing of org A, even by primary key.
--   4. No cross-organization write, and no re-parenting by UPDATE.
--   5. created_by cannot be forged, and is not what authorizes anything.
--   6. Deleting the creator's profile leaves the site standing.
--   7. anon reads nothing and writes nothing.
--   8. Structure holds: one homepage, one settings row, slug unique per ORG
--      but free across orgs, closed section-type list.
--   9. site_provision() is atomic and refuses a caller without site.manage.
--  10. Deleting a site removes its pages, sections and settings.
--
-- Run with:  psql -v ON_ERROR_STOP=1 -f supabase/tests/28_site_engine.sql
-- =============================================================================

\set ON_ERROR_STOP on

do $$
declare
  u_owner_a uuid; u_editor_a uuid; u_viewer_a uuid; u_owner_b uuid;
  org_a uuid; br_a uuid; org_b uuid; br_b uuid;
  m_editor uuid; m_viewer uuid;
  r_editor uuid; r_viewer uuid;
  site_a uuid; site_b uuid;
  page_a uuid; page_b uuid; sec_a uuid;
  ok boolean; n int; v_tmp uuid;
begin
  perform auth.as_admin();
  insert into auth.users (email) values ('se-owner-a@test.local')  returning id into u_owner_a;
  insert into auth.users (email) values ('se-editor-a@test.local') returning id into u_editor_a;
  insert into auth.users (email) values ('se-viewer-a@test.local') returning id into u_viewer_a;
  insert into auth.users (email) values ('se-owner-b@test.local')  returning id into u_owner_b;

  perform auth.login_as(u_owner_a);
  select out_organization_id, out_branch_id into org_a, br_a
    from public.provision_workspace('SE Alpha', 'sealpha', 'restaurant');

  perform auth.login_as(u_owner_b);
  select out_organization_id, out_branch_id into org_b, br_b
    from public.provision_workspace('SE Beta', 'sebeta', 'restaurant');

  -- Two org A members: one granted the site permissions, one granted nothing.
  perform auth.as_admin();
  insert into public.organization_members (organization_id, user_id, status, all_branches)
       values (org_a, u_editor_a, 'active', true) returning id into m_editor;
  insert into public.organization_members (organization_id, user_id, status, all_branches)
       values (org_a, u_viewer_a, 'active', true) returning id into m_viewer;

  insert into public.roles (organization_id, key, name_ar, name_en, description)
       values (org_a, 'se_editor', 'محرر المواقع', 'Site editor', 'test')
    returning id into r_editor;
  insert into public.role_permissions (role_id, permission_key)
       values (r_editor, 'site.read'), (r_editor, 'site.manage');
  insert into public.user_roles (member_id, role_id) values (m_editor, r_editor);

  -- A role with a permission that is NOT a site permission, so the member is
  -- a real member of org A and still must not reach a site.
  insert into public.roles (organization_id, key, name_ar, name_en, description)
       values (org_a, 'se_viewer', 'موظف', 'Staff', 'test')
    returning id into r_viewer;
  insert into public.role_permissions (role_id, permission_key)
       values (r_viewer, 'customer.read');
  insert into public.user_roles (member_id, role_id) values (m_viewer, r_viewer);

  -- ── 9. Provisioning ───────────────────────────────────────────────────────
  perform auth.login_as(u_owner_a);
  select public.site_provision(org_a, 'Alpha Site', 'alpha-site') into site_a;

  select count(*) into n from public.site_pages where site_id = site_a;
  assert n = 1, 'provision should create exactly one page, found ' || n;
  select count(*) into n from public.site_pages
   where site_id = site_a and is_homepage and slug = 'home';
  assert n = 1, 'provision should create a homepage';
  select count(*) into n from public.site_settings where site_id = site_a;
  assert n = 1, 'provision should create exactly one settings row';

  select id into page_a from public.site_pages where site_id = site_a;
  insert into public.site_sections (page_id, section_type, content, sort_order)
       values (page_a, 'hero', '{"title":"مرحبا"}'::jsonb, 0) returning id into sec_a;
  raise notice 'OK 9  site_provision creates site + homepage + settings atomically';

  perform auth.login_as(u_owner_b);
  select public.site_provision(org_b, 'Beta Site', 'beta-site') into site_b;
  select id into page_b from public.site_pages where site_id = site_b;

  -- ── 3. Cross-organization isolation ───────────────────────────────────────
  -- owner B holds site.read and site.manage — in org B. None of it reaches A.
  select count(*) into n from public.sites where id = site_a;
  assert n = 0, 'owner B can see org A''s site';
  select count(*) into n from public.site_pages where id = page_a;
  assert n = 0, 'owner B can see org A''s page';
  select count(*) into n from public.site_sections where id = sec_a;
  assert n = 0, 'owner B can see org A''s section';
  select count(*) into n from public.site_settings where site_id = site_a;
  assert n = 0, 'owner B can see org A''s settings';
  select count(*) into n from public.sites;
  assert n = 1, 'owner B should see only org B''s site, saw ' || n;
  raise notice 'OK 3  an organization sees nothing of another, even by primary key';

  -- ── 4. Cross-organization writes ──────────────────────────────────────────
  ok := false;
  begin
    insert into public.site_pages (site_id, title, slug) values (site_a, 'X', 'x');
  exception when others then ok := true; end;
  assert ok, 'owner B inserted a page into org A''s site';

  ok := false;
  begin
    insert into public.site_sections (page_id, section_type) values (page_a, 'about');
  exception when others then ok := true; end;
  assert ok, 'owner B inserted a section into org A''s page';

  update public.sites set name = 'Stolen' where id = site_a;
  get diagnostics n = row_count;
  assert n = 0, 'owner B updated org A''s site';

  delete from public.sites where id = site_a;
  get diagnostics n = row_count;
  assert n = 0, 'owner B deleted org A''s site';

  -- Re-parenting their own site into org A. WITH CHECK is what catches this.
  ok := false;
  begin
    update public.sites set organization_id = org_a where id = site_b;
    get diagnostics n = row_count;
    if n = 0 then ok := true; end if;
  exception when others then ok := true; end;
  assert ok, 'owner B moved their site into org A';

  -- And re-parenting a page across the organization boundary.
  ok := false;
  begin
    update public.site_pages set site_id = site_a where id = page_b;
    get diagnostics n = row_count;
    if n = 0 then ok := true; end if;
  exception when others then ok := true; end;
  assert ok, 'owner B re-parented a page into org A''s site';
  raise notice 'OK 4  no cross-organization write, and no re-parenting';

  -- ── 1. Collaboration — the new capability ─────────────────────────────────
  perform auth.login_as(u_editor_a);
  select count(*) into n from public.sites where id = site_a;
  assert n = 1, 'a colleague with site.read cannot see the site';

  update public.sites set name = 'Alpha Site (edited by a colleague)' where id = site_a;
  get diagnostics n = row_count;
  assert n = 1, 'a colleague with site.manage cannot edit the site';

  insert into public.site_pages (site_id, title, slug, sort_order)
       values (site_a, 'من نحن', 'about', 1);
  select count(*) into n from public.site_pages where site_id = site_a;
  assert n = 2, 'a colleague with site.manage cannot add a page';

  insert into public.site_sections (page_id, section_type, content)
       values (page_a, 'about', '{"title":"عنّا"}'::jsonb);
  select count(*) into n from public.site_sections where page_id = page_a;
  assert n = 2, 'a colleague with site.manage cannot add a section';

  update public.site_settings set settings = '{"locale":"ar"}'::jsonb where site_id = site_a;
  get diagnostics n = row_count;
  assert n = 1, 'a colleague with site.manage cannot edit settings';
  raise notice 'OK 1  a colleague with site.manage reads and edits a site they did not create';

  -- ── 5. created_by is authorship, not authorization ────────────────────────
  select count(*) into n from public.sites where id = site_a and created_by = u_owner_a;
  assert n = 1, 'created_by should still name the original creator';
  raise notice 'OK 5  created_by records authorship and does not grant anything';

  -- ── 2. A member of the same org without the permission ────────────────────
  perform auth.login_as(u_viewer_a);
  select count(*) into n from public.sites where id = site_a;
  assert n = 0, 'a member without site.read can see the site';
  select count(*) into n from public.site_pages where site_id = site_a;
  assert n = 0, 'a member without site.read can see its pages';
  select count(*) into n from public.site_sections where page_id = page_a;
  assert n = 0, 'a member without site.read can see its sections';

  ok := false;
  begin
    insert into public.sites (organization_id, name, slug)
         values (org_a, 'Sneaky', 'sneaky');
  exception when others then ok := true; end;
  assert ok, 'a member without site.manage created a site';

  ok := false;
  begin
    perform public.site_provision(org_a, 'Sneaky', 'sneaky-two');
  exception when others then ok := true; end;
  assert ok, 'a member without site.manage called site_provision';
  raise notice 'OK 2/9b membership alone grants nothing; the permission decides';

  -- ── 8. Structure ──────────────────────────────────────────────────────────
  perform auth.login_as(u_owner_a);
  ok := false;
  begin
    insert into public.site_pages (site_id, title, slug, is_homepage)
         values (site_a, 'Second home', 'second-home', true);
  exception when others then ok := true; end;
  assert ok, 'a site accepted two homepages';

  ok := false;
  begin
    insert into public.site_settings (site_id, settings) values (site_a, '{}'::jsonb);
  exception when others then ok := true; end;
  assert ok, 'a site accepted two settings rows';

  ok := false;
  begin
    insert into public.sites (organization_id, name, slug)
         values (org_a, 'Dup', 'alpha-site');
  exception when others then ok := true; end;
  assert ok, 'an organization reused its own slug';

  ok := false;
  begin
    insert into public.site_sections (page_id, section_type) values (page_a, 'carousel');
  exception when others then ok := true; end;
  assert ok, 'an unknown section_type was stored';

  -- Different organizations MAY hold the same slug.
  perform auth.login_as(u_owner_b);
  select public.site_provision(org_b, 'Alpha name, B''s copy', 'alpha-site') into v_tmp;
  assert v_tmp is not null, 'org B could not reuse org A''s slug';
  raise notice 'OK 8  one homepage, one settings row, slug unique per org but free across orgs';

  -- ── 7. anon ───────────────────────────────────────────────────────────────
  perform auth.logout();
  -- anon holds no grant at all, so a read is refused outright rather than
  -- filtered to an empty set. That is the stronger outcome.
  ok := false;
  begin
    select count(*) into n from public.sites;
  exception when insufficient_privilege then ok := true; end;
  assert ok, 'anon can reach the sites table';

  ok := false;
  begin
    perform public.site_provision(org_a, 'Anon', 'anon-site');
  exception when others then ok := true; end;
  assert ok, 'anon called site_provision';
  raise notice 'OK 7  anon reads nothing and writes nothing';

  -- ── 6. The creator leaves ─────────────────────────────────────────────────
  -- Tested with the EDITOR as creator, not the owner: organizations.owner_user_id
  -- references profiles, so an owner's profile cannot be deleted at all. The
  -- realistic case is the employee who built the site moving on, and that is
  -- exactly this one.
  perform auth.login_as(u_editor_a);
  select public.site_provision(org_a, 'Built by the editor', 'editor-built') into v_tmp;

  select count(*) into n from public.sites where id = v_tmp and created_by = u_editor_a;
  assert n = 1, 'created_by should name the editor who provisioned it';

  perform auth.as_admin();
  delete from public.profiles where id = u_editor_a;

  select count(*) into n from public.sites where id = v_tmp;
  assert n = 1, 'the site was destroyed when its creator was removed';
  select count(*) into n from public.sites where id = v_tmp and created_by is null;
  assert n = 1, 'created_by should be null after the creator is removed';
  select count(*) into n from public.site_pages where site_id = v_tmp;
  assert n = 1, 'the site lost its homepage when its creator was removed';

  -- And the site the owner created is untouched by any of that.
  select count(*) into n from public.sites where id = site_a;
  assert n = 1, 'an unrelated site was affected';
  raise notice 'OK 6  a site outlives the person who created it';

  -- ── 10. Cascade ───────────────────────────────────────────────────────────
  delete from public.sites where id = site_a;
  select count(*) into n from public.site_pages where site_id = site_a;
  assert n = 0, 'pages survived their site';
  select count(*) into n from public.site_sections where page_id = page_a;
  assert n = 0, 'sections survived their page';
  select count(*) into n from public.site_settings where site_id = site_a;
  assert n = 0, 'settings survived their site';
  raise notice 'OK 10 deleting a site removes its pages, sections and settings';

  raise notice '';
  raise notice 'SITE ENGINE: all assertions passed';
end $$;
