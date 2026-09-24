-- =============================================================================
-- LOCAL BASIC — 0061 Site Engine, operated by Platform Admin
--
--   1  a non-admin (including a tenant owner with site.manage) is refused by
--      every platform_site_* function, before any row is touched
--   2  anon is refused everywhere
--   3  a Platform Admin can list, read, theme, publish, roll back and
--      unpublish ANY organization's site
--   4  a customer code that does not resolve, or does not own the site,
--      answers "not found" — indistinguishable from a made-up id
--   5  a theme update is draft only: it does not appear in the live revision
--      until a publish call says so
--   6  publish freezes the draft (including the new theme) into a revision
--      and makes it live, using the SAME site_revisions ledger and its
--      one-live-per-site invariant
--   7  rollback restores a previous revision exactly
--   8  every write lands one row in audit_logs, scoped to the SITE'S
--      organization, never a client-asserted one
--   9  Customer A's theme change does not touch Customer B's site or settings
--  10  ordinary tenant RLS on sites/site_settings/site_revisions is UNCHANGED:
--      a Platform Admin still cannot read those tables through plain
--      PostgREST access, only through these functions
-- =============================================================================

\set ON_ERROR_STOP on

do $$
declare
  u_admin uuid; u_owner_a uuid; u_owner_b uuid;
  org_a uuid; org_b uuid; code_a text; code_b text;
  site_a uuid; site_b uuid; home_a uuid;
  n int; ok boolean; v_state text;
  v_version int; v_revision uuid;
  row_settings jsonb; row_snapshot jsonb;
