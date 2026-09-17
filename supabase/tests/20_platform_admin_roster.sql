-- =============================================================================
-- LOCAL BASIC — Platform Admin roster suite (migration 0048)
--
-- /admin/customers rendered the 404 page because `platform_admins` was empty
-- and nothing in the product could ever fill it. The claims to prove are about
-- the path that now exists, and about the ways it must not be abused:
--
--   1. The gate itself is unchanged: a non-admin is refused everywhere.
--   2. Only an OWNER may change the roster. Staff may read it and nothing more.
--   3. A tenant user — including an organization owner — is neither, and
--      cannot promote themselves.
--   4. Granting promotes an EXISTING account. It never mints an identity.
--   5. Re-granting a revoked admin brings them back rather than failing.
--   6. The last owner cannot be removed, and nobody can revoke themselves —
--      because an empty roster is exactly the unreachable state being fixed.
--   7. Every change is on the platform audit trail.
--
-- Run with:  psql -v ON_ERROR_STOP=1 -f supabase/tests/20_platform_admin_roster.sql
-- =============================================================================

\set ON_ERROR_STOP on

do $$
declare
  u_owner  uuid;  u_owner2 uuid;  u_staff uuid;  u_tenant uuid;  u_nobody uuid;
  org_t    uuid;
  n        int;
  ok       boolean;
  r        record;
