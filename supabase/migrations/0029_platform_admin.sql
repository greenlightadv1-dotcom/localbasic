-- =============================================================================
-- LOCAL BASIC — 0029 Platform Admin
--
-- A Platform Admin operates the SaaS itself: they see every organization, sell
-- and renew subscriptions, and provision workspaces for other people. They are
-- NOT a tenant role.
--
-- The separation is structural, not conventional:
--   * membership lives in its own table keyed by auth user, with no
--     organization_id and no relationship to roles/user_roles;
--   * the tenant RBAC catalog gains no permission that implies it, so no tenant
--     role — owner included — can ever be granted it;
--   * the table grants authenticated no INSERT/UPDATE/DELETE at all, so a
--     tenant user cannot mint a Platform Admin even if a policy is later added
--     by mistake. Membership changes go through the SECURITY DEFINER functions
--     below, which demand an existing Platform Admin.
--
-- Bootstrapping is deliberately out-of-band: the first row is inserted by the
-- operator with a privileged connection (service role or superuser). There is
-- no in-app path to create the first admin, because any such path would be a
-- privilege-escalation surface.
-- =============================================================================

create table public.platform_admins (
  user_id     uuid primary key references public.profiles(id) on delete cascade,
  -- 'owner' may manage other admins; 'staff' may operate but not grant.
  role        text not null default 'staff' check (role in ('owner', 'staff')),
  is_active   boolean not null default true,
  note        text,
  created_at  timestamptz not null default now(),
  created_by  uuid references public.profiles(id)
);
create index platform_admins_active_idx on public.platform_admins(user_id) where is_active;

-- ---------------------------------------------------------------------------
-- The gate. STABLE + SECURITY DEFINER so policies can call it without the
-- caller needing to read platform_admins themselves.
-- ---------------------------------------------------------------------------
create or replace function app.is_platform_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.platform_admins pa
    where pa.user_id = auth.uid() and pa.is_active
  );
$$;

create or replace function app.is_platform_owner()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.platform_admins pa
    where pa.user_id = auth.uid() and pa.is_active and pa.role = 'owner'
  );
$$;

-- Raises rather than returns, so every callable path fails closed.
create or replace function app.require_platform_admin()
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if not app.is_platform_admin() then
    raise exception 'platform administrator access required' using errcode = '42501';
  end if;
end;
$$;

alter table public.platform_admins enable row level security;
alter table public.platform_admins force row level security;

-- An admin may see the roster. Everyone else sees nothing — a tenant user
-- cannot even enumerate who operates the platform.
create policy platform_admins_read on public.platform_admins
  for select to authenticated using (app.is_platform_admin());

-- ---------------------------------------------------------------------------
-- Customer code — permanent, unique, human-quotable. LB-000125.
--
-- Its own sequence rather than a document_counter: those are per organization
-- and per document type, while this is one platform-wide series.
-- ---------------------------------------------------------------------------
create sequence if not exists public.customer_code_seq start 125;

alter table public.organizations
  add column if not exists customer_code text;

create or replace function app.assign_customer_code()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.customer_code is null then
    new.customer_code := 'LB-' || lpad(nextval('public.customer_code_seq')::text, 6, '0');
  end if;
  return new;
end;
$$;

create trigger organizations_assign_customer_code
  before insert on public.organizations
  for each row execute function app.assign_customer_code();

-- Backfill anything created before this migration, oldest first so the codes
-- follow the order the organizations were actually opened.
do $$
declare r record;
begin
  for r in select id from public.organizations where customer_code is null order by created_at loop
    update public.organizations
       set customer_code = 'LB-' || lpad(nextval('public.customer_code_seq')::text, 6, '0')
     where id = r.id;
  end loop;
end $$;

alter table public.organizations alter column customer_code set not null;
create unique index organizations_customer_code_key on public.organizations(customer_code);

-- Permanent means permanent: once issued the code never changes, so quoting it
-- in an invoice or a support thread stays meaningful forever.
create or replace function app.freeze_customer_code()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.customer_code is distinct from old.customer_code then
    raise exception 'customer_code is permanent and cannot be changed'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger organizations_freeze_customer_code
  before update on public.organizations
  for each row execute function app.freeze_customer_code();

-- ---------------------------------------------------------------------------
-- Platform reach over tenant tables.
--
-- Additive SELECT policies: PostgreSQL ORs permissive policies together, so
-- these widen read for Platform Admins without touching the tenant policies
-- that already exist. No write policy is added anywhere — platform writes go
-- through the SECURITY DEFINER functions in 0030/0031.
-- ---------------------------------------------------------------------------
create policy organizations_platform_read on public.organizations
  for select to authenticated using (app.is_platform_admin());

create policy subscriptions_platform_read on public.subscriptions
  for select to authenticated using (app.is_platform_admin());

create policy branches_platform_read on public.branches
  for select to authenticated using (app.is_platform_admin());

create policy organization_members_platform_read on public.organization_members
  for select to authenticated using (app.is_platform_admin());

create policy organization_modules_platform_read on public.organization_modules
  for select to authenticated using (app.is_platform_admin());

create policy audit_logs_platform_read on public.audit_logs
  for select to authenticated using (app.is_platform_admin());

-- ---------------------------------------------------------------------------
-- Grants. No DML for authenticated: the roster is function-managed only.
-- ---------------------------------------------------------------------------
revoke all on public.platform_admins from anon, authenticated;
grant select on public.platform_admins to authenticated;
revoke all on sequence public.customer_code_seq from anon, authenticated;

-- The RLS policies above call these as the invoking user, so `authenticated`
-- needs EXECUTE. That is not a weakness: each answers only about the caller's
-- own auth.uid(), so a tenant user can learn "am I an admin" (no) and nothing
-- else. anon is refused outright — it has no session to ask about.
revoke all on function app.is_platform_admin()      from public, anon;
revoke all on function app.is_platform_owner()      from public, anon;
revoke all on function app.require_platform_admin() from public, anon;
grant execute on function app.is_platform_admin()      to authenticated;
grant execute on function app.is_platform_owner()      to authenticated;
grant execute on function app.require_platform_admin() to authenticated;
