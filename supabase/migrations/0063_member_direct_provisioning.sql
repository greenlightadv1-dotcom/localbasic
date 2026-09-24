-- =============================================================================
-- LOCAL BASIC — Direct staff provisioning, alongside invitations
--
-- Every staff account today goes through invitations: create a token, mail a
-- link, the invitee accepts it under their own session. That is right for an
-- owner inviting someone who is not yet at a keyboard. It is the wrong shape
-- for an admin standing at the till on day one, handing a cashier a working
-- login before their first shift — there is no email round trip to wait on,
-- and the admin already knows the password they want set.
--
-- IDENTITY vs WORKSPACE, the same split onboarding uses.
--
-- Creating the auth.users row with a password is not something SQL can do —
-- that is the Supabase Admin API, called from the server with the service
-- role key (src/modules/core/members/direct.ts). This function is the
-- WORKSPACE half: given a user id that already exists, attach it to this
-- organization exactly the way invitation_accept() would, minus the
-- invitation row, because there never was one.
--
-- EVERY GUARD invitation_create()/invitation_accept() enforce, reproduced:
--   - caller must hold member.manage on p_org
--   - every role id must belong to p_org
--   - every branch id must belong to p_org
--   - app.role_grantable(): the caller cannot hand out a role carrying a
--     permission they do not themselves hold — SECURITY DEFINER bypasses the
--     user_roles RLS policy that normally checks this (0053), so it is
--     re-checked here explicitly, the same way the invitations trigger does.
-- =============================================================================

create or replace function public.member_provision_direct(
  p_org        uuid,
  p_user       uuid,
  p_full_name  text,
  p_role_ids   uuid[] default '{}',
  p_branch_ids uuid[] default '{}',
  p_all_branches boolean default false
)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_caller uuid := auth.uid();
  v_member uuid;
  v_role   uuid;
  v_branch uuid;
begin
  if v_caller is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not app.has_permission(p_org, 'member.manage') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if p_user is null or not exists (select 1 from auth.users u where u.id = p_user) then
    raise exception 'that account does not exist' using errcode = 'check_violation';
  end if;

  foreach v_role in array coalesce(p_role_ids, array[]::uuid[]) loop
    if not exists (select 1 from public.roles r where r.id = v_role and r.organization_id = p_org) then
      raise exception 'that role does not belong to this organization' using errcode = 'check_violation';
    end if;
    if not app.role_grantable(v_role) then
      raise exception 'لا يمكنك منح دور يحتوي صلاحيات لا تملكها' using errcode = '42501';
    end if;
  end loop;

  foreach v_branch in array coalesce(p_branch_ids, array[]::uuid[]) loop
    if not exists (select 1 from public.branches b where b.id = v_branch and b.organization_id = p_org) then
      raise exception 'that branch does not belong to this organization' using errcode = 'check_violation';
    end if;
  end loop;

  insert into public.profiles (id, full_name) values (p_user, nullif(trim(p_full_name), ''))
  on conflict (id) do update
     set full_name = coalesce(excluded.full_name, public.profiles.full_name);

  insert into public.organization_members
    (organization_id, user_id, status, all_branches, invited_by, joined_at)
  values
    (p_org, p_user, 'active', p_all_branches, v_caller, now())
  on conflict (organization_id, user_id) do update
     set status = 'active',
         all_branches = excluded.all_branches,
         joined_at = coalesce(public.organization_members.joined_at, now())
  returning id into v_member;

  foreach v_branch in array coalesce(p_branch_ids, array[]::uuid[]) loop
    insert into public.member_branches (member_id, branch_id)
    values (v_member, v_branch) on conflict do nothing;
  end loop;

  foreach v_role in array coalesce(p_role_ids, array[]::uuid[]) loop
    insert into public.user_roles (member_id, role_id, granted_by)
    values (v_member, v_role, v_caller) on conflict do nothing;
  end loop;

  insert into public.audit_logs
    (organization_id, actor_id, actor_label, action, entity_type, entity_id, after)
  values
    (p_org, v_caller,
     (select p.full_name from public.profiles p where p.id = v_caller),
     'member.created_directly', 'organization_member', v_member::text,
     jsonb_build_object('roles', coalesce(array_length(p_role_ids, 1), 0)));

  return v_member;
end;
$$;

revoke all on function public.member_provision_direct(uuid, uuid, text, uuid[], uuid[], boolean) from public, anon;
grant execute on function public.member_provision_direct(uuid, uuid, text, uuid[], uuid[], boolean) to authenticated;
