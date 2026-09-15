-- =============================================================================
-- LOCAL BASIC — local test harness
--
-- Recreates just enough of the Supabase platform (auth schema, auth.uid(),
-- the anon/authenticated/service_role roles) that the real migrations can run
-- against a plain PostgreSQL cluster in CI, unmodified.
--
-- This file is NEVER applied to a Supabase project — the platform provides
-- all of it there.
-- =============================================================================

create schema if not exists auth;

create table if not exists auth.users (
  id                    uuid primary key default gen_random_uuid(),
  email                 text unique,
  raw_user_meta_data    jsonb not null default '{}'::jsonb,
  created_at            timestamptz not null default now()
);

-- Mirrors Supabase's implementation: the user id comes from the verified JWT
-- claims that PostgREST sets on the connection, never from anything the client
-- can write to directly.
create or replace function auth.uid()
returns uuid language sql stable as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid;
$$;

create or replace function auth.role()
returns text language sql stable as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '')::text;
$$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end $$;

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role;
grant select on auth.users to authenticated, service_role;

-- Supabase's default: new public tables are reachable by these roles, with RLS
-- doing the actual gatekeeping. 0010_grants.sql then tightens this.
alter default privileges in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on sequences to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Test helpers: switch the acting identity inside a transaction.
--
-- set_config('role', …) is used rather than `SET LOCAL ROLE` because the
-- latter does not reliably propagate out of a PL/pgSQL function body, which
-- would silently run assertions as the table owner and defeat FORCE RLS.
-- ---------------------------------------------------------------------------
create or replace function auth.login_as(p_user uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user::text, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end;
$$;

create or replace function auth.logout()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', true);
  perform set_config('role', 'anon', true);
end;
$$;

-- Back to the superuser, for fixture setup that must bypass RLS.
create or replace function auth.as_admin()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', true);
  perform set_config('role', 'postgres', true);
end;
$$;
