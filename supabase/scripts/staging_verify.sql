-- =============================================================================
-- LOCAL BASIC — staging verification
--
-- Run against a FRESHLY MIGRATED, DEDICATED staging project, after
-- `supabase db push` and before any smoke test. Read-only: it inspects the
-- catalog and changes nothing.
--
--   psql "$STAGING_DATABASE_URL" -f supabase/scripts/staging_verify.sql
--
-- Every check raises on failure, so a clean run means every line passed. A
-- database that fails any of these is not representing production and a
-- payment smoke test against it proves nothing.
--
-- NEVER run this against a project holding real tenant data. It is harmless
-- to run, but its purpose is to gate a database that is about to be seeded
-- with throwaway data.
-- =============================================================================

\set ON_ERROR_STOP on

do $$
declare
  v_tables       int;
  v_no_rls       text;
  v_ledger_grant text;
  v_missing_fn   text;
  v_n            int;
begin
  -- 1 ── Expected table count -------------------------------------------------
  select count(*) into v_tables
    from information_schema.tables
   where table_schema = 'public' and table_type = 'BASE TABLE';

  if v_tables <> 66 then
    raise exception 'TABLE COUNT: expected 66, found %. Migrations are incomplete or a migration failed.', v_tables;
  end if;
  raise notice 'OK 1  table count = 66';

  -- 2 ── RLS enabled AND forced on every public table -------------------------
  -- FORCE matters: without it the table owner bypasses every policy, and the
  -- owner is who the migrations and any definer function run as.
  select string_agg(c.relname || case
           when not c.relrowsecurity then ' (rls off)'
           else ' (not forced)' end, ', ' order by c.relname)
    into v_no_rls
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
     and (not c.relrowsecurity or not c.relforcerowsecurity);

  if v_no_rls is not null then
    raise exception 'RLS: these tables are unprotected -> %', v_no_rls;
  end if;
  raise notice 'OK 2  RLS enabled AND forced on every public table';

  -- 3 ── RBAC catalog present and populated -----------------------------------
  select count(*) into v_n from public.permissions;
  if v_n < 50 then
    raise exception 'RBAC: permission catalog has only % rows; expected the full catalog', v_n;
  end if;
  raise notice 'OK 3a permission catalog = % rows', v_n;

  select count(*) into v_n from pg_policies where schemaname = 'public';
  if v_n < 100 then
    raise exception 'RBAC: only % policies in public; the policy set did not apply', v_n;
  end if;
  raise notice 'OK 3b RLS policies in public = %', v_n;

  -- The CATALOG of permissions is platform-owned and must be read-only to
  -- tenants. `role_permissions` is deliberately writable: every organization
  -- gets its own cloned roles and may customise them. What stops a member
  -- granting themselves anything is the RLS policy from 0053, checked below,
  -- not a missing grant.
  select string_agg(table_name || ':' || privilege_type, ', ')
    into v_ledger_grant
    from information_schema.table_privileges
   where grantee = 'authenticated'
     and table_name = 'permissions'
     and privilege_type in ('INSERT', 'UPDATE', 'DELETE');
  if v_ledger_grant is not null then
    raise exception 'RBAC: authenticated can write the permission catalog -> %', v_ledger_grant;
  end if;
  raise notice 'OK 3c permission catalog is read-only to tenants';

  -- 4 ── Append-only ledgers --------------------------------------------------
  -- Money is corrected by writing a compensating row, never by editing one.
  select string_agg(table_name || ':' || privilege_type, ', ' order by table_name)
    into v_ledger_grant
    from information_schema.table_privileges
   where grantee = 'authenticated'
     and table_name in ('payments', 'treasury_transactions', 'retail_stock_movements', 'audit_logs')
     and privilege_type in ('UPDATE', 'DELETE');

  if v_ledger_grant is not null then
    raise exception 'APPEND-ONLY: ledger is mutable -> %', v_ledger_grant;
  end if;
  raise notice 'OK 4  payments / treasury / stock movements / audit_logs grant no UPDATE or DELETE';

  -- 5 ── restaurant_pay_order exists ------------------------------------------
  if to_regprocedure('public.restaurant_pay_order(uuid,uuid,uuid,text,bigint,text)') is null
     and not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                      where n.nspname = 'public' and p.proname = 'restaurant_pay_order') then
    raise exception 'PAYMENT: restaurant_pay_order() is missing';
  end if;
  raise notice 'OK 5  restaurant_pay_order() present';

  -- 6 ── Migration 0053: RBAC escalation guards -------------------------------
  -- Functions, policies and triggers — none of which a table listing can see.
  -- 0053 closed four routes to granting yourself all 53 permissions.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app' and p.proname = 'role_grantable'
  ) then
    raise exception '0053: app.role_grantable() is missing — the escalation guards did not apply';
  end if;

  select string_agg(policyname, ', ' order by policyname) into v_missing_fn
    from pg_policies
   where schemaname = 'public'
     and policyname in ('role_permissions_write', 'user_roles_write');
  if v_missing_fn is distinct from 'role_permissions_write, user_roles_write' then
    raise exception '0053: expected both escalation policies, found: %', coalesce(v_missing_fn, '(none)');
  end if;

  select string_agg(t.tgname, ', ' order by t.tgname) into v_missing_fn
    from pg_trigger t
   where not t.tgisinternal
     and t.tgname in ('invitations_check_roles', 'organizations_freeze_owner');
  if v_missing_fn is distinct from 'invitations_check_roles, organizations_freeze_owner' then
    raise exception '0053: expected both guard triggers, found: %', coalesce(v_missing_fn, '(none)');
  end if;
  raise notice 'OK 6  0053 present: app.role_grantable(), both write policies, both guard triggers';

  -- 7 ── Migration 0054: payment lock -----------------------------------------
  -- The lock that stops two cashiers taking the same payment twice. Detected
  -- by the FOR UPDATE in the function body, which is what 0054 added.
  -- Asserted over EVERY overload, not just one. An `exists` test passes as
  -- soon as a single locked version is found, so a stray unlocked overload —
  -- which is what a half-applied migration leaves behind — would sail through.
  select string_agg(p.oid::regprocedure::text, ', ') into v_missing_fn
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'restaurant_pay_order'
     and pg_get_functiondef(p.oid) not ilike '%for update%';

  if v_missing_fn is not null then
    raise exception '0054: restaurant_pay_order has an overload with no row lock -> %. DOUBLE PAYMENT IS POSSIBLE. Do not run a payment smoke test against this database.', v_missing_fn;
  end if;
  raise notice 'OK 7  0054 payment lock present on every restaurant_pay_order overload';

  -- 8 ── No production tenant data --------------------------------------------
  select count(*) into v_n from public.organizations;
  raise notice 'INFO  organizations present = % (expect 0 before seeding, 1 after)', v_n;

  raise notice '';
  raise notice 'STAGING VERIFICATION: all checks passed';
end $$;
