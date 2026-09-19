-- =============================================================================
-- LOCAL BASIC — RBAC reconciliation suite
--
-- Covers supabase/scripts/rbac_reconciliation.sql, the read-only investigative
-- report for the escalation paths 0053 closed.
--
-- What has to hold:
--
--   1. A legitimate custom role is NOT reported. Organizations may invent
--      roles; their permission sets were never templated, so divergence from a
--      template is not even defined for them.
--   2. A cloned template role holding a permission its template lacks IS
--      reported — the shape the pre-0053 escalation left behind.
--   3. A cloned role matching its template exactly is NOT reported.
--   4. The report performs no mutations, enforced by the server.
--   5. 0053's protections still hold, so the escalation cannot be recreated.
--
-- NOTE ON DUPLICATION. The predicates below deliberately mirror sections 1 and
-- 2 of the script. There is no shared object to call, because the script must
-- stay pure SELECT and may not create a view or function in the database it
-- inspects. Change one, change the other.
--
-- Run with:  psql -v ON_ERROR_STOP=1 -f supabase/tests/26_rbac_reconciliation.sql
-- =============================================================================

\set ON_ERROR_STOP on

do $$
declare
  u_owner uuid; u_staff uuid;
  org uuid; br uuid;
  r_admin uuid; r_custom uuid; r_cashier uuid; r_editor uuid;
  m_staff uuid; m_editor uuid; u_editor uuid;
  n int; ok boolean;
begin
  insert into auth.users (email) values ('rec_o@test.local') returning id into u_owner;
  insert into auth.users (email) values ('rec_s@test.local') returning id into u_staff;

  perform auth.login_as(u_owner);
  select out_organization_id, out_branch_id into org, br
    from public.provision_workspace('شركة التسوية', 'reconcile', 'retail');

  perform auth.logout();
  perform set_config('role', 'postgres', true);

  select id into r_admin   from public.roles where organization_id = org and key = 'admin';
  select id into r_cashier from public.roles where organization_id = org and key = 'cashier';

  -- A legitimate custom role: the organization's own invention, holding a
  -- financial permission no template of that name ever had.
  insert into public.roles (organization_id, key, name_ar, name_en, is_system, is_owner)
  values (org, 'floor_lead', 'مشرف صالة', 'Floor Lead', false, false)
  returning id into r_custom;
  insert into public.role_permissions (role_id, permission_key) values
    (r_custom, 'treasury.read'), (r_custom, 'payment.refund');

  -- The escalation shape: a CLONED template role carrying a permission its
  -- template never had. billing.manage is exactly what the default admin
  -- template lacks.
  -- Idempotent: if a future template ever ships billing.manage the clone will
  -- already hold it, and this fixture should still set up cleanly so the
  -- assertion below is what reports the change — not a primary-key collision.
  insert into public.role_permissions (role_id, permission_key)
  values (r_admin, 'billing.manage')
  on conflict do nothing;

  -- ==========================================================================
  -- 1. A custom role is not reported.
  -- ==========================================================================
  select count(*) into n
  from public.roles r
  join public.role_permissions rp on rp.role_id = r.id
  where r.organization_id = org and r.is_system and not r.is_owner
    and r.id = r_custom;
  assert n = 0,
    'FAIL: the custom role is being treated as template-cloned, so it would be reported';

  -- Stated the other way: it is classified as customization, which section 5
  -- of the script counts and never reports.
  select count(*) into n from public.roles r
   where r.id = r_custom and not r.is_system;
  assert n = 1, 'FAIL: the custom role lost its custom classification';
  raise notice 'OK 1: a legitimate custom role is not a finding';

  -- ==========================================================================
  -- 2. The escalation shape IS reported.
  --
  -- Section 1 of the script, verbatim in substance: a system, non-owner role
  -- holding a permission absent from the template with its key and module.
  -- ==========================================================================
  with template as (
    select r.id, r.key, coalesce(r.module_key, '') as module_key
    from public.roles r where r.organization_id is null
  ),
  template_perm as (
    select t.key, t.module_key, rp.permission_key
    from template t join public.role_permissions rp on rp.role_id = t.id
  )
  select count(*) into n
  from public.roles orr
  join public.role_permissions rp on rp.role_id = orr.id
  where orr.organization_id = org and orr.is_system and not orr.is_owner
    and not exists (
      select 1 from template_perm tp
      where tp.key = orr.key
        and tp.module_key = coalesce(orr.module_key, '')
        and tp.permission_key = rp.permission_key
    );
  assert n = 1, format('FAIL: expected exactly the planted escalation, found %s', n);

  -- And it is the row we planted, not something else.
  with template as (
    select r.id, r.key, coalesce(r.module_key, '') as module_key
    from public.roles r where r.organization_id is null
  ),
  template_perm as (
    select t.key, t.module_key, rp.permission_key
    from template t join public.role_permissions rp on rp.role_id = t.id
  )
  select count(*) into n
  from public.roles orr
  join public.role_permissions rp on rp.role_id = orr.id
  where orr.id = r_admin and rp.permission_key = 'billing.manage'
    and not exists (
      select 1 from template_perm tp
      where tp.key = orr.key
        and tp.module_key = coalesce(orr.module_key, '')
        and tp.permission_key = rp.permission_key
    );
  assert n = 1, 'FAIL: the planted escalation is not the row being reported';
  raise notice 'OK 2: a template-cloned role holding an untemplated permission is reported';

  -- ==========================================================================
  -- 3. An untouched cloned role is silent.
  -- ==========================================================================
  with template as (
    select r.id, r.key, coalesce(r.module_key, '') as module_key
    from public.roles r where r.organization_id is null
  ),
  template_perm as (
    select t.key, t.module_key, rp.permission_key
    from template t join public.role_permissions rp on rp.role_id = t.id
  )
  select count(*) into n
  from public.roles orr
  join public.role_permissions rp on rp.role_id = orr.id
  where orr.id = r_cashier
    and not exists (
      select 1 from template_perm tp
      where tp.key = orr.key
        and tp.module_key = coalesce(orr.module_key, '')
        and tp.permission_key = rp.permission_key
    );
  assert n = 0, format('FAIL: an untouched cashier role produced %s findings', n);
  raise notice 'OK 3: a cloned role matching its template is not reported';

  -- ==========================================================================
  -- 4. Provisioning's owner grant is excluded; a later self-grant is not.
  --
  -- The exclusion keys on the shared transaction timestamp, NOT on
  -- organizations.owner_user_id — that column is what the fourth escalation
  -- path rewrites, so keying on it would let an attacker erase their own row.
  -- ==========================================================================
  select count(*) into n
  from public.user_roles ur
  join public.organization_members m on m.id = ur.member_id
  join public.roles r on r.id = ur.role_id
  join public.organizations o on o.id = m.organization_id
  where m.organization_id = org
    and ur.granted_by = m.user_id
    and not (r.is_owner and ur.created_at = o.created_at);
  assert n = 0, format('FAIL: provisioning''s owner grant was reported (%s rows)', n);

  -- A member self-granting a role afterwards, with the actor recorded.
  insert into public.organization_members (organization_id, user_id, status, all_branches)
  values (org, u_staff, 'active', true) returning id into m_staff;
  insert into public.user_roles (member_id, role_id, granted_by)
  values (m_staff, r_admin, u_staff);

  select count(*) into n
  from public.user_roles ur
  join public.organization_members m on m.id = ur.member_id
  join public.roles r on r.id = ur.role_id
  join public.organizations o on o.id = m.organization_id
  where m.organization_id = org
    and ur.granted_by = m.user_id
    and not (r.is_owner and ur.created_at = o.created_at);
  assert n = 1, format('FAIL: a later self-grant was not reported (%s rows)', n);
  raise notice 'OK 4: provisioning is excluded, a real self-grant is not';

  -- ==========================================================================
  -- 5. 0053 still holds — the escalation cannot be recreated through the app.
  --
  -- The rows above were planted as postgres, which bypasses RLS. Through a
  -- real session it must still be refused.
  -- ==========================================================================
  -- u_staff now holds the admin role, and the planted billing.manage made that
  -- role the whole catalog — so nothing would be refusable through them. The
  -- check needs an actor who genuinely lacks something: a role holding
  -- role.manage and little else.
  insert into public.roles (organization_id, key, name_ar, name_en, is_system, is_owner)
  values (org, 'role_editor', 'محرر الأدوار', 'Role Editor', false, false)
  returning id into r_editor;
  insert into public.role_permissions (role_id, permission_key) values
    (r_editor, 'member.read'), (r_editor, 'role.manage');

  insert into auth.users (email) values ('rec_e@test.local') returning id into u_editor;
  insert into public.organization_members (organization_id, user_id, status, all_branches)
  values (org, u_editor, 'active', true) returning id into m_editor;
  insert into public.user_roles (member_id, role_id, granted_by)
  values (m_editor, r_editor, u_owner);

  perform auth.login_as(u_editor);
  assert app.has_permission(org, 'role.manage'),
    'FAIL: fixture is wrong — the editor should hold role.manage';
  assert not app.has_permission(org, 'treasury.manage'),
    'FAIL: fixture is wrong — the editor should not hold treasury.manage';

  ok := false;
  begin
    insert into public.role_permissions (role_id, permission_key)
    values (r_cashier, 'treasury.manage');
  exception when others then ok := true; end;
  assert ok, 'FAIL: 0053 no longer blocks granting a permission the granter lacks';
  assert not app.has_permission(org, 'treasury.manage'),
    'FAIL: the grant landed despite reporting an error';
  raise notice 'OK 5: 0053 protections remain intact';

  perform set_config('role', 'postgres', true);
  raise notice 'RBAC RECONCILIATION: all assertions passed';
