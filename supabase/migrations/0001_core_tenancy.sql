-- =============================================================================
-- LOCAL BASIC — 0001 Core tenancy
-- profiles, organizations, branches, members, branch scoping, org modules
-- =============================================================================

create extension if not exists pgcrypto;
create extension if not exists citext;

-- Private schema for security helpers. Not exposed through PostgREST, so these
-- SECURITY DEFINER functions can never be called directly as RPCs by a client.
create schema if not exists app;
revoke all on schema app from public;
grant usage on schema app to authenticated, anon, service_role;

-- ---------------------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------------------
create or replace function app.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- profiles — one row per auth user
-- ---------------------------------------------------------------------------
create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text,
  phone       text,
  avatar_url  text,
  locale      text not null default 'ar' check (locale in ('ar', 'en')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create trigger profiles_touch before update on public.profiles
  for each row execute function app.touch_updated_at();

-- Auto-create the profile when an auth user is created.
create or replace function app.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, full_name, phone)
  values (
    new.id,
    nullif(new.raw_user_meta_data ->> 'full_name', ''),
    nullif(new.raw_user_meta_data ->> 'phone', '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function app.handle_new_user();

-- ---------------------------------------------------------------------------
-- organizations — the tenant
-- ---------------------------------------------------------------------------
create table public.organizations (
  id                uuid primary key default gen_random_uuid(),
  slug              citext not null unique check (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])$'),
  name              text not null check (length(trim(name)) between 2 and 120),
  -- Convenience pointer to the org's main module. The authoritative list of
  -- enabled verticals is organization_modules, so multi-vertical orgs need no
  -- schema change — only an extra row.
  primary_module    text not null,
  status            text not null default 'active'
                    check (status in ('active', 'suspended', 'cancelled')),
  country           text not null default 'EG',
  currency          char(3) not null default 'EGP',
  timezone          text not null default 'Africa/Cairo',
  default_locale    text not null default 'ar' check (default_locale in ('ar', 'en')),
  owner_user_id     uuid not null references public.profiles(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz
);
create index organizations_owner_idx on public.organizations(owner_user_id);
create trigger organizations_touch before update on public.organizations
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- organization_modules — which verticals this org has enabled
-- ---------------------------------------------------------------------------
create table public.organization_modules (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  module_key       text not null check (module_key in ('retail','restaurant','medical','workshop')),
  is_primary       boolean not null default false,
  enabled          boolean not null default true,
  settings         jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (organization_id, module_key)
);
-- At most one primary module per organization.
create unique index organization_modules_one_primary
  on public.organization_modules(organization_id) where is_primary;
create trigger organization_modules_touch before update on public.organization_modules
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- branches
-- ---------------------------------------------------------------------------
create table public.branches (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  slug             citext not null check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])$'),
  name             text not null check (length(trim(name)) between 1 and 120),
  address          text,
  phone            text,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz,
  unique (organization_id, slug)
);
create index branches_org_idx on public.branches(organization_id) where deleted_at is null;
create trigger branches_touch before update on public.branches
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- organization_members — membership + branch scope
-- ---------------------------------------------------------------------------
create table public.organization_members (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  user_id          uuid not null references public.profiles(id) on delete cascade,
  status           text not null default 'active'
                   check (status in ('active', 'invited', 'suspended')),
  -- true  → member reaches every branch of the org
  -- false → member reaches only the branches listed in member_branches
  all_branches     boolean not null default false,
  invited_by       uuid references public.profiles(id),
  invited_at       timestamptz,
  joined_at        timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (organization_id, user_id)
);
create index organization_members_user_idx on public.organization_members(user_id, status);
create trigger organization_members_touch before update on public.organization_members
  for each row execute function app.touch_updated_at();

create table public.member_branches (
  member_id  uuid not null references public.organization_members(id) on delete cascade,
  branch_id  uuid not null references public.branches(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (member_id, branch_id)
);
create index member_branches_branch_idx on public.member_branches(branch_id);

-- ---------------------------------------------------------------------------
-- invitations — email-token based, single use, expiring
-- ---------------------------------------------------------------------------
create table public.invitations (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  email            citext not null,
  token_hash       text not null unique,
  role_ids         uuid[] not null default '{}',
  branch_ids       uuid[] not null default '{}',
  all_branches     boolean not null default false,
  invited_by       uuid not null references public.profiles(id),
  expires_at       timestamptz not null,
  accepted_at      timestamptz,
  revoked_at       timestamptz,
  created_at       timestamptz not null default now()
);
create index invitations_org_idx on public.invitations(organization_id);
create unique index invitations_pending_unique
  on public.invitations(organization_id, email)
  where accepted_at is null and revoked_at is null;
