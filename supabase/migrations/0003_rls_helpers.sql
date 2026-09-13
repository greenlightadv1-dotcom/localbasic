-- =============================================================================
-- LOCAL BASIC — 0003 RLS helper functions
--
-- Every helper is SECURITY DEFINER (so it can read membership tables without
-- recursing through their own RLS policies), STABLE, and pinned to an empty
-- search_path. They are the single source of truth every policy calls.
-- =============================================================================

-- Active membership in an organization.
create or replace function app.is_member_of(org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.organization_members m
    where m.organization_id = org
      and m.user_id = auth.uid()
      and m.status = 'active'
  );
$$;

-- The caller's member id for an organization (null when not a member).
create or replace function app.member_id(org uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select m.id from public.organization_members m
  where m.organization_id = org
    and m.user_id = auth.uid()
    and m.status = 'active'
  limit 1;
$$;

-- Can the caller reach this branch at all? (membership + branch scope)
--
-- Takes the organization id explicitly and never reads public.branches. That
-- matters: a policy that re-reads the table it guards cannot see the row being
-- inserted, so INSERT ... RETURNING would fail its own SELECT policy.
create or replace function app.can_access_branch(p_org uuid, p_branch uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.organization_members m
    where m.organization_id = p_org
      and m.user_id = auth.uid()
      and m.status = 'active'
      and (
        m.all_branches
        or exists (
          select 1 from public.member_branches mb
          where mb.member_id = m.id and mb.branch_id = p_branch
        )
      )
  );
$$;

-- Does the caller hold a permission anywhere in the organization?
-- Use for org-level objects (settings, branding, members, roles).
create or replace function app.has_permission(org uuid, perm text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.organization_members m
    join public.user_roles ur       on ur.member_id = m.id
    join public.role_permissions rp on rp.role_id = ur.role_id
    where m.organization_id = org
      and m.user_id = auth.uid()
      and m.status = 'active'
      and rp.permission_key = perm
  );
$$;

-- Does the caller hold a permission FOR THIS BRANCH?
--
-- Combines active membership, branch scope, and either an organization-wide
-- grant (user_roles.branch_id is null) or a grant on this exact branch. This is
-- the workhorse behind nearly every operational policy. Like can_access_branch
-- it takes the organization id rather than deriving it, so it stays safe inside
-- INSERT ... RETURNING and avoids a join on every row.
create or replace function app.has_branch_permission(p_org uuid, p_branch uuid, p_perm text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.organization_members m
    join public.user_roles ur
      on ur.member_id = m.id
     and (ur.branch_id is null or ur.branch_id = p_branch)
    join public.role_permissions rp
      on rp.role_id = ur.role_id
     and rp.permission_key = p_perm
    where m.organization_id = p_org
      and m.user_id = auth.uid()
      and m.status = 'active'
      and (
        m.all_branches
        or exists (
          select 1 from public.member_branches mb
          where mb.member_id = m.id and mb.branch_id = p_branch
        )
      )
  );
$$;

-- Is the caller the owner of this organization?
create or replace function app.is_owner(org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.organization_members m
    join public.user_roles ur on ur.member_id = m.id
    join public.roles r       on r.id = ur.role_id and r.is_owner
    where m.organization_id = org
      and m.user_id = auth.uid()
      and m.status = 'active'
  );
$$;

-- Every branch id the caller can reach in an organization. Used by services
-- to build "all my branches" queries without leaking ids from other orgs.
create or replace function app.accessible_branch_ids(org uuid)
returns setof uuid language sql stable security definer set search_path = '' as $$
  select b.id
  from public.branches b
  join public.organization_members m
    on m.organization_id = b.organization_id
   and m.user_id = auth.uid()
   and m.status = 'active'
  where b.organization_id = org
    and b.deleted_at is null
    and (
      m.all_branches
      or exists (
        select 1 from public.member_branches mb
        where mb.member_id = m.id and mb.branch_id = b.id
      )
    );
$$;

grant execute on function
  app.is_member_of(uuid),
  app.member_id(uuid),
  app.can_access_branch(uuid, uuid),
  app.has_permission(uuid, text),
  app.has_branch_permission(uuid, uuid, text),
  app.is_owner(uuid),
  app.accessible_branch_ids(uuid)
to authenticated;
