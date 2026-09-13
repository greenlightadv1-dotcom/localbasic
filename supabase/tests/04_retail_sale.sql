-- =============================================================================
-- LOCAL BASIC — Retail sale: financial integrity
--
--  * prices and totals come from the database, never from the caller
--  * a sale moves invoice, payment, stock and treasury together or not at all
--  * a sale that cannot be stocked leaves nothing behind
--  * discounts are a separate privilege from operating the till
-- =============================================================================

\set ON_ERROR_STOP on

do $$
declare
  u_owner uuid; u_cashier uuid;
  org uuid; branch uuid;
  prod uuid; variant uuid; variant2 uuid;
  member_c uuid; role_cashier uuid; acct uuid;
  cust uuid;
  inv uuid; num text; total bigint; paid bigint; change bigint;
  qty numeric; n int; bal bigint; ok boolean;
begin
  insert into auth.users (email) values ('sale-owner@test.local') returning id into u_owner;
  insert into auth.users (email) values ('sale-cashier@test.local') returning id into u_cashier;

  perform auth.login_as(u_owner);
  select out_organization_id, out_branch_id into org, branch
    from public.provision_workspace('Sale Store', 'salestore', 'retail', 'Main');
  perform auth.as_admin();

  perform auth.login_as(u_owner);
  -- 100.00 each, 14% VAT (1400 basis points)
  insert into public.retail_products (organization_id, name, tax_rate_bp)
  values (org, 'منتج', 1400) returning id into prod;
  insert into public.retail_variants (organization_id, product_id, price_cents, cost_cents)
  values (org, prod, 10000, 6000) returning id into variant;

  -- A second, tax-free product to check mixed baskets.
  insert into public.retail_products (organization_id, name, tax_rate_bp)
  values (org, 'منتج بدون ضريبة', 0) returning id into prod;
  insert into public.retail_variants (organization_id, product_id, price_cents)
  values (org, prod, 2500) returning id into variant2;

  insert into public.retail_stock_movements
    (organization_id, branch_id, variant_id, quantity_delta, reason)
  values (org, branch, variant, 20, 'initial'), (org, branch, variant2, 5, 'initial');

  insert into public.customers (organization_id, branch_id, name, phone)
  values (org, branch, 'عميل', '0111111111') returning id into cust;

  -- Cashier: scoped to this branch, with the cashier role only.
  insert into public.organization_members
    (organization_id, user_id, status, all_branches, joined_at)
  values (org, u_cashier, 'active', true, now()) returning id into member_c;
  select id into role_cashier from public.roles where organization_id = org and key = 'cashier';
  insert into public.user_roles (member_id, role_id) values (member_c, role_cashier);
  perform auth.as_admin();

  -- ==========================================================================
  -- 1. A straightforward sale, priced entirely by the database
  -- ==========================================================================
  perform auth.login_as(u_cashier);

  select out_invoice_id, out_invoice_number, out_total_cents, out_paid_cents, out_change_cents
    into inv, num, total, paid, change
  from public.retail_create_sale(
    org, branch,
    -- The caller deliberately sends a bogus price and tax; both must be ignored.
    ('[{"variant_id":"' || variant || '","quantity":2,"price_cents":1,"tax_rate_bp":0},
      {"variant_id":"' || variant2 || '","quantity":1}]')::jsonb,
    'cash', 25300, cust, 0, null);

  -- 2 × 10000 = 20000 (+14% = 2800), plus 2500 untaxed → 25300
  assert total = 25300, format('FAIL: expected total 25300, got %s', total);
  assert paid = 25300, format('FAIL: expected paid 25300, got %s', paid);
  assert change = 0, format('FAIL: exact tender should give no change, got %s', change);

  perform auth.as_admin();

  select (subtotal_cents = 22500 and tax_cents = 2800 and discount_cents = 0
          and total_cents = 25300 and paid_cents = 25300 and status = 'paid'
          and source = 'pos')
    into ok from public.invoices where id = inv;
  assert ok, 'FAIL: invoice totals or status are wrong';

  select count(*) into n from public.invoice_items where invoice_id = inv;
  assert n = 2, 'FAIL: expected 2 invoice lines';

  -- The line must record the real price, not the one the caller sent.
  select (unit_price_cents = 10000) into ok
    from public.invoice_items where invoice_id = inv and ref_id = variant;
  assert ok, 'FAIL: client-supplied price was trusted';

  -- Stock fell by exactly what was sold.
  select quantity into qty from public.retail_stock_levels
   where branch_id = branch and variant_id = variant;
  assert qty = 18, format('FAIL: expected stock 18, got %s', qty);

  select quantity into qty from public.retail_stock_levels
   where branch_id = branch and variant_id = variant2;
  assert qty = 4, format('FAIL: expected stock 4, got %s', qty);

  -- Payment and treasury both recorded, and they agree.
  select count(*) into n from public.payments where invoice_id = inv;
  assert n = 1, 'FAIL: expected exactly one payment';

  select id into acct from public.treasury_accounts where branch_id = branch and is_default;
  bal := public.treasury_account_balance(acct);
  assert bal = 25300, format('FAIL: treasury balance %s, expected 25300', bal);

  select count(*) into n from public.audit_logs
   where organization_id = org and action = 'retail.sale.completed';
  assert n = 1, 'FAIL: the sale was not audited';

  -- ==========================================================================
  -- 2. Cash tendered above the total produces change, not an overpayment
  -- ==========================================================================
  perform auth.login_as(u_cashier);
  select out_total_cents, out_paid_cents, out_change_cents into total, paid, change
  from public.retail_create_sale(
    org, branch, ('[{"variant_id":"' || variant2 || '","quantity":1}]')::jsonb,
    'cash', 5000, null, 0, null);

  assert total = 2500, format('FAIL: expected total 2500, got %s', total);
  assert paid = 2500, format('FAIL: payment should equal the sale, got %s', paid);
  assert change = 2500, format('FAIL: expected change 2500, got %s', change);
  perform auth.as_admin();

  -- ==========================================================================
  -- 2b. Tendering less than the total leaves the invoice partially paid
  -- ==========================================================================
  perform auth.login_as(u_cashier);
  select out_invoice_id, out_total_cents, out_paid_cents, out_change_cents
    into inv, total, paid, change
  from public.retail_create_sale(
    org, branch, ('[{"variant_id":"' || variant2 || '","quantity":1}]')::jsonb,
    'cash', 1000, cust, 0, null);
  assert total = 2500 and paid = 1000 and change = 0,
    format('FAIL: partial payment wrong: total=%s paid=%s change=%s', total, paid, change);
  perform auth.as_admin();

  select (status = 'partially_paid' and paid_cents = 1000) into ok
    from public.invoices where id = inv;
  assert ok, 'FAIL: invoice not marked partially paid from the payment ledger';

  -- ==========================================================================
  -- 3. A sale that cannot be stocked leaves nothing behind
  -- ==========================================================================
  select count(*) into n from public.invoices where organization_id = org;

  perform auth.login_as(u_cashier);
  begin
    perform public.retail_create_sale(
      org, branch, ('[{"variant_id":"' || variant || '","quantity":9999}]')::jsonb,
      'cash', 0, null, 0, null);
    assert false, 'FAIL: sold more stock than exists';
  exception when check_violation then null;
  end;
  perform auth.as_admin();

  select count(*) into qty from public.invoices where organization_id = org;
  assert qty = n, 'FAIL: a failed sale left an invoice behind';

  select quantity into qty from public.retail_stock_levels
   where branch_id = branch and variant_id = variant;
  assert qty = 18, format('FAIL: a failed sale changed stock, now %s', qty);

  -- ==========================================================================
  -- 4. Discounts are a separate privilege
  -- ==========================================================================
  perform auth.login_as(u_cashier);
  begin
    perform public.retail_create_sale(
      org, branch, ('[{"variant_id":"' || variant2 || '","quantity":1}]')::jsonb,
      'cash', 0, null, 1000, null);
    assert false, 'FAIL: cashier applied a discount without retail.pos.discount';
  exception when insufficient_privilege then null;
  end;
  perform auth.as_admin();

  -- The owner holds every permission, so the same sale succeeds.
  perform auth.login_as(u_owner);
  select out_total_cents into total
  from public.retail_create_sale(
    org, branch, ('[{"variant_id":"' || variant2 || '","quantity":1}]')::jsonb,
    'cash', 1500, null, 1000, null);
  assert total = 1500, format('FAIL: expected discounted total 1500, got %s', total);

  -- A discount larger than the basket is refused rather than producing a
  -- negative invoice.
  begin
    perform public.retail_create_sale(
      org, branch, ('[{"variant_id":"' || variant2 || '","quantity":1}]')::jsonb,
      'cash', 0, null, 999999, null);
    assert false, 'FAIL: a discount exceeding the sale was accepted';
  exception when check_violation then null;
  end;
  perform auth.as_admin();

  -- ==========================================================================
  -- 5. A sale cannot be pushed into another organization
  -- ==========================================================================
  perform auth.login_as(u_cashier);
  begin
    perform public.retail_create_sale(
      gen_random_uuid(), branch, ('[{"variant_id":"' || variant2 || '","quantity":1}]')::jsonb,
      'cash', 2500, null, 0, null);
    assert false, 'FAIL: a sale was accepted for a foreign organization';
  exception when insufficient_privilege or check_violation then null;
  end;
  perform auth.as_admin();

  raise notice 'RETAIL SALE: all assertions passed';
