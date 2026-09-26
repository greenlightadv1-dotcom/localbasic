-- =============================================================================
-- LOCAL BASIC — 0074 Platform console: granular staff role management
--
-- Nobody could actually change a staff member's roles after the fact,
-- anywhere in the product. A role is chosen once, at invitation or direct-
-- account-creation time (member_provision_direct, 0063); settings/roles is
-- explicitly read-only ("the editor is still to come"). This gives the
-- Platform Admin console that missing edit — not the tenant screen, which
-- stays exactly as read-only as it was.
--
-- WHY THE TENANT ESCALATION GUARD (app.role_grantable, 0053) DOES NOT APPLY.
--
-- That guard answers "does the CALLER hold every permission this role
-- holds", which only makes sense for a caller who is themselves a member of
-- the organization. A Platform Admin has no organization_members row for
-- ANY tenant — by design (0029) — so app.has_permission() is always false
-- for them there, and the guard would refuse every grant vacuously. A
-- Platform Admin operates above tenant RBAC entirely, the same as
-- platform_switch_plan/platform_delete_organization/
-- platform_reset_organization_data already do; the guard here is coarser
-- and platform-shaped instead: any active admin may grant or revoke a
-- non-owner role, but only a platform OWNER may touch the organization's
-- `is_owner` role — hand someone full control of a tenant, or take it away.
--
-- Everything else that already protects user_roles keeps protecting it:
-- check_user_role_tenancy (0002) still refuses a role or branch from a
-- different organization than the target member's, regardless of caller.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- The org's staff roster: who they are, and every role currently granted to
-- them (role name + which branch it is scoped to, null = every branch).
-- ---------------------------------------------------------------------------
create or replace function public.platform_customer_staff(p_customer_code text)
returns table (
  member_id     uuid,
  user_id       uuid,
  full_name     text,
  phone         text,
  status        text,
  all_branches  boolean,
  roles         jsonb
)
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid;
begin
  perform app.require_platform_admin();
  v_org := app.platform_customer_org(p_customer_code);
  if v_org is null then
    return;
  end if;

  return query
  select
    m.id,
    m.user_id,
    p.full_name,
    p.phone,
    m.status,
    m.all_branches,
    coalesce(
      (select jsonb_agg(jsonb_build_object(
         'userRoleId', ur.id,
         'roleId', r.id,
         'roleKey', r.key,
         'roleNameAr', r.name_ar,
         'isOwner', r.is_owner,
         'branchId', ur.branch_id,
         'branchName', b.name
       ) order by r.is_owner desc, r.key)
       from public.user_roles ur
       join public.roles r on r.id = ur.role_id
       left join public.branches b on b.id = ur.branch_id
       where ur.member_id = m.id),
      '[]'::jsonb
    ) as roles
  from public.organization_members m
  join public.profiles p on p.id = m.user_id
  where m.organization_id = v_org
  order by p.full_name;
end;
$$;

-- ---------------------------------------------------------------------------
-- The org's role catalogue, for the "assign a role" picker.
-- ---------------------------------------------------------------------------
create or replace function public.platform_customer_role_catalog(p_customer_code text)
returns table (role_id uuid, key text, name_ar text, is_owner boolean)
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid;
begin
  perform app.require_platform_admin();
  v_org := app.platform_customer_org(p_customer_code);
  if v_org is null then
    return;
  end if;

  return query
  select r.id, r.key, r.name_ar, r.is_owner
  from public.roles r
  where r.organization_id = v_org
  order by r.is_owner desc, r.key;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grant. member, role and (optional) branch must all resolve inside the
-- SAME customer named by the code — a mismatched id is refused, never
-- silently coerced into "whichever org it actually belongs to".
-- ---------------------------------------------------------------------------
create or replace function public.platform_grant_staff_role(
  p_customer_code text,
  p_member_id     uuid,
  p_role_id       uuid,
  p_branch_id     uuid default null
)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_org      uuid;
  v_is_owner boolean;
  v_role_name text;
  v_member_name text;