begin
  perform auth.as_admin();
  insert into auth.users (email) values ('pa-admin@test.local')   returning id into u_admin;
  insert into auth.users (email) values ('pa-owner-a@test.local') returning id into u_owner_a;
  insert into auth.users (email) values ('pa-owner-b@test.local') returning id into u_owner_b;
  insert into public.profiles (id) values (u_admin) on conflict (id) do nothing;
  insert into public.platform_admins (user_id, role) values (u_admin, 'owner');

  perform auth.login_as(u_owner_a);
  select out_organization_id into org_a
    from public.provision_workspace('PA Alpha', 'pa-alpha', 'restaurant');
  select public.site_provision(org_a, 'Alpha Site', 'alpha-site') into site_a;
  select id into home_a from public.site_pages where site_id = site_a and is_homepage;
  insert into public.site_sections (page_id, section_type, content, sort_order, is_visible)
       values (home_a, 'hero', '{"title":"قبل"}'::jsonb, 0, true);

  perform auth.login_as(u_owner_b);
  select out_organization_id into org_b
    from public.provision_workspace('PA Beta', 'pa-beta', 'restaurant');
  select public.site_provision(org_b, 'Beta Site', 'beta-site') into site_b;
  insert into public.site_sections (page_id, section_type, content, sort_order)
       values ((select id from public.site_pages where site_id = site_b), 'hero', '{}'::jsonb, 0);

  perform auth.as_admin();
  select customer_code into code_a from public.organizations where id = org_a;
  select customer_code into code_b from public.organizations where id = org_b;

  -- ==========================================================================
  -- 1. Non-admin refused everywhere, including a tenant owner who DOES hold
  --    site.manage on their own organization — the two authorization systems
  --    do not meet here either.
  -- ==========================================================================
  perform auth.login_as(u_owner_a);
  foreach v_state in array array[
    'list', 'detail', 'revisions', 'theme', 'publish', 'rollback', 'unpublish'
  ] loop
    ok := false;
    begin
      case v_state
        when 'list'      then perform * from public.platform_site_list(code_a);
        when 'detail'    then perform * from public.platform_site_detail(code_a, site_a);
        when 'revisions' then perform * from public.platform_site_revisions_list(code_a, site_a);
        when 'theme'     then perform public.platform_site_theme_update(code_a, site_a, '{}'::jsonb);
        when 'publish'   then perform public.platform_site_publish(code_a, site_a);
        when 'rollback'  then perform public.platform_site_rollback(code_a, site_a, gen_random_uuid());
        when 'unpublish' then perform public.platform_site_unpublish(code_a, site_a);
      end case;
    exception when insufficient_privilege then ok := true; end;
    assert ok, 'a tenant owner reached platform_site_' || v_state;
  end loop;
  raise notice 'OK 1  a tenant owner with site.manage cannot reach any platform_site_* function';

  -- ==========================================================================
  -- 2. anon refused.
  -- ==========================================================================
  perform auth.logout();
  ok := false;
  begin
    perform * from public.platform_site_list(code_a);
  exception when insufficient_privilege or others then ok := true; end;
  assert ok, 'anon reached platform_site_list';
  raise notice 'OK 2  anon is refused';

  -- ==========================================================================
  -- 3. Platform Admin operates freely across organizations.
  -- ==========================================================================
  perform auth.login_as(u_admin);

  select count(*) into n from public.platform_site_list(code_a);
  assert n = 1, 'platform_site_list(A) should see exactly one site, saw ' || n;

  select settings, snapshot into row_settings, row_snapshot
    from public.platform_site_detail(code_a, site_a);
  assert row_snapshot -> 'site' ->> 'slug' = 'alpha-site', 'wrong site read back';
  raise notice 'OK 3  a Platform Admin can list and read across organizations';

  -- ==========================================================================
  -- 4. "Not found" is indistinguishable across every failure mode.
  -- ==========================================================================
  select count(*) into n from public.platform_site_detail('NO-SUCH-CODE', site_a);
  assert n = 0, 'an unknown customer code returned a row';

  -- Beta's real site, addressed through Alpha's real code.
  select count(*) into n from public.platform_site_detail(code_a, site_b);
  assert n = 0, 'a site from another organization was reachable via a foreign code';

  ok := false;
  begin
    perform public.platform_site_theme_update(code_a, site_b, '{}'::jsonb);
  exception when others then
    if sqlstate = '22023' then ok := true; end if;
  end;
  assert ok, 'writing another organization''s site via a foreign code did not raise 22023';
  raise notice 'OK 4  a wrong code and a wrong site both answer "not found", never a partial read';

  -- ==========================================================================
  -- 5. Theme update is draft only.
  --
  -- Verification reads run as auth.as_admin() (the superuser bypass 33 uses
  -- for its own trigger checks), never as the Platform Admin session under
  -- test: that session cannot read these tables directly at all (proven in
  -- 10), so reading through it here would make these assertions pass whether
  -- the write happened or not — a test that cannot fail is not a test.
  -- ==========================================================================
  perform public.platform_site_theme_update(
    code_a, site_a,
    '{"locale":"ar","direction":"rtl","templateId":"business","theme":{"primary":"#ab00ab","background":"#ffffff","foreground":"#111827","border":"#e5e7eb"}}'::jsonb
  );
  perform auth.as_admin();
  select count(*) into n from public.site_revisions where site_id = site_a;
  assert n = 0, 'a theme update created a revision by itself';
  select settings ->> 'theme' into v_state from public.site_settings where site_id = site_a;
  assert v_state::jsonb ->> 'primary' = '#ab00ab', 'the draft theme was not written';
  raise notice 'OK 5  a theme update is draft only, and it is the SAME site_settings row updateAppearance() writes';

  -- ==========================================================================
  -- 6. Publish freezes the theme, live now.
  -- ==========================================================================
  perform auth.login_as(u_admin);
  select out_version, out_revision into v_version, v_revision
    from public.platform_site_publish(code_a, site_a, 'platform admin publish');
  assert v_version = 1, 'the first platform publish should be version 1';

  perform auth.as_admin();
  select count(*) into n from public.site_revisions where site_id = site_a and is_live;
  assert n = 1, 'exactly one live revision expected after a platform publish';

  select snapshot into row_snapshot from public.site_revisions where id = v_revision;
  assert row_snapshot -> 'settings' -> 'theme' ->> 'primary' = '#ab00ab',
    'the published revision did not capture the platform-admin theme change';
  select status into v_state from public.sites where id = site_a;
  assert v_state = 'published', 'sites.status did not track the platform publish';
  raise notice 'OK 6  publish freezes the theme into a live revision, via the SAME site_revisions ledger';

  -- ==========================================================================
  -- 7. Rollback.
  -- ==========================================================================
  perform auth.login_as(u_admin);
  perform public.platform_site_theme_update(
    code_a, site_a,
    '{"locale":"ar","direction":"rtl","templateId":"business","theme":{"primary":"#000000","background":"#ffffff","foreground":"#111827","border":"#e5e7eb"}}'::jsonb
  );
  perform public.platform_site_publish(code_a, site_a, 'second');

  perform auth.as_admin();
  select count(*) into n from public.site_revisions where site_id = site_a;
  assert n = 2, 'expected two revisions after a second platform publish';

  perform auth.login_as(u_admin);
  perform public.platform_site_rollback(code_a, site_a, v_revision);

  perform auth.as_admin();
  select count(*) into n from public.site_revisions where id = v_revision and is_live;
  assert n = 1, 'rollback did not restore the first revision';
  select snapshot -> 'settings' -> 'theme' ->> 'primary' into v_state
    from public.site_revisions where site_id = site_a and is_live;
  assert v_state = '#ab00ab', 'the rolled-back revision does not carry the original theme';
  raise notice 'OK 7  rollback restores exactly the requested revision';

  -- ==========================================================================
  -- 8. Every platform write is audited on the SITE'S organization.
  -- ==========================================================================
  select count(*) into n from public.audit_logs
   where organization_id = org_a and entity_type = 'site' and entity_id = site_a::text
     and action in (
       'site.theme_updated_by_platform_admin', 'site.published_by_platform_admin',
       'site.rolled_back_by_platform_admin'
     );
  assert n >= 4, 'expected at least 4 platform-admin audit rows on org A, found ' || n;
  select count(*) into n from public.audit_logs
   where entity_id = site_a::text and organization_id <> org_a;
  assert n = 0, 'a platform-admin site write was audited on the wrong organization';
  raise notice 'OK 8  every platform-admin write is on the customer''s own audit trail';

  -- ==========================================================================
  -- 9. Isolation: Beta is untouched by anything done to Alpha.
  -- ==========================================================================
  select count(*) into n from public.site_revisions where site_id = site_b;
  assert n = 0, 'Beta gained a revision from Alpha''s publishes';
  select settings into row_settings from public.site_settings where site_id = site_b;
  assert (row_settings -> 'theme' ->> 'primary') is distinct from '#ab00ab',
    'Beta''s settings were touched by Alpha''s theme update';
  raise notice 'OK 9  Customer B is untouched by every operation on Customer A';

  -- ==========================================================================
  -- 10. Ordinary tenant RLS is unchanged: a Platform Admin cannot read
  --     sites/site_settings/site_revisions through plain PostgREST access —
  --     only through the platform_site_* functions above.
  -- ==========================================================================
  perform auth.login_as(u_admin);
  select count(*) into n from public.sites where id = site_a;
  assert n = 0, 'a Platform Admin read public.sites directly — RLS was widened';
  select count(*) into n from public.site_settings where site_id = site_a;
  assert n = 0, 'a Platform Admin read public.site_settings directly — RLS was widened';
  select count(*) into n from public.site_revisions where site_id = site_a;
  assert n = 0, 'a Platform Admin read public.site_revisions directly — RLS was widened';
  raise notice 'OK 10 tenant RLS on sites/site_settings/site_revisions is untouched by this migration';

  raise notice 'SITE ENGINE PLATFORM ADMIN: all checks passed';
end $$;
