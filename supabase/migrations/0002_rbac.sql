-- =============================================================================
-- LOCAL BASIC — 0002 RBAC
-- permissions catalog, roles, role_permissions, user_roles
-- =============================================================================

-- ---------------------------------------------------------------------------
-- permissions — global catalog of permission keys. Seeded, never tenant-owned.
-- ---------------------------------------------------------------------------
create table public.permissions (
  key          text primary key check (key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  group_key    text not null,
  module_key   text,           -- null = Core permission, else the owning vertical
  description  text not null,
  -- Permissions that can hand out other permissions. Only Owner/Admin may hold
  -- these, and granting them is checked separately in the service layer.
  is_elevated  boolean not null default false,
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- roles — organization_id NULL = platform template, cloned at provisioning
-- ---------------------------------------------------------------------------
create table public.roles (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid references public.organizations(id) on delete cascade,
  key              text not null check (key ~ '^[a-z][a-z0-9_]*$'),
  name_ar          text not null,
  name_en          text not null,
  description      text,
  -- System roles are cloned from templates and cannot be deleted or renamed by
  -- tenants; their permission set can still be edited (except owner).
  is_system        boolean not null default false,
  -- The single role that always retains every permission. Exactly one per org.
  is_owner         boolean not null default false,
  -- Template rows describe which module they belong to (null = Core, all orgs).
  module_key       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
-- Unique per org; templates (organization_id is null) are unique by key+module.
create unique index roles_org_key_unique
  on public.roles(organization_id, key) where organization_id is not null;
create unique index roles_template_key_unique
  on public.roles(key, coalesce(module_key, '')) where organization_id is null;
create unique index roles_one_owner_per_org
  on public.roles(organization_id) where is_owner and organization_id is not null;
create trigger roles_touch before update on public.roles
  for each row execute function app.touch_updated_at();

create table public.role_permissions (
  role_id        uuid not null references public.roles(id) on delete cascade,
  permission_key text not null references public.permissions(key) on delete cascade,
  created_at     timestamptz not null default now(),
  primary key (role_id, permission_key)
);
create index role_permissions_perm_idx on public.role_permissions(permission_key);

-- ---------------------------------------------------------------------------
-- user_roles — grant a role to a member, optionally scoped to one branch
-- branch_id NULL = the grant applies across every branch the member can reach.
-- ---------------------------------------------------------------------------
create table public.user_roles (
  id          uuid primary key default gen_random_uuid(),
  member_id   uuid not null references public.organization_members(id) on delete cascade,
  role_id     uuid not null references public.roles(id) on delete cascade,
  branch_id   uuid references public.branches(id) on delete cascade,
  granted_by  uuid references public.profiles(id),
  created_at  timestamptz not null default now()
);
create unique index user_roles_unique
  on public.user_roles(member_id, role_id, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index user_roles_member_idx on public.user_roles(member_id);
create index user_roles_role_idx on public.user_roles(role_id);

-- ---------------------------------------------------------------------------
-- A role must belong to the same organization as the member it is granted to,
-- and a branch-scoped grant must point at a branch of that same organization.
-- Enforced in the database so no service-layer bug can cross the tenant line.
-- ---------------------------------------------------------------------------
create or replace function app.check_user_role_tenancy()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  member_org uuid;
  role_org   uuid;
  branch_org uuid;
begin
  select organization_id into member_org
    from public.organization_members where id = new.member_id;
  select organization_id into role_org
    from public.roles where id = new.role_id;

  if role_org is null or role_org <> member_org then
    raise exception 'role % does not belong to organization %', new.role_id, member_org
      using errcode = 'check_violation';
  end if;

  if new.branch_id is not null then
    select organization_id into branch_org
      from public.branches where id = new.branch_id;
    if branch_org is distinct from member_org then
      raise exception 'branch % does not belong to organization %', new.branch_id, member_org
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

create trigger user_roles_tenancy_check
  before insert or update on public.user_roles
  for each row execute function app.check_user_role_tenancy();

-- Same guard for branch scoping: a member may only be scoped to branches of
-- their own organization.
create or replace function app.check_member_branch_tenancy()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  member_org uuid;
  branch_org uuid;
begin
  select organization_id into member_org
    from public.organization_members where id = new.member_id;
  select organization_id into branch_org
    from public.branches where id = new.branch_id;
  if member_org is distinct from branch_org then
    raise exception 'branch % does not belong to organization %', new.branch_id, member_org
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger member_branches_tenancy_check
  before insert or update on public.member_branches
  for each row execute function app.check_member_branch_tenancy();
