-- =============================================================================
-- LOCAL BASIC — schema guards
--
-- Structural invariants that must hold for every table, now and for every
-- table added later. These fail the build rather than waiting to be noticed.
-- =============================================================================

\set ON_ERROR_STOP on

do $$
declare
  bad text;
begin
  -- 1. Every table in public has RLS enabled.
  select string_agg(c.relname, ', ') into bad
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
  assert bad is null, 'FAIL: tables without RLS enabled: ' || coalesce(bad, '');

  -- 2. Every table in public has RLS forced, so the table owner is bound by
  --    policies too and a mis-scoped connection cannot read everything.
  select string_agg(c.relname, ', ') into bad
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and not c.relforcerowsecurity;
  assert bad is null, 'FAIL: tables without FORCE RLS: ' || coalesce(bad, '');

  -- 3. Append-only tables must have no UPDATE or DELETE policy.
  select string_agg(distinct p.tablename, ', ') into bad
  from pg_policies p
  where p.schemaname = 'public'
    and p.tablename in ('payments', 'treasury_transactions', 'audit_logs')
    and p.cmd in ('UPDATE', 'DELETE', 'ALL');
  assert bad is null, 'FAIL: append-only tables carry write policies: ' || coalesce(bad, '');

  -- 4. No table that stores money may use a floating point column.
  select string_agg(c.table_name || '.' || c.column_name, ', ') into bad
  from information_schema.columns c
  where c.table_schema = 'public'
    and c.data_type in ('real', 'double precision')
    and (c.column_name like '%price%' or c.column_name like '%amount%'
      or c.column_name like '%total%' or c.column_name like '%cents%'
      or c.column_name like '%cost%');
  assert bad is null, 'FAIL: floating point used for money: ' || coalesce(bad, '');

  -- 5. Every tenant table carries organization_id, so RLS policies stay
  --    self-contained instead of reaching through joins.
  select string_agg(c.relname, ', ') into bad
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
    and c.relname not in (
      -- platform catalogs and child tables keyed through their parent
      'plans', 'permissions', 'profiles', 'roles', 'role_permissions', 'organizations',
      'user_roles', 'member_branches', 'invoice_items', 'document_counters',
      -- platform-operator tables: deliberately not tenant-scoped. They are
      -- reachable only by a Platform Admin, never through tenant RLS.
      'platform_admins', 'promo_codes'
    )
    and not exists (
      select 1 from information_schema.columns col
      where col.table_schema = 'public' and col.table_name = c.relname
        and col.column_name = 'organization_id'
    );
  assert bad is null, 'FAIL: tenant tables without organization_id: ' || coalesce(bad, '');

  -- 6. anon must hold no privilege on any tenant table. Public surfaces go
  --    through SECURITY DEFINER functions that return narrow projections.
  select string_agg(distinct table_name, ', ') into bad
  from information_schema.role_table_grants
  where grantee = 'anon' and table_schema = 'public' and table_name <> 'plans';
  assert bad is null, 'FAIL: anon holds privileges on tenant tables: ' || coalesce(bad, '');

  raise notice 'SCHEMA GUARDS: all assertions passed';
end $$;
