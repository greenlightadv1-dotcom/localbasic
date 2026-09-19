-- =============================================================================
-- LOCAL BASIC — Privilege escalation suite (0053)
--
-- permissions.ts has always stated the rule: "A member may only grant a
-- permission they themselves hold." Until 0053 nothing enforced it, and four
-- doors led from role.manage or member.manage to the entire catalog.
--
-- What has to hold:
--
--   1. A permission cannot be granted by someone who does not hold it —
--      including into the granter's own role.
--   2. A role cannot be assigned by someone who does not hold everything in it.
--   3. An invitation cannot carry a role stronger than the inviter.
--   4. owner_user_id is not tenant-editable.
--   5. None of this breaks legitimate administration: an admin still assigns
--      the standard templates, still grants what it holds, and revocation
--      still works for anyone with role.manage.
--
-- Run with:  psql -v ON_ERROR_STOP=1 -f supabase/tests/25_rbac_escalation.sql
-- =============================================================================

\set ON_ERROR_STOP on

do $$
declare
  u_owner uuid; u_admin uuid; u_hr uuid;
  org uuid; br uuid;
  r_admin uuid; r_hr uuid; r_cashier uuid;
  m_admin uuid; m_hr uuid;
  ok boolean; n int;
begin
  -- ==========================================================================
  -- Fixture: an owner, a default-template admin, and a deliberately narrow HR
  -- role holding member.manage and nothing financial.
  -- ==========================================================================
  insert into auth.users (email) values ('esc_o@test.local') returning id into u_owner;
  insert into auth.users (email) values ('esc_a@test.local') returning id into u_admin;
  insert into auth.users (email) values ('esc_h@test.local') returning id into u_hr;

  perform auth.login_as(u_owner);
  select out_organization_id, out_branch_id into org, br
    from public.provision_workspace('شركة التصعيد', 'escalation', 'retail');

  perform auth.logout();
  perform set_config('role', 'postgres', true);

  select id into r_admin   from public.roles where organization_id = org and key = 'admin';
  select id into r_cashier from public.roles where organization_id = org and key = 'cashier';

  insert into public.roles (organization_id, key, name_ar, name_en, is_system, is_owner)
  values (org, 'hr', 'موارد بشرية', 'HR', false, false) returning id into r_hr;
  insert into public.role_permissions (role_id, permission_key) values
    (r_hr, 'member.read'), (r_hr, 'member.manage');

  insert into public.organization_members (organization_id, user_id, status, all_branches)
  values (org, u_admin, 'active', true) returning id into m_admin;
  insert into public.user_roles (member_id, role_id) values (m_admin, r_admin);

  insert into public.organization_members (organization_id, user_id, status, all_branches)
  values (org, u_hr, 'active', true) returning id into m_hr;
  insert into public.user_roles (member_id, role_id) values (m_hr, r_hr);

  -- The fixture only means something if these hold.
  perform auth.login_as(u_admin);
  assert app.has_permission(org, 'role.manage'),
    'FAIL: fixture is wrong — the admin template should hold role.manage';
  assert not app.has_permission(org, 'billing.manage'),
    'FAIL: fixture is wrong — the admin template should NOT hold billing.manage';

  -- ==========================================================================
  -- 1. A permission cannot be granted by someone who lacks it.
  -- ==========================================================================
  ok := false;
  begin
    insert into public.role_permissions (role_id, permission_key)
    values (r_admin, 'billing.manage');
  exception when others then ok := true; end;
  assert ok, 'FAIL: role.manage granted itself a permission it did not hold';
  assert not app.has_permission(org, 'billing.manage'),
    'FAIL: the escalation landed even though the insert reported an error';

  -- Not just into its own role: into any role it can edit.
  ok := false;
  begin
    insert into public.role_permissions (role_id, permission_key)
    values (r_hr, 'billing.manage');
  exception when others then ok := true; end;
  assert ok, 'FAIL: a permission was granted into another role by a non-holder';
  raise notice 'OK 1: a permission cannot be granted by someone who lacks it';

  -- ==========================================================================
  -- 2. A role cannot be assigned by someone who lacks what it holds.
  -- ==========================================================================
  perform auth.login_as(u_hr);
  assert app.has_permission(org, 'member.manage'),
    'FAIL: fixture is wrong — HR should hold member.manage';
  assert not app.has_permission(org, 'role.manage'),
    'FAIL: fixture is wrong — HR should not hold role.manage';

  ok := false;
  begin
    insert into public.user_roles (member_id, role_id) values (m_hr, r_admin);
  exception when others then ok := true; end;
  assert ok, 'FAIL: member.manage assigned itself the admin role';
  assert not app.has_permission(org, 'role.manage'),
    'FAIL: HR gained role.manage';
  assert not app.has_permission(org, 'payment.refund'),
    'FAIL: HR gained payment.refund';

  -- Nor onto somebody else, which is the same escalation with a helper.
  ok := false;
  begin
    insert into public.user_roles (member_id, role_id) values (m_admin, r_admin);
  exception when others then ok := true; end;
  assert ok, 'FAIL: member.manage assigned a stronger role to another member';
  raise notice 'OK 2: a role cannot be assigned by someone who lacks what it holds';

  -- ==========================================================================
  -- 3. An invitation cannot carry a role stronger than the inviter.
  --
  -- The inviter controls the address, so this is escalation with one extra
  -- step: invite yourself as admin, accept, done.
  -- ==========================================================================
  ok := false;
  begin
    perform public.invitation_create(
      org, 'takeover@test.local', array[r_admin], '{}'::uuid[], true, 7);
  exception when others then ok := true; end;
  assert ok, 'FAIL: member.manage invited a new account as admin';

  select count(*) into n from public.invitations
   where organization_id = org and lower(email::text) = 'takeover@test.local';
  assert n = 0, 'FAIL: the over-privileged invitation was stored anyway';

  -- An invitation carrying only what the inviter holds is still fine.
  begin
    perform public.invitation_create(
      org, 'newhr@test.local', array[r_hr], '{}'::uuid[], true, 7);
    raise notice 'OK 3: HR may still invite at its own level';
  exception when others then
    raise exception 'FAIL: a legitimate invitation was refused — %', sqlerrm;
  end;

  -- ==========================================================================
  -- 4. Ownership of record is not tenant-editable.
  -- ==========================================================================
  perform auth.login_as(u_admin);
  assert app.has_permission(org, 'organization.manage'),
    'FAIL: fixture is wrong — the admin template should hold organization.manage';

  ok := false;
  begin
    update public.organizations set owner_user_id = u_admin where id = org;
  exception when others then ok := true; end;
  assert ok, 'FAIL: an admin reassigned organization ownership';

  select count(*) into n from public.organizations
   where id = org and owner_user_id = u_owner;
  assert n = 1, 'FAIL: owner_user_id changed';

  -- The rest of the row is still editable by organization.manage.
  begin
    update public.organizations set name = 'اسم جديد' where id = org;
    raise notice 'OK 4: ownership is frozen, the rest of the organization is not';
  exception when others then
    raise exception 'FAIL: freezing ownership broke ordinary organization edits — %', sqlerrm;
  end;

  -- ==========================================================================
  -- 5. Legitimate administration is untouched.
  -- ==========================================================================
  begin
    insert into public.user_roles (member_id, role_id) values (m_hr, r_cashier);
    raise notice 'OK 5a: an admin still assigns the standard templates';
  exception when others then
    raise exception 'FAIL: an admin can no longer assign the cashier role — %', sqlerrm;
  end;

  begin
    insert into public.role_permissions (role_id, permission_key)
    values (r_hr, 'customer.read');
    raise notice 'OK 5b: an admin still grants a permission it holds';
  exception when others then
    raise exception 'FAIL: an admin can no longer grant customer.read — %', sqlerrm;
  end;

  -- Revocation is deliberately NOT restricted: de-escalation must stay
  -- possible, or a stray grant becomes permanent because nobody is entitled
  -- to remove it.
  begin
    delete from public.role_permissions where role_id = r_hr and permission_key = 'customer.read';
    get diagnostics n = row_count;
    assert n = 1, 'FAIL: revocation removed nothing';
    raise notice 'OK 5c: revocation still works';
  exception when insufficient_privilege then
    raise exception 'FAIL: revocation was blocked';
  end;

  -- The owner holds the whole catalog and may still hand any of it out.
  perform auth.login_as(u_owner);
  begin
    insert into public.role_permissions (role_id, permission_key)
    values (r_hr, 'billing.manage');
    raise notice 'OK 5d: the owner can still grant anything';
  exception when others then
    raise exception 'FAIL: the owner can no longer grant billing.manage — %', sqlerrm;
  end;

  -- ==========================================================================
  -- 6. The owner role itself stays untouchable, as before 0053.
  -- ==========================================================================
  perform auth.login_as(u_admin);
  ok := false;
  begin
    insert into public.role_permissions (role_id, permission_key)
    select r.id, 'customer.read' from public.roles r
    where r.organization_id = org and r.is_owner;
  exception when others then ok := true; end;
  assert ok, 'FAIL: the owner role was edited by an admin';
  raise notice 'OK 6: the owner role remains uneditable';

  perform set_config('role', 'postgres', true);
  raise notice 'RBAC ESCALATION: all assertions passed';
end $$;