begin
  perform app.require_platform_admin();
  v_org := app.platform_customer_org(p_customer_code);
  if v_org is null then
    raise exception 'unknown customer' using errcode = '22023';
  end if;

  select r.is_owner, r.name_ar into v_is_owner, v_role_name
    from public.roles r where r.id = p_role_id and r.organization_id = v_org;
  if v_role_name is null then
    raise exception 'role does not belong to this customer' using errcode = '22023';
  end if;

  if v_is_owner and not app.is_platform_owner() then
    raise exception 'only a platform owner may grant the owner role' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.organization_members m
    where m.id = p_member_id and m.organization_id = v_org
  ) then
    raise exception 'member does not belong to this customer' using errcode = '22023';
  end if;

  if p_branch_id is not null and not exists (
    select 1 from public.branches b where b.id = p_branch_id and b.organization_id = v_org
  ) then
    raise exception 'branch does not belong to this customer' using errcode = '22023';
  end if;

  insert into public.user_roles (member_id, role_id, branch_id, granted_by)
  values (p_member_id, p_role_id, p_branch_id, auth.uid())
  on conflict (member_id, role_id, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid))
  do nothing;

  select p.full_name into v_member_name
    from public.organization_members m join public.profiles p on p.id = m.user_id
   where m.id = p_member_id;

  perform public.write_platform_audit(
    'platform.staff_role_granted', 'user_role', p_member_id::text,
    jsonb_build_object('member_name', v_member_name, 'role', v_role_name, 'branch_id', p_branch_id),
    v_org
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Revoke. Same ownership checks; a missing grant is a no-op, not an error —
-- revoking something already gone is a fine outcome to ask for.
-- ---------------------------------------------------------------------------
create or replace function public.platform_revoke_staff_role(
  p_customer_code text,
  p_member_id     uuid,
  p_role_id       uuid,
  p_branch_id     uuid default null
)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_org      uuid;
  v_is_owner boolean;
  v_role_name text;
  v_member_name text;
begin
  perform app.require_platform_admin();
  v_org := app.platform_customer_org(p_customer_code);
  if v_org is null then
    raise exception 'unknown customer' using errcode = '22023';
  end if;

  select r.is_owner, r.name_ar into v_is_owner, v_role_name
    from public.roles r where r.id = p_role_id and r.organization_id = v_org;
  if v_role_name is null then
    raise exception 'role does not belong to this customer' using errcode = '22023';
  end if;

  if v_is_owner and not app.is_platform_owner() then
    raise exception 'only a platform owner may revoke the owner role' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.organization_members m
    where m.id = p_member_id and m.organization_id = v_org
  ) then
    raise exception 'member does not belong to this customer' using errcode = '22023';
  end if;

  delete from public.user_roles
   where member_id = p_member_id
     and role_id = p_role_id
     and coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid)
       = coalesce(p_branch_id, '00000000-0000-0000-0000-000000000000'::uuid);

  select p.full_name into v_member_name
    from public.organization_members m join public.profiles p on p.id = m.user_id
   where m.id = p_member_id;

  perform public.write_platform_audit(
    'platform.staff_role_revoked', 'user_role', p_member_id::text,
    jsonb_build_object('member_name', v_member_name, 'role', v_role_name, 'branch_id', p_branch_id),
    v_org
  );
end;
$$;

revoke all on function public.platform_customer_staff(text) from public, anon;
revoke all on function public.platform_customer_role_catalog(text) from public, anon;
revoke all on function public.platform_grant_staff_role(text, uuid, uuid, uuid) from public, anon;
revoke all on function public.platform_revoke_staff_role(text, uuid, uuid, uuid) from public, anon;

grant execute on function public.platform_customer_staff(text) to authenticated;
grant execute on function public.platform_customer_role_catalog(text) to authenticated;
grant execute on function public.platform_grant_staff_role(text, uuid, uuid, uuid) to authenticated;
grant execute on function public.platform_revoke_staff_role(text, uuid, uuid, uuid) to authenticated;
