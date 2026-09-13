-- =============================================================================
-- LOCAL BASIC — Tenant isolation test suite
--
-- The single most important test in the system:
--   Organization A must never read, write, or infer Organization B's data.
--
-- Run with:  psql -v ON_ERROR_STOP=1 -f supabase/tests/01_tenant_isolation.sql
-- Any failed assertion aborts with a non-zero exit code.
-- =============================================================================

\set ON_ERROR_STOP on

do $$
declare
  u_a       uuid;   -- owner of org A
  u_b       uuid;   -- owner of org B
  u_cashier uuid;   -- cashier in org A, scoped to branch 1 only
  org_a     uuid;  branch_a1 uuid;  branch_a2 uuid;
  org_b     uuid;  branch_b  uuid;
  cust_a    uuid;  cust_b    uuid;
  inv_a     uuid;
  acct_a    uuid;
  member_c  uuid;
  role_cashier uuid;
  role_foreign uuid;
  n         int;
  ok        boolean;
begin
  -- ==========================================================================
  -- Fixture
  -- ==========================================================================
  insert into auth.users (email) values ('owner-a@test.local') returning id into u_a;
  insert into auth.users (email) values ('owner-b@test.local') returning id into u_b;
  insert into auth.users (email) values ('cashier-a@test.local') returning id into u_cashier;

  perform auth.login_as(u_a);
  select out_organization_id, out_branch_id into org_a, branch_a1
    from public.provision_workspace('Alpha Store', 'alpha', 'retail', 'Main');
  perform auth.as_admin();

  perform auth.login_as(u_b);
  select out_organization_id, out_branch_id into org_b, branch_b
    from public.provision_workspace('Beta Store', 'beta', 'retail', 'Main');
  perform auth.as_admin();

  -- A second branch in org A, created by A's owner through normal RLS.
  perform auth.login_as(u_a);
  insert into public.branches (organization_id, slug, name)
  values (org_a, 'north', 'North') returning id into branch_a2;

  insert into public.customers (organization_id, branch_id, name, phone)
  values (org_a, branch_a1, 'Customer A', '0100000001') returning id into cust_a;

  select id into acct_a from public.treasury_accounts where branch_id = branch_a1;

  insert into public.invoices
    (organization_id, branch_id, number, customer_id, status, currency,
     subtotal_cents, total_cents, source)
  values (org_a, branch_a1, 'INV-000001', cust_a, 'issued', 'EGP', 10000, 10000, 'pos')
  returning id into inv_a;

  insert into public.payments
    (organization_id, branch_id, invoice_id, method, amount_cents, currency, treasury_account_id)
  values (org_a, branch_a1, inv_a, 'cash', 10000, 'EGP', acct_a);
  perform auth.as_admin();

  perform auth.login_as(u_b);
  insert into public.customers (organization_id, branch_id, name, phone)
  values (org_b, branch_b, 'Customer B', '0100000002') returning id into cust_b;
  perform auth.as_admin();

  -- ==========================================================================
  -- 1. Cross-tenant reads return nothing (not an error — simply invisible)
  -- ==========================================================================
  perform auth.login_as(u_b);

  select count(*) into n from public.organizations where id = org_a;
  assert n = 0, 'FAIL: B can see A''s organization';

  select count(*) into n from public.branches where organization_id = org_a;
  assert n = 0, 'FAIL: B can see A''s branches';

  select count(*) into n from public.customers where organization_id = org_a;
  assert n = 0, 'FAIL: B can see A''s customers';

  select count(*) into n from public.invoices where organization_id = org_a;
  assert n = 0, 'FAIL: B can see A''s invoices';

  select count(*) into n from public.payments where organization_id = org_a;
  assert n = 0, 'FAIL: B can see A''s payments';

  select count(*) into n from public.treasury_accounts where organization_id = org_a;
  assert n = 0, 'FAIL: B can see A''s treasury accounts';

  select count(*) into n from public.treasury_transactions where organization_id = org_a;
  assert n = 0, 'FAIL: B can see A''s treasury ledger';

  select count(*) into n from public.audit_logs where organization_id = org_a;
  assert n = 0, 'FAIL: B can read A''s audit log';

  select count(*) into n from public.organization_members where organization_id = org_a;
  assert n = 0, 'FAIL: B can enumerate A''s members';

  select count(*) into n from public.roles where organization_id = org_a;
  assert n = 0, 'FAIL: B can see A''s roles';

  select count(*) into n from public.settings where organization_id = org_a;
  assert n = 0, 'FAIL: B can read A''s settings';

  select count(*) into n from public.branding_settings where organization_id = org_a;
  assert n = 0, 'FAIL: B can read A''s branding';

  -- Direct id lookup — the IDOR case — is equally blind.
  select count(*) into n from public.invoices where id = inv_a;
  assert n = 0, 'FAIL: B can read A''s invoice by direct id (IDOR)';

  select count(*) into n from public.customers where id = cust_a;
  assert n = 0, 'FAIL: B can read A''s customer by direct id (IDOR)';

  -- ==========================================================================
  -- 2. Cross-tenant writes are rejected
  -- ==========================================================================
  begin
    insert into public.customers (organization_id, branch_id, name)
    values (org_a, branch_a1, 'Injected by B');
    assert false, 'FAIL: B inserted a customer into A''s organization';
  exception when insufficient_privilege or check_violation then null;
  end;

  begin
    insert into public.invoices
      (organization_id, branch_id, number, status, currency, total_cents)
    values (org_a, branch_a1, 'HACK-1', 'issued', 'EGP', 1);
    assert false, 'FAIL: B created an invoice in A''s branch';
  exception when insufficient_privilege or check_violation then null;
  end;

  -- Updating A's row is a silent no-op: the row is not visible to update.
  update public.customers set name = 'Tampered' where id = cust_a;
  get diagnostics n = row_count;
  assert n = 0, 'FAIL: B updated A''s customer';

  update public.organizations set name = 'Stolen' where id = org_a;
  get diagnostics n = row_count;
  assert n = 0, 'FAIL: B renamed A''s organization';

  -- Moving one's own row into another tenant must fail the WITH CHECK clause.
  begin
    update public.customers set organization_id = org_a where id = cust_b;
    get diagnostics n = row_count;
    assert n = 0, 'FAIL: B moved their customer into A''s organization';
  exception when insufficient_privilege or check_violation then null;
  end;

  perform auth.as_admin();

  -- ==========================================================================
  -- 3. Append-only ledgers cannot be rewritten, even by the owner
  -- ==========================================================================
  perform auth.login_as(u_a);

  begin
    update public.payments set amount_cents = 1 where invoice_id = inv_a;
    assert false, 'FAIL: payments are editable';
  exception when insufficient_privilege then null;
  end;

  begin
    delete from public.payments where invoice_id = inv_a;
    assert false, 'FAIL: payments are deletable';
  exception when insufficient_privilege then null;
  end;

  begin
    delete from public.invoices where id = inv_a;
    assert false, 'FAIL: invoices are deletable';
  exception when insufficient_privilege then null;
  end;

  begin
    update public.audit_logs set action = 'nothing.happened' where organization_id = org_a;
    assert false, 'FAIL: audit log is editable';
  exception when insufficient_privilege then null;
  end;

  begin
    delete from public.audit_logs where organization_id = org_a;
    assert false, 'FAIL: audit log is deletable';
  exception when insufficient_privilege then null;
  end;

  begin
    insert into public.audit_logs (organization_id, action, entity_type)
    values (org_a, 'forged.entry', 'test');
    assert false, 'FAIL: audit entries can be forged directly';
  exception when insufficient_privilege then null;
  end;

  -- The invoice payment state is maintained by the database, not the client.
  select (paid_cents = 10000 and status = 'paid') into ok
    from public.invoices where id = inv_a;
  assert ok, 'FAIL: invoice paid_cents/status not synced from the payment ledger';

  perform auth.as_admin();

  -- ==========================================================================
  -- 4. Branch scoping inside one organization
  -- ==========================================================================
  perform auth.login_as(u_a);

  insert into public.organization_members
    (organization_id, user_id, status, all_branches, joined_at)
  values (org_a, u_cashier, 'active', false, now())
  returning id into member_c;

  insert into public.member_branches (member_id, branch_id) values (member_c, branch_a1);

  select id into role_cashier from public.roles
   where organization_id = org_a and key = 'cashier';
  insert into public.user_roles (member_id, role_id, branch_id)
  values (member_c, role_cashier, branch_a1);

  perform auth.as_admin();

  perform auth.login_as(u_cashier);

  select count(*) into n from public.branches where id = branch_a1;
  assert n = 1, 'FAIL: scoped member cannot see their own branch';

  select count(*) into n from public.branches where id = branch_a2;
  assert n = 0, 'FAIL: branch-scoped member can see a branch they are not assigned to';

  -- Cashier holds invoice.read but only for branch_a1.
  select count(*) into n from public.invoices where id = inv_a;
  assert n = 1, 'FAIL: cashier cannot read an invoice in their own branch';

  -- Cashier lacks invoice.void / invoice.update → the update finds no row.
  update public.invoices set status = 'void', voided_at = now(), void_reason = 'x'
   where id = inv_a;
  get diagnostics n = row_count;
  assert n = 0, 'FAIL: cashier voided an invoice without invoice.update';

  -- Cashier lacks member.manage → cannot grant themselves a role.
  begin
    insert into public.user_roles (member_id, role_id)
    select member_c, id from public.roles where organization_id = org_a and key = 'admin';
    assert false, 'FAIL: privilege escalation — cashier granted themselves admin';
  exception when insufficient_privilege or check_violation then null;
  end;

  -- Cashier lacks treasury.manage → cannot open a treasury account.
  begin
    insert into public.treasury_accounts
      (organization_id, branch_id, name, type, currency)
    values (org_a, branch_a1, 'Rogue drawer', 'cash', 'EGP');
    assert false, 'FAIL: cashier created a treasury account without treasury.manage';
  exception when insufficient_privilege or check_violation then null;
  end;

  -- Cashier lacks audit.read.
  select count(*) into n from public.audit_logs where organization_id = org_a;
  assert n = 0, 'FAIL: cashier can read the audit log without audit.read';

  perform auth.as_admin();

  -- ==========================================================================
  -- 5. A role may never be granted across the tenant line
  --
  -- Two distinct layers are checked: RLS hides the foreign role entirely, and
  -- the database trigger rejects it even when the id is known.
  -- ==========================================================================
  perform auth.as_admin();
  select id into role_foreign from public.roles
   where organization_id = org_b and key = 'admin';
  assert role_foreign is not null, 'fixture: org B has no admin role';

  perform auth.login_as(u_a);

  -- Layer 1: A cannot even see org B's roles, so a lookup yields nothing.
  select count(*) into n from public.roles where id = role_foreign;
  assert n = 0, 'FAIL: A can see a role belonging to B';

  -- Layer 2: with the id supplied directly, the tenancy trigger rejects it.
  begin
    insert into public.user_roles (member_id, role_id) values (member_c, role_foreign);
    assert false, 'FAIL: a role from another organization was granted';
  exception when insufficient_privilege or check_violation then null;
  end;

  -- The same guard applies to branch scoping.
  begin
    insert into public.member_branches (member_id, branch_id) values (member_c, branch_b);
    assert false, 'FAIL: a member was scoped to another organization''s branch';
  exception when insufficient_privilege or check_violation then null;
  end;
  perform auth.as_admin();

    -- 6. Anonymous visitors reach no tenant table at all
  -- ==========================================================================
  perform auth.logout();
  begin
    select count(*) into n from public.organizations;
    assert false, 'FAIL: anon can query organizations';
  exception when insufficient_privilege then null;
  end;

  begin
    select count(*) into n from public.customers;
    assert false, 'FAIL: anon can query customers';
  exception when insufficient_privilege then null;
  end;

  begin
    select count(*) into n from public.public_links;
    assert false, 'FAIL: anon can query public_links and harvest tokens';
  exception when insufficient_privilege then null;
  end;
  perform auth.as_admin();

  raise notice 'TENANT ISOLATION: all assertions passed';
end $$;