end $$;

-- ---------------------------------------------------------------------------
-- 6. The report mutates nothing — enforced by the server, not by review.
--
-- PostgreSQL refuses INSERT, UPDATE, DELETE and CREATE (including temporary
-- tables) inside a read-only transaction, which is the guard the script opens
-- with. Proving the guard works proves the script cannot write whatever it
-- contains.
-- ---------------------------------------------------------------------------
begin;
set transaction read only;
do $$
declare ok boolean; n int;
begin
  ok := false;
  begin
    insert into public.role_permissions (role_id, permission_key)
    select id, 'customer.read' from public.roles limit 1;
  exception when others then ok := true; end;
  assert ok, 'FAIL: a read-only transaction allowed an INSERT';

  ok := false;
  begin
    update public.organizations set name = 'x' where slug = 'reconcile';
  exception when others then ok := true; end;
  assert ok, 'FAIL: a read-only transaction allowed an UPDATE';

  ok := false;
  begin
    delete from public.role_permissions where permission_key = 'billing.manage';
  exception when others then ok := true; end;
  assert ok, 'FAIL: a read-only transaction allowed a DELETE';

  ok := false;
  begin
    create temp table probe (x int);
  exception when others then ok := true; end;
  assert ok, 'FAIL: a read-only transaction allowed CREATE TEMP TABLE';

  -- Reads still work, or the report would be useless.
  select count(*) into n from public.role_permissions;
  assert n > 0, 'FAIL: the read-only transaction cannot read';

  raise notice 'OK 6: the read-only guard blocks every write and permits reads';
end $$;
rollback;

\echo 'RBAC RECONCILIATION SCRIPT: read-only guard verified'