end $$;

-- =============================================================================
-- Returns
-- =============================================================================
do $$
declare
  u_owner uuid; u_cashier uuid;
  org uuid; branch uuid; prod uuid; variant uuid;
  member_c uuid; role_cashier uuid; acct uuid;
  inv uuid; total bigint; refund bigint; pay uuid;
  qty numeric; bal_before bigint; bal_after bigint; n int; ok boolean;
begin
  insert into auth.users (email) values ('ret-owner@test.local') returning id into u_owner;
  insert into auth.users (email) values ('ret-cashier@test.local') returning id into u_cashier;

  perform auth.login_as(u_owner);
  select out_organization_id, out_branch_id into org, branch
    from public.provision_workspace('Return Store', 'retstore', 'retail', 'Main');
  perform auth.as_admin();

  perform auth.login_as(u_owner);
  insert into public.retail_products (organization_id, name, tax_rate_bp)
  values (org, 'سلعة', 1000) returning id into prod;
  insert into public.retail_variants (organization_id, product_id, price_cents)
  values (org, prod, 10000) returning id into variant;
  insert into public.retail_stock_movements
    (organization_id, branch_id, variant_id, quantity_delta, reason)
  values (org, branch, variant, 10, 'initial');

  insert into public.organization_members
    (organization_id, user_id, status, all_branches, joined_at)
  values (org, u_cashier, 'active', true, now()) returning id into member_c;
  select id into role_cashier from public.roles where organization_id = org and key = 'cashier';
  insert into public.user_roles (member_id, role_id) values (member_c, role_cashier);

  -- Sell 3 units: 30000 + 10% tax = 33000
  select out_invoice_id, out_total_cents into inv, total
  from public.retail_create_sale(
    org, branch, ('[{"variant_id":"' || variant || '","quantity":3}]')::jsonb,
    'cash', 33000, null, 0, null);
  assert total = 33000, format('FAIL: expected 33000, got %s', total);
  perform auth.as_admin();

  select id into acct from public.treasury_accounts where branch_id = branch and is_default;
  bal_before := public.treasury_account_balance(acct);

  -- A cashier may not refund: the cashier template has no payment.refund.
  perform auth.login_as(u_cashier);
  begin
    perform public.retail_create_return(
      org, branch, inv, ('[{"variant_id":"' || variant || '","quantity":1}]')::jsonb, 'cash', 'تالف');
    assert false, 'FAIL: cashier refunded without payment.refund';
  exception when insufficient_privilege then null;
  end;
  perform auth.as_admin();

  -- The owner returns one unit: 11000 of the 33000.
  perform auth.login_as(u_owner);
  select out_refund_cents, out_payment_id into refund, pay
  from public.retail_create_return(
    org, branch, inv, ('[{"variant_id":"' || variant || '","quantity":1}]')::jsonb, 'cash', 'تالف');
  assert refund = 11000, format('FAIL: expected refund 11000, got %s', refund);
  perform auth.as_admin();

  -- Stock came back.
  select quantity into qty from public.retail_stock_levels
   where branch_id = branch and variant_id = variant;
  assert qty = 8, format('FAIL: expected stock 8 after return, got %s', qty);

  -- The refund is a linked negative payment; the original is untouched.
  select (amount_cents = -11000 and kind = 'refund' and refund_of_id is not null)
    into ok from public.payments where id = pay;
  assert ok, 'FAIL: refund not recorded as a linked negative payment';

  select count(*) into n from public.payments
   where invoice_id = inv and kind = 'payment' and amount_cents = 33000;
  assert n = 1, 'FAIL: the original payment was altered';

  -- Treasury went down by the refund.
  bal_after := public.treasury_account_balance(acct);
  assert bal_after = bal_before - 11000,
    format('FAIL: treasury %s, expected %s', bal_after, bal_before - 11000);

  -- Returning more than was sold is refused.
  perform auth.login_as(u_owner);
  begin
    perform public.retail_create_return(
      org, branch, inv, ('[{"variant_id":"' || variant || '","quantity":3}]')::jsonb, 'cash', null);
    assert false, 'FAIL: returned more than was sold';
  exception when check_violation then null;
  end;
  perform auth.as_admin();

  raise notice 'RETAIL RETURN: all assertions passed';
end $$;
