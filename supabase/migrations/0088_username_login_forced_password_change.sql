-- ---------------------------------------------------------------------------
-- 0088: username login and forced password change.
--
-- Staff and restaurant owners now sign in with a USERNAME + password. Supabase
-- Auth still needs an email on auth.users, so the application derives a
-- deterministic internal address from the username (<username>@login.
-- localbasic.internal). The username itself is kept on the profile so screens
-- can show it without parsing that address.
--
-- must_change_password marks an account whose current password was handed
-- over by someone else (a platform super-admin creating or resetting an
-- owner). The app sends such an account to a mandatory "change password"
-- screen before anything else.
--
-- Both columns are written ONLY by the service role. profiles_update_self
-- (0007) lets a user update their own row, so without the trigger below a
-- signed-in owner could clear their own flag with one request and skip the
-- forced change, or rename their username.
-- ---------------------------------------------------------------------------

alter table public.profiles
  add column if not exists username text,
  add column if not exists must_change_password boolean not null default false;

alter table public.profiles
  add constraint profiles_username_format
  check (username is null or username ~ '^[a-z0-9][a-z0-9._-]{2,31}$');

create unique index if not exists profiles_username_unique
  on public.profiles (lower(username))
  where username is not null;

-- NOT security definer: inside a definer function current_user is the function
-- owner, which would make the role check below always pass.
create or replace function app.profiles_guard_credentials()
returns trigger language plpgsql set search_path = '' as $$
begin
  -- current_user is the role the statement runs as: 'authenticated' / 'anon'
  -- for a request made with a user's JWT, while the service role and
  -- migrations run as something else.
  if current_user in ('authenticated', 'anon')
     and (new.username is distinct from old.username
          or new.must_change_password is distinct from old.must_change_password) then
    raise exception 'username and must_change_password cannot be changed directly'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

revoke all on function app.profiles_guard_credentials() from public, anon, authenticated;

drop trigger if exists profiles_guard_credentials on public.profiles;
create trigger profiles_guard_credentials
  before update on public.profiles
  for each row execute function app.profiles_guard_credentials();

-- ---------------------------------------------------------------------------
-- Resetting a staff member's password.
--
-- The password itself is set through the Supabase Admin API (SQL cannot), so
-- this function is only the AUTHORIZATION half: it decides whether the caller
-- may re-key this member and hands back the account to re-key. Same shape as
-- member_remove (0064), plus the escalation rule from 0053 — without it, any
-- holder of member.manage could reset the password of someone with MORE
-- permissions than their own and sign in as them.
-- ---------------------------------------------------------------------------
create or replace function public.member_reset_password_authorize(p_org uuid, p_member uuid)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_caller      uuid := auth.uid();
  v_target_user uuid;
  v_owner       uuid;
  v_role        uuid;
begin
  if v_caller is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not app.has_permission(p_org, 'member.manage') then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  select user_id into v_target_user
    from public.organization_members
   where id = p_member and organization_id = p_org and status = 'active';
  if v_target_user is null then
    raise exception 'member not found' using errcode = '22023';
  end if;

  select owner_user_id into v_owner from public.organizations where id = p_org;
  if v_target_user = v_owner then
    raise exception 'لا يمكن تغيير كلمة مرور مالك المنشأة من هنا' using errcode = '42501';
  end if;

  if exists (
    select 1 from public.user_roles ur
    join public.roles r on r.id = ur.role_id
    where ur.member_id = p_member and r.is_owner
  ) then
    raise exception 'لا يمكن تغيير كلمة مرور عضو يحمل دور المالك' using errcode = '42501';
  end if;

  if exists (select 1 from public.platform_admins pa where pa.user_id = v_target_user) then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  for v_role in
    select ur.role_id from public.user_roles ur where ur.member_id = p_member
  loop
    if not app.role_grantable(v_role) then
      raise exception 'لا يمكنك تغيير كلمة مرور عضو بصلاحيات أعلى من صلاحياتك' using errcode = '42501';
    end if;
  end loop;

  insert into public.audit_logs
    (organization_id, actor_id, actor_label, action, entity_type, entity_id, after)
  values
    (p_org, v_caller,
     (select p.full_name from public.profiles p where p.id = v_caller),
     'member.password_reset', 'organization_member', p_member::text,
     jsonb_build_object('target_user_id', v_target_user));

  return v_target_user;
end;
$$;

revoke all on function public.member_reset_password_authorize(uuid, uuid) from public, anon;
grant execute on function public.member_reset_password_authorize(uuid, uuid) to authenticated;
