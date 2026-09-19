-- =============================================================================
-- LOCAL BASIC — 0053 Close the privilege-escalation paths in tenant RBAC
--
-- src/modules/core/rbac/permissions.ts states the rule plainly:
--
--   "A member may only grant a permission they themselves hold."
--
-- It was never enforced. ELEVATED_PERMISSIONS, the constant written to express
-- it, has no consumers anywhere in the codebase, and the policies below asked
-- only "may you manage roles?" — never "may you hand out THIS?".
--
-- Four doors led to the same place: a member with role.manage or member.manage
-- could hold every permission in the catalog within one statement.
--
--   1. role_permissions — insert any permission into a role you can edit,
--      including the role you yourself hold. Proven: the default `admin`
--      template holds role.manage and NOT billing.manage, and could grant
--      itself billing.manage, then all 53 permissions.
--
--   2. user_roles — assign any non-owner role to anyone, including yourself.
--      Proven: a role holding only member.read + member.manage assigned itself
--      the `admin` role and gained role.manage, treasury.manage,
--      payment.refund and invoice.void.
--
--   3. invitation_create — invite a new account carrying any role of the
--      organization. The inviter controls the address, so accepting it is the
--      same escalation with an extra step.
--
--   4. organizations.owner_user_id — writable by anyone holding
--      organization.manage, so an admin could name themselves the owner of
--      record. It confers no RBAC power, but it is what the platform console
--      shows operators as the customer's owner.
--
-- THE RULE, ONCE
--
-- app.role_grantable(role) answers "does the caller hold everything this role
-- holds?". One definition, used by the policy, the invitation and the tests,
-- so the three cannot drift.
--
-- WHAT IS DELIBERATELY STILL ALLOWED
--
-- REVOKING. The USING clauses are untouched, so role.manage may still remove a
-- permission the holder does not have. Revocation is de-escalation; requiring
-- the permission to take it away would let a stray grant become permanent
-- because nobody left is entitled to remove it.
--
-- Owner roles were already protected by `not r.is_owner` and stay so. Nothing
-- here touches provisioning, which runs SECURITY DEFINER and is not subject to
-- these policies.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. The rule.
--
-- True when the caller holds every permission the target role holds. A role
-- with no permissions is vacuously grantable, which is correct: it confers
-- nothing.
--
-- STABLE and SECURITY DEFINER for the same reason app.has_permission is: it
-- reads role_permissions, which the caller may not be able to read for every
-- role, and it must answer the same way regardless.
-- ---------------------------------------------------------------------------
create or replace function app.role_grantable(p_role uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select not exists (
    select 1
    from public.role_permissions rp
    join public.roles r on r.id = rp.role_id
    where rp.role_id = p_role
      and r.organization_id is not null
      and not app.has_permission(r.organization_id, rp.permission_key)
  );
$$;

revoke all on function app.role_grantable(uuid) from public, anon;
grant execute on function app.role_grantable(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. A permission may only be granted by someone who holds it.
--
-- Only the WITH CHECK changes. USING still asks for role.manage alone, which
-- is what keeps revocation possible.
-- ---------------------------------------------------------------------------
drop policy role_permissions_write on public.role_permissions;

create policy role_permissions_write on public.role_permissions for all to authenticated
  using (exists (
    select 1 from public.roles r
    where r.id = role_id and r.organization_id is not null
      and app.has_permission(r.organization_id, 'role.manage') and not r.is_owner
  ))
  with check (exists (
    select 1 from public.roles r
    where r.id = role_id and r.organization_id is not null
      and app.has_permission(r.organization_id, 'role.manage') and not r.is_owner
      -- The rule. Without this, role.manage is every permission.
      and app.has_permission(r.organization_id, permission_key)
  ));

-- ---------------------------------------------------------------------------
-- 3. A role may only be assigned by someone who holds everything in it.
--
-- Again only WITH CHECK: member.manage may still take a role away.
-- ---------------------------------------------------------------------------
drop policy user_roles_write on public.user_roles;

create policy user_roles_write on public.user_roles for all to authenticated
  using (exists (
    select 1 from public.organization_members m
    where m.id = member_id and app.has_permission(m.organization_id, 'member.manage')
  ))
  with check (exists (
    select 1 from public.organization_members m
    where m.id = member_id
      and app.has_permission(m.organization_id, 'member.manage')
      and app.role_grantable(role_id)
  ));

-- ---------------------------------------------------------------------------
-- 4. The same rule on the invitation, which is a role assignment posted into
--    the future.
--
-- A trigger on the table rather than a rewrite of invitation_create(): the
-- function is 0050's and reproducing its body here to add four lines would be
-- two copies to keep in step. A trigger also covers any future path that
-- writes an invitation, which is the property actually wanted.
--
-- It runs inside the SECURITY DEFINER function, but auth.uid() is still the
-- inviter, so app.role_grantable() judges the right person.
-- ---------------------------------------------------------------------------
create or replace function app.check_invitation_roles()
returns trigger language plpgsql set search_path = '' as $$
declare v_role uuid;
begin
  foreach v_role in array coalesce(new.role_ids, array[]::uuid[]) loop
    if not app.role_grantable(v_role) then
      raise exception 'لا يمكنك منح دور يحتوي صلاحيات لا تملكها'
        using errcode = '42501';
    end if;
  end loop;
  return new;
end;
$$;

revoke all on function app.check_invitation_roles() from public, anon, authenticated;

create trigger invitations_check_roles
  before insert on public.invitations
  for each row execute function app.check_invitation_roles();

-- ---------------------------------------------------------------------------
-- 5. Ownership of record is not a tenant-editable field.
--
-- owner_user_id is written once, by provisioning, and read by the platform
-- console to name a customer's owner. No flow transfers it, so an UPDATE that
-- changes it is either a mistake or someone claiming to be the owner.
--
-- A trigger rather than a column privilege because the organizations UPDATE
-- policy legitimately covers the rest of the row.
-- ---------------------------------------------------------------------------
create or replace function app.freeze_organization_owner()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.owner_user_id is distinct from old.owner_user_id then
    raise exception 'ownership cannot be reassigned here' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function app.freeze_organization_owner() from public, anon, authenticated;

create trigger organizations_freeze_owner
  before update on public.organizations
  for each row execute function app.freeze_organization_owner();
