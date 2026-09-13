-- =============================================================================
-- LOCAL BASIC — permission catalog consistency
--
-- The TypeScript `Permission` union and the seeded `permissions` table must
-- agree. If they drift, `requirePermission(ctx, 'x')` type-checks against a key
-- no role can ever hold, and the check silently never passes.
--
-- The expected list below is generated from src/modules/core/rbac/permissions.ts
-- by scripts/check-permissions.mjs, which fails CI on any mismatch. This test
-- covers the database side: no orphans, and every role template grants only
-- keys that exist.
-- =============================================================================

\set ON_ERROR_STOP on

do $$
declare bad text;
begin
  -- Every granted permission exists in the catalog. The FK guarantees this, so
  -- a failure here means the FK was dropped.
  select string_agg(distinct rp.permission_key, ', ') into bad
  from public.role_permissions rp
  left join public.permissions p on p.key = rp.permission_key
  where p.key is null;
  assert bad is null, 'FAIL: role grants reference unknown permissions: ' || coalesce(bad, '');

  -- Every module permission names a module that exists in organization_modules'
  -- allowed set.
  select string_agg(distinct p.module_key, ', ') into bad
  from public.permissions p
  where p.module_key is not null
    and p.module_key not in ('retail', 'restaurant', 'medical', 'workshop');
  assert bad is null, 'FAIL: permissions reference unknown modules: ' || coalesce(bad, '');

  -- Owner templates are never given a partial set: the owner role receives the
  -- whole catalog at provisioning, so any organization owner missing a key
  -- means a migration added a permission without back-filling.
  select string_agg(o.slug::text, ', ') into bad
  from public.organizations o
  join public.roles r on r.organization_id = o.id and r.is_owner
  where exists (
    select 1 from public.permissions p
    where not exists (
      select 1 from public.role_permissions rp
      where rp.role_id = r.id and rp.permission_key = p.key
    )
  );
  assert bad is null, 'FAIL: owner roles missing permissions in: ' || coalesce(bad, '');

  -- The kitchen template must never carry financial or staff permissions.
  select string_agg(rp.permission_key, ', ') into bad
  from public.roles r
  join public.role_permissions rp on rp.role_id = r.id
  where r.key = 'kitchen' and r.organization_id is null
    and (rp.permission_key like 'invoice.%'
      or rp.permission_key like 'payment.%'
      or rp.permission_key like 'treasury.%'
      or rp.permission_key like 'member.%'
      or rp.permission_key like 'role.%'
      or rp.permission_key = 'report.read'
      or rp.permission_key = 'audit.read');
  assert bad is null, 'FAIL: the kitchen template holds sensitive permissions: ' || coalesce(bad, '');

  -- Same for the waiter template.
  select string_agg(rp.permission_key, ', ') into bad
  from public.roles r
  join public.role_permissions rp on rp.role_id = r.id
  where r.key = 'waiter' and r.organization_id is null
    and (rp.permission_key like 'invoice.%'
      or rp.permission_key like 'payment.%'
      or rp.permission_key like 'treasury.%'
      or rp.permission_key like 'member.%'
      or rp.permission_key like 'role.%');
  assert bad is null, 'FAIL: the waiter template holds financial permissions: ' || coalesce(bad, '');

  raise notice 'PERMISSION CATALOG: all assertions passed';
end $$;