begin
  -- ==========================================================================
  -- Fixture: a platform owner, a staff admin, a tenant, and a bystander.
  -- ==========================================================================
  insert into auth.users (email) values ('roster-owner@test.local')  returning id into u_owner;
  insert into auth.users (email) values ('roster-owner2@test.local') returning id into u_owner2;
  insert into auth.users (email) values ('roster-staff@test.local')  returning id into u_staff;
  insert into auth.users (email) values ('roster-tenant@test.local') returning id into u_tenant;
  insert into auth.users (email) values ('roster-nobody@test.local') returning id into u_nobody;

  insert into public.profiles (id) values (u_owner), (u_owner2), (u_staff), (u_nobody)
    on conflict (id) do nothing;

  -- The first admin, installed the way a real deployment installs it: with a
  -- privileged connection, out of band. That is still the only way in.
  insert into public.platform_admins (user_id, role) values (u_owner, 'owner');

  perform auth.login_as(u_tenant);
  select out_organization_id into org_t
    from public.provision_workspace('مطعم المستأجر', 'rosterten', 'restaurant');

  -- ==========================================================================
  -- 1. The gate is unchanged
  -- ==========================================================================
  perform auth.login_as(u_tenant);
  ok := false;
  begin perform public.platform_admin_list();
  exception when others then ok := true; end;
  assert ok, 'FAIL: a tenant user read the platform roster';

  perform auth.logout();
  ok := false;
  begin perform public.platform_admin_list();
  exception when others then ok := true; end;
  assert ok, 'FAIL: an anonymous caller read the platform roster';

  raise notice 'ROSTER: the platform gate still refuses everyone else';

  -- ==========================================================================
  -- 2. An owner may grant; the promoted account is real and pre-existing
  -- ==========================================================================
  perform auth.login_as(u_owner);
  -- Scoped to this suite's users: earlier suites in the same database leave
  -- their own admins on the roster.
  select count(*) into n from public.platform_admin_list()
   where out_user_id in (u_owner, u_owner2, u_staff);
  assert n = 1, format('FAIL: the roster shows %s of our rows, expected 1', n);

  perform public.platform_admin_grant('roster-staff@test.local', 'staff');

  select count(*) into n from public.platform_admin_list()
   where out_user_id in (u_owner, u_owner2, u_staff);
  assert n = 2, format('FAIL: the roster shows %s of our rows after granting, expected 2', n);

  select out_role, out_is_active into r
    from public.platform_admin_list() where out_user_id = u_staff;
  assert r.out_role = 'staff', format('FAIL: the granted role is %s', r.out_role);
  assert r.out_is_active, 'FAIL: the granted admin is not active';

  -- An email nobody holds is refused: this promotes, it does not create.
  ok := false;
  begin perform public.platform_admin_grant('ghost@test.local', 'staff');
  exception when others then ok := true; end;
  assert ok, 'FAIL: an account was conjured for an unknown email';

  select count(*) into n from auth.users where email = 'ghost@test.local';
  assert n = 0, 'FAIL: a refused grant still created an identity';

  raise notice 'ROSTER: an owner promotes an existing account, and only that';

  -- ==========================================================================
  -- 3. Staff may read and may NOT change
  -- ==========================================================================
  perform auth.login_as(u_staff);
  select count(*) into n from public.platform_admin_list()
   where out_user_id in (u_owner, u_owner2, u_staff);
  assert n = 2, 'FAIL: a staff admin could not read the roster';

  ok := false;
  begin perform public.platform_admin_grant('roster-nobody@test.local', 'staff');
  exception when others then ok := true; end;
  assert ok, 'FAIL: a staff admin granted platform access';

  ok := false;
  begin perform public.platform_admin_revoke(u_owner);
  exception when others then ok := true; end;
  assert ok, 'FAIL: a staff admin revoked the owner';

  -- Nor can staff promote themselves.
  ok := false;
  begin perform public.platform_admin_grant('roster-staff@test.local', 'owner');
  exception when others then ok := true; end;
  assert ok, 'FAIL: a staff admin promoted themselves to owner';

  select out_role into r from public.platform_admin_list() where out_user_id = u_staff;
  assert r.out_role = 'staff', format('FAIL: staff is now %s', r.out_role);

  raise notice 'ROSTER: staff read the roster and cannot change it';

  -- ==========================================================================
  -- 4. A tenant user cannot promote themselves, by any route
  -- ==========================================================================
  perform auth.login_as(u_tenant);
  for n in 1..2 loop
    ok := false;
    begin
      if n = 1 then
        perform public.platform_admin_grant('roster-tenant@test.local', 'owner');
      else
        perform public.platform_admin_revoke(u_owner);
      end if;
    exception when others then ok := true; end;
    assert ok, 'FAIL: a tenant user changed the platform roster';
  end loop;

  -- And the table itself has no write policy to fall back on.
  ok := false;
  begin
    insert into public.platform_admins (user_id, role) values (u_tenant, 'owner');
  exception when others then ok := true; end;
  assert ok, 'FAIL: a tenant user inserted themselves into platform_admins';

  raise notice 'ROSTER: a tenant user cannot reach the roster at all';

  -- ==========================================================================
  -- 5. Revoking, and the two refusals that keep the console reachable
  -- ==========================================================================
  perform auth.login_as(u_owner);

  ok := false;
  begin perform public.platform_admin_revoke(u_owner);
  exception when others then ok := true; end;
  assert ok, 'FAIL: an owner revoked themselves';

  ok := false;
  begin perform public.platform_admin_revoke(u_nobody);
  exception when others then ok := true; end;
  assert ok, 'FAIL: revoking a non-admin succeeded';

  perform public.platform_admin_revoke(u_staff);
  select out_is_active into ok from public.platform_admin_list() where out_user_id = u_staff;
  assert not ok, 'FAIL: the revoked admin is still active';

  -- Deactivated, not deleted, so the audit trail still resolves them.
  select count(*) into n from public.platform_admins where user_id = u_staff;
  assert n = 1, 'FAIL: revoking deleted the row instead of deactivating it';

  -- And they are refused immediately.
  perform auth.login_as(u_staff);
  ok := false;
  begin perform public.platform_admin_list();
  exception when others then ok := true; end;
  assert ok, 'FAIL: a revoked admin still reads the roster';

  -- Re-granting brings them back.
  perform auth.login_as(u_owner);
  perform public.platform_admin_grant('roster-staff@test.local', 'staff');
  select out_is_active into ok from public.platform_admin_list() where out_user_id = u_staff;
  assert ok, 'FAIL: re-granting did not reactivate the admin';

  raise notice 'ROSTER: revoking deactivates, and re-granting restores';

  -- ==========================================================================
  -- 6. The last owner cannot be removed
  -- ==========================================================================
  perform public.platform_admin_grant('roster-owner2@test.local', 'owner');

  -- With two owners, one may go.
  perform public.platform_admin_revoke(u_owner2);
  select count(*) into n from public.platform_admins
   where role = 'owner' and is_active and user_id in (u_owner, u_owner2);
  assert n = 1, format('FAIL: %s of our owners active after revoking one', n);

  -- With one left, nobody can remove them — not even another owner promoting
  -- themselves first, because there is no other owner to do it.
  perform public.platform_admin_grant('roster-owner2@test.local', 'owner');
  perform auth.login_as(u_owner2);
  perform public.platform_admin_revoke(u_owner);

  ok := false;
  begin perform public.platform_admin_revoke(u_owner2);
  exception when others then ok := true; end;
  assert ok, 'FAIL: an owner revoked themselves as the last one';

  perform auth.as_admin();
  select count(*) into n from public.platform_admins
   where role = 'owner' and is_active and user_id in (u_owner, u_owner2);
  assert n >= 1, 'FAIL: our owners were emptied from the roster';

  raise notice 'ROSTER: the console can never be locked out of itself';

  -- ==========================================================================
  -- 7. Audit
  -- ==========================================================================
  select count(*) into n from public.audit_logs
   where action in ('platform.admin.granted', 'platform.admin.revoked');
  assert n >= 4, format('FAIL: %s roster actions audited, expected at least 4', n);

  -- Platform rows carry no organization, which is what keeps them out of every
  -- tenant's audit screen.
  select count(*) into n from public.audit_logs
   where action like 'platform.admin.%' and organization_id is not null;
  assert n = 0, 'FAIL: a platform roster action was attributed to an organization';

  raise notice 'ROSTER: every roster change is on the platform audit trail';

  raise notice 'PLATFORM ADMIN ROSTER: all assertions passed';
end $$;
