-- =============================================================================
-- LOCAL BASIC — 0048 Managing the Platform Admin roster
--
-- WHY THIS EXISTS. /admin/customers — and every other /admin surface — renders
-- the 404 page for anyone who is not in `platform_admins`. That gate is
-- correct and stays. What was missing is everything around it:
--
--   * no migration and no seed ever inserts a row into `platform_admins`, so a
--     freshly migrated production database has an EMPTY roster and the console
--     is unreachable by every user including the platform's own owner;
--
--   * 0029 gave the table a SELECT policy and nothing else — no insert, no
--     update, no delete, and no function — so even after the first admin is
--     installed out-of-band, admins could not add or remove each other. The
--     documentation said they could. That was not true.
--
-- The end-to-end tests never caught either gap because they insert into
-- `platform_admins` directly, over a privileged connection, exactly as the
-- out-of-band bootstrap does.
--
-- WHAT IS NOT CHANGED. The FIRST admin is still created out-of-band, and that
-- decision is deliberate: a self-service "make me the platform owner" path on
-- an empty roster is a privilege-escalation surface, and an empty roster is
-- precisely the state a new deployment is in. Everything after the first admin
-- now happens in the product, through an owner who already holds the role.
--
-- Everything additive.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Is the caller an OWNER, not merely an admin?
--
-- 0029 distinguishes 'owner' from 'staff' and says an owner "may manage other
-- admins" — until now nothing enforced it, because nothing could manage them
-- at all. This is where that sentence becomes true.
-- ---------------------------------------------------------------------------
create or replace function app.is_platform_owner()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.platform_admins a
     where a.user_id = auth.uid() and a.is_active and a.role = 'owner'
  );
$$;

create or replace function app.require_platform_owner()
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if not app.is_platform_owner() then
    raise exception 'platform owner access required' using errcode = '42501';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. The roster.
--
-- Readable by any platform admin — staff can see who else operates the
-- platform, which is what makes the screen useful to them even though they
-- cannot change it. Emails come from auth.users, which is why this is
-- SECURITY DEFINER rather than a view over a policy.
-- ---------------------------------------------------------------------------
create or replace function public.platform_admin_list()
returns table (
  out_user_id   uuid,
  out_email     text,
  out_full_name text,
  out_role      text,
  out_is_active boolean,
  out_note      text,
  out_created_at timestamptz
)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_platform_admin();

  return query
  select a.user_id, u.email::text, p.full_name, a.role, a.is_active, a.note, a.created_at
    from public.platform_admins a
    join auth.users u on u.id = a.user_id
    left join public.profiles p on p.id = a.user_id
   order by a.is_active desc, a.role, u.email;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Grant.
--
-- By email, because that is what an operator knows about a colleague. The
-- person must already have signed in at least once: this promotes an existing
-- identity, it does not mint one, so there is no path here to create an
-- account that did not exist.
-- ---------------------------------------------------------------------------
create or replace function public.platform_admin_grant(
  p_email text,
  p_role  text default 'staff',
  p_note  text default null
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid;
begin
  perform app.require_platform_owner();

  if p_role not in ('owner', 'staff') then
    raise exception 'unknown platform role %', p_role using errcode = '22023';
  end if;

  select u.id into v_user
    from auth.users u
   where lower(u.email::text) = lower(trim(p_email));

  if v_user is null then
    raise exception 'no account exists for that email' using errcode = 'check_violation';
  end if;

  -- A profile row is the foreign key's target; a user who has signed in has
  -- one, but a user created by the Admin API may not yet.
  insert into public.profiles (id) values (v_user) on conflict (id) do nothing;

  -- Re-granting a revoked admin reactivates them rather than failing, which is
  -- what "add them back" means to the person clicking it.
  insert into public.platform_admins (user_id, role, is_active, note, created_by)
  values (v_user, p_role, true, p_note, auth.uid())
  on conflict (user_id) do update
     set role = excluded.role, is_active = true, note = coalesce(excluded.note, public.platform_admins.note);

  perform public.write_platform_audit(
    'platform.admin.granted', 'platform_admin', v_user::text,
    -- The email is the operator's own record of who they added. No credential
    -- of any kind travels here.
    jsonb_build_object('email', lower(trim(p_email)), 'role', p_role));

  return v_user;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Revoke.
--
-- Deactivates rather than deletes, so the audit trail still resolves who did
-- what. Two refusals, both about not locking everyone out:
--   * an owner cannot revoke themselves — a slip should not end the session
--     that could undo it;
--   * the last active owner cannot be removed at all, because an empty roster
--     puts the console back in exactly the unreachable state this migration
--     exists to fix.
-- ---------------------------------------------------------------------------
create or replace function public.platform_admin_revoke(p_user_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_row    record;
  v_owners int;
begin
  perform app.require_platform_owner();

  if p_user_id = auth.uid() then
    raise exception 'you cannot revoke your own platform access'
      using errcode = 'check_violation';
  end if;

  select * into v_row from public.platform_admins where user_id = p_user_id;
  if v_row.user_id is null then
    raise exception 'not a platform administrator' using errcode = 'check_violation';
  end if;

  if v_row.role = 'owner' and v_row.is_active then
    select count(*) into v_owners from public.platform_admins
     where role = 'owner' and is_active;
    if v_owners <= 1 then
      raise exception 'the last platform owner cannot be removed'
        using errcode = 'check_violation';
    end if;
  end if;

  update public.platform_admins set is_active = false where user_id = p_user_id;

  perform public.write_platform_audit(
    'platform.admin.revoked', 'platform_admin', p_user_id::text,
    jsonb_build_object('role', v_row.role));
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Grants.
--
-- PostgreSQL grants EXECUTE to PUBLIC on creation, so every revoke comes
-- before its grant — the lesson of 0028. The functions are reachable by
-- `authenticated` and refuse internally, which is the same shape every other
-- platform function uses: the check is in one place and it is audited.
--
-- The table itself gains no write policy. Writes stay in these functions.
-- ---------------------------------------------------------------------------
revoke all on function app.is_platform_owner()      from public, anon, authenticated;
revoke all on function app.require_platform_owner() from public, anon, authenticated;

do $$
declare fn text;
begin
  foreach fn in array array[
    'public.platform_admin_list()',
    'public.platform_admin_grant(text, text, text)',
    'public.platform_admin_revoke(uuid)'
  ]
  loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end $$;
