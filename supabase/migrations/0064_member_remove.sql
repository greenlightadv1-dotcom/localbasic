-- =============================================================================
-- LOCAL BASIC — Removing a staff member
--
-- member_provision_direct() (0063) and invitation_accept() both ADD a member
-- to user_roles/member_branches/organization_members. This is the mirror:
-- remove all three, in one transaction, for one member.
--
-- WHY A CASCADE DELETE ON organization_members ALONE IS NOT ENOUGH TO CALL
-- THIS DONE (it would in fact work — user_roles.member_id and
-- member_branches.member_id both cascade). What is missing from a bare
-- DELETE is everything this function adds around it:
--   - the org's real owner (organizations.owner_user_id) cannot be removed
--     this way — that would orphan the workspace with no owner of record
--   - a member holding an is_owner role cannot be removed this way either,
--     for the same reason, even if they are not organizations.owner_user_id
--   - the removal is audited, on the member's own organization
--
-- REAL-TIME REVOCATION. Every permission check in this codebase
-- (app.has_permission, requirePermission) reads organization_members and
-- user_roles live, on every request — there is no cached claim to go stale.
-- The moment this transaction commits, the removed member's very next
-- request fails authorization; there is nothing further to revoke. The
-- client-side realtime listener (useMembershipWatch, src/modules/core/members)
-- exists on top of that for UX — signing a still-open tab out immediately
-- rather than waiting for its next action to 403 — not because the server
-- side needs it to be secure.
-- =============================================================================

create or replace function public.member_remove(p_org uuid, p_member uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_caller       uuid := auth.uid();
  v_target_user  uuid;
  v_owner        uuid;
begin
  if v_caller is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not app.has_permission(p_org, 'member.manage') then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  select user_id into v_target_user
    from public.organization_members
   where id = p_member and organization_id = p_org;

  if v_target_user is null then
    raise exception 'member not found' using errcode = '22023';
  end if;

  select owner_user_id into v_owner from public.organizations where id = p_org;
  if v_target_user = v_owner then
    raise exception 'لا يمكن حذف مالك المنشأة' using errcode = '42501';
  end if;

  if exists (
    select 1 from public.user_roles ur
    join public.roles r on r.id = ur.role_id
    where ur.member_id = p_member and r.is_owner
  ) then
    raise exception 'لا يمكن حذف عضو يحمل دور المالك' using errcode = '42501';
  end if;

  delete from public.user_roles where member_id = p_member;
  delete from public.member_branches where member_id = p_member;
  delete from public.organization_members where id = p_member;

  insert into public.audit_logs
    (organization_id, actor_id, actor_label, action, entity_type, entity_id, after)
  values
    (p_org, v_caller,
     (select p.full_name from public.profiles p where p.id = v_caller),
     'member.removed', 'organization_member', p_member::text,
     jsonb_build_object('removed_user_id', v_target_user));
end;
$$;

revoke all on function public.member_remove(uuid, uuid) from public, anon;
grant execute on function public.member_remove(uuid, uuid) to authenticated;
