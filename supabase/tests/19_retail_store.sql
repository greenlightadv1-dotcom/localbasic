-- =============================================================================
-- LOCAL BASIC — Retail online store suite (migration 0046)
--
-- The storefront is the only anonymous WRITE surface in the retail vertical,
-- so the claims to prove are about what a stranger can and cannot do:
--
--   1. The store switch is the gate. A shop that has not opened its store is
--      indistinguishable, to a visitor, from one that does not exist.
--   2. Prices come from the catalog. A cart that names its own price is
--      ignored; the quoted total and the placed total are the same number.
--   3. Placing an order COMMITS STOCK through the one ledger, so the till and
--      the storefront cannot both sell the last unit.
--   4. Cancelling returns the stock with a compensating movement, never an edit.
--   5. An order is not an invoice. No money exists until completion, and then
--      it exists in Core — invoice, payment, treasury — exactly as the POS does it.
--   6. The token follows exactly one order and reveals nothing else.
--   7. Anonymous visitors hold no privilege on the tables themselves.
--   8. One tenant cannot see, move, cancel or complete another's orders.
--   9. The state machine is enumerated; completed and cancelled are final.
--
-- Run with:  psql -v ON_ERROR_STOP=1 -f supabase/tests/19_retail_store.sql
-- =============================================================================

\set ON_ERROR_STOP on

do $$
declare
  u_a     uuid;  u_b uuid;
  org_a   uuid;  org_b uuid;
  br_a    uuid;  br_b uuid;
  prod_a  uuid;  var_a uuid;  var_hidden uuid;
  prod_b  uuid;  var_b uuid;
  ord     uuid;  ord_num text;  tok text;  total bigint;
  ord2    uuid;  tok2 text;
  inv     uuid;  inv_num text;
  acct_a  uuid;
  n       int;
  ok      boolean;
  qty     numeric(14,3);
  amt     bigint;
  st      text;
  r       record;
begin
  -- ==========================================================================
  -- Fixture: two shops, one with stock.
  -- ==========================================================================
  insert into auth.users (email) values ('storea@test.local') returning id into u_a;
  insert into auth.users (email) values ('storeb@test.local') returning id into u_b;

  perform auth.login_as(u_a);
  select out_organization_id, out_branch_id into org_a, br_a
    from public.provision_workspace('متجر أونلاين', 'storealpha', 'retail');
  perform auth.login_as(u_b);
  select out_organization_id, out_branch_id into org_b, br_b
    from public.provision_workspace('متجر آخر', 'storebeta', 'retail');

  perform auth.as_admin();
  insert into public.retail_products (organization_id, name, tax_rate_bp, is_online)
    values (org_a, 'قميص', 1400, true) returning id into prod_a;
  insert into public.retail_variants (organization_id, product_id, name, price_cents)
    values (org_a, prod_a, 'وسط', 20000) returning id into var_a;

  -- A product deliberately kept out of the storefront.
  insert into public.retail_products (organization_id, name, is_online)
    values (org_a, 'بضاعة داخلية', false) returning id into prod_a;
  insert into public.retail_variants (organization_id, product_id, price_cents)
    values (org_a, prod_a, 9900) returning id into var_hidden;

  insert into public.retail_products (organization_id, name) values (org_b, 'حذاء')
    returning id into prod_b;
  insert into public.retail_variants (organization_id, product_id, price_cents)
    values (org_b, prod_b, 30000) returning id into var_b;

  -- Ten on the shelf, through the ledger, as everything else does it.
  insert into public.retail_stock_movements
    (organization_id, branch_id, variant_id, quantity_delta, reason)
  values (org_a, br_a, var_a, 10, 'initial');
  insert into public.retail_stock_movements
    (organization_id, branch_id, variant_id, quantity_delta, reason)
  values (org_a, br_a, var_hidden, 5, 'initial');

  select id into acct_a from public.treasury_accounts
   where organization_id = org_a and branch_id = br_a and is_default limit 1;

  -- ==========================================================================
  -- 1. The store switch is the gate
  -- ==========================================================================
  perform auth.logout();
  select count(*) into n from public.retail_store_context('storealpha', 'main');
  assert n = 0, 'FAIL: a closed store answered a visitor';

  select count(*) into n from public.retail_store_catalog('storealpha', 'main');
  assert n = 0, 'FAIL: a closed store served a catalog';

  ok := false;
  begin
    perform public.retail_place_order(
      'storealpha', 'main',
      jsonb_build_array(jsonb_build_object('variant_id', var_a, 'quantity', 1)),
      'pickup', 'زائر', '01000000000');
  exception when others then ok := true; end;
  assert ok, 'FAIL: an order was placed at a closed store';

  perform auth.as_admin();
  insert into public.settings (organization_id, branch_id, key, value)
    values (org_a, null, 'retail.store_enabled', 'true'::jsonb);
  perform auth.logout();

  select count(*) into n from public.retail_store_context('storealpha', 'main');
  assert n = 1, 'FAIL: an open store did not answer';

  -- An unknown shop is the same silence as a closed one.
  select count(*) into n from public.retail_store_context('no-such-shop', 'main');
  assert n = 0, 'FAIL: an unknown shop answered';

  raise notice 'STORE: the store switch gates every anonymous surface';

  -- ==========================================================================
  -- 2. The catalog shows only what the shop published
  -- ==========================================================================
  select count(*) into n from public.retail_store_catalog('storealpha', 'main');
  assert n = 1, format('FAIL: the catalog returned %s rows, expected 1', n);

  select count(*) into n from public.retail_store_catalog('storealpha', 'main') c
   where c.out_variant_id = var_hidden;
  assert n = 0, 'FAIL: a product marked not-online appeared in the storefront';

  -- Cost is not a column a visitor can reach: the projection has no such output.
  select count(*) into n
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace,
    lateral unnest(p.proargmodes, p.proargnames) as a(mode, name)
   where ns.nspname = 'public' and p.proname = 'retail_store_catalog'
     and a.mode = 't' and a.name ilike '%cost%';
  assert n = 0, 'FAIL: the storefront catalog exposes cost';

  raise notice 'STORE: the catalog is limited to published, in-catalog items';

  -- ==========================================================================
  -- 3. Prices come from the database
  -- ==========================================================================
  select out_subtotal_cents, out_tax_cents, out_total_cents into r
    from public.retail_price_cart(
      'storealpha', 'main',
      jsonb_build_array(jsonb_build_object(
        'variant_id', var_a, 'quantity', 2,
        -- A cart trying to name its own price. Ignored.
        'unit_price_cents', 1, 'price_cents', 1, 'total_cents', 1)),
      'pickup');
  assert r.out_subtotal_cents = 40000,
    format('FAIL: quoted subtotal is %s, expected 40000', r.out_subtotal_cents);
  assert r.out_tax_cents = 5600,
    format('FAIL: quoted tax is %s, expected 5600', r.out_tax_cents);
  assert r.out_total_cents = 45600,
    format('FAIL: quoted total is %s, expected 45600', r.out_total_cents);

  select out_order_id, out_number, out_token, out_total_cents into r
    from public.retail_place_order(
      'storealpha', 'main',
      jsonb_build_array(jsonb_build_object(
        'variant_id', var_a, 'quantity', 2, 'unit_price_cents', 1)),
      'pickup', 'زائر الحارة', '01000000000', 'pay_on_collection', null, 'idem-1');
  ord := r.out_order_id; ord_num := r.out_number; tok := r.out_token; total := r.out_total_cents;

  -- The quote and the order agree, because they are the same arithmetic.
  assert total = 45600, format('FAIL: the placed total is %s, expected 45600', total);

  perform auth.as_admin();
  select unit_price_cents into amt from public.retail_order_items
   where order_id = ord;
  perform auth.logout();
  assert amt = 20000, format('FAIL: the line price is %s, the cart chose it', amt);

  raise notice 'STORE: prices and totals come from the catalog, never the cart';

  -- ==========================================================================
  -- 4. Placing an order commits stock through the one ledger
  -- ==========================================================================
  perform auth.as_admin();
  select quantity into qty from public.retail_stock_levels
   where branch_id = br_a and variant_id = var_a;
  assert qty = 8, format('FAIL: stock is %s after ordering 2 of 10', qty);

  select count(*) into n from public.retail_stock_movements
   where ref_type = 'retail_order' and ref_id = ord
     and reason = 'sale' and quantity_delta = -2;
  assert n = 1, 'FAIL: checkout did not write one sale movement';

  -- The projection and the ledger agree — the property that makes POS and the
  -- storefront safe to run side by side.
  select coalesce(sum(quantity_delta), 0) into qty from public.retail_stock_movements
   where branch_id = br_a and variant_id = var_a;
  select quantity into amt from public.retail_stock_levels
   where branch_id = br_a and variant_id = var_a;
  assert qty = amt, format('FAIL: ledger says %s, projection says %s', qty, amt);

  -- Overselling is refused, by the same CHECK the till meets.
  perform auth.logout();
  ok := false;
  begin
    perform public.retail_place_order(
      'storealpha', 'main',
      jsonb_build_array(jsonb_build_object('variant_id', var_a, 'quantity', 99)),
      'pickup', 'زائر', '01000000000');
  exception when others then ok := true; end;
  assert ok, 'FAIL: the storefront oversold';

  perform auth.as_admin();
  select quantity into qty from public.retail_stock_levels
   where branch_id = br_a and variant_id = var_a;
  assert qty = 8, format('FAIL: a refused order still moved stock (%s)', qty);
  perform auth.logout();

  raise notice 'STORE: checkout commits stock through the ledger and cannot oversell';

  -- ==========================================================================
  -- 5. Idempotency: the double-clicked button
  -- ==========================================================================
  select out_order_id, out_number into r
    from public.retail_place_order(
      'storealpha', 'main',
      jsonb_build_array(jsonb_build_object('variant_id', var_a, 'quantity', 2)),
      'pickup', 'زائر الحارة', '01000000000', 'pay_on_collection', null, 'idem-1');
  assert r.out_order_id = ord, 'FAIL: the same idempotency key produced a second order';

  perform auth.as_admin();
  select count(*) into n from public.retail_orders where organization_id = org_a;
  assert n = 1, format('FAIL: %s orders exist, expected 1', n);

  select quantity into qty from public.retail_stock_levels
   where branch_id = br_a and variant_id = var_a;
  assert qty = 8, format('FAIL: the repeat submission moved stock again (%s)', qty);
  perform auth.logout();

  raise notice 'STORE: an idempotency key absorbs the repeated checkout';

  -- ==========================================================================
  -- 6. The token follows exactly one order
  -- ==========================================================================
  select count(*) into n from public.retail_order_status(tok);
  assert n = 1, 'FAIL: the token did not resolve its own order';

  select count(*) into n from public.retail_order_lines(tok);
  assert n = 1, 'FAIL: the token did not resolve its own lines';

  select count(*) into n from public.retail_order_status('not-a-real-token');
  assert n = 0, 'FAIL: a made-up token resolved an order';

  -- It reveals the order and nothing about the shop's money.
  select count(*) into n
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace,
    lateral unnest(p.proargmodes, p.proargnames) as a(mode, name)
   where ns.nspname = 'public' and p.proname in ('retail_order_status','retail_order_lines')
     and a.mode = 't'
     and (a.name ilike '%cost%' or a.name ilike '%customer_id%' or a.name ilike '%token%');
  assert n = 0, 'FAIL: the guest projection leaks cost, a customer id, or the token';

  raise notice 'STORE: the token follows one order and leaks nothing';

  -- ==========================================================================
  -- 7. Anonymous holds no privilege on the tables themselves
  -- ==========================================================================
  for st in select unnest(array['retail_orders','retail_order_items','retail_order_deliveries']) loop
    assert not has_table_privilege('anon', 'public.' || st, 'select'),
      format('FAIL: anon may select %s', st);
    assert not has_table_privilege('anon', 'public.' || st, 'insert'),
      format('FAIL: anon may insert into %s', st);
    assert not has_table_privilege('anon', 'public.' || st, 'update'),
      format('FAIL: anon may update %s', st);
  end loop;

  raise notice 'STORE: anon reaches the schema only through the projections';

  -- ==========================================================================
  -- 8. An order is not an invoice until it is completed
  -- ==========================================================================
  perform auth.as_admin();
  select count(*) into n from public.invoices where organization_id = org_a;
  assert n = 0, 'FAIL: placing an order created an invoice';

  select count(*) into n from public.treasury_transactions where organization_id = org_a;
  assert n = 0, 'FAIL: placing an order moved money';

  perform auth.login_as(u_a);

  -- The state machine refuses shortcuts.
  ok := false;
  begin perform public.retail_order_complete(org_a, br_a, ord);
  exception when others then ok := true; end;
  assert ok, 'FAIL: a placed order was completed without being fulfilled';

  perform public.retail_order_set_status(org_a, br_a, ord, 'confirmed');
  perform public.retail_order_set_status(org_a, br_a, ord, 'packed');
  perform public.retail_order_set_status(org_a, br_a, ord, 'fulfilled');

  select out_invoice_id, out_invoice_number, out_total_cents into r
    from public.retail_order_complete(org_a, br_a, ord, 'cash', null);
  inv := r.out_invoice_id; inv_num := r.out_invoice_number;
  assert r.out_total_cents = 45600, format('FAIL: completed total is %s', r.out_total_cents);

  select status, total_cents, source, paid_cents into r from public.invoices where id = inv;
  -- 'paid', not 'issued': the payment trigger maintains paid_cents and moves
  -- the status, which is the behaviour the POS relies on too.
  assert r.status = 'paid', format('FAIL: the receipt status is %s', r.status);
  assert r.paid_cents = 45600, format('FAIL: the receipt paid_cents is %s', r.paid_cents);
  assert r.total_cents = 45600, format('FAIL: the receipt total is %s', r.total_cents);
  assert r.source = 'online', format('FAIL: the receipt source is %s', r.source);

  select count(*) into n from public.payments where invoice_id = inv and amount_cents = 45600;
  assert n = 1, 'FAIL: completion did not record the payment';

  select count(*) into n from public.treasury_transactions
   where ref_type = 'invoice' and ref_id = inv and direction = 'in' and amount_cents = 45600;
  assert n = 1, 'FAIL: completion did not put the money in the treasury';

  -- Stock is NOT moved again: it left the shelf when the order was placed.
  select quantity into qty from public.retail_stock_levels
   where branch_id = br_a and variant_id = var_a;
  assert qty = 8, format('FAIL: completion double-counted stock (%s)', qty);

  select status into st from public.retail_orders where id = ord;
  assert st = 'completed', format('FAIL: order status is %s after completion', st);

  ok := false;
  begin perform public.retail_order_cancel(org_a, br_a, ord, 'غيّرت رأيي');
  exception when others then ok := true; end;
  assert ok, 'FAIL: a completed order was cancelled';

  raise notice 'STORE: completion produces a Core receipt, payment and treasury entry';

  -- ==========================================================================
  -- 9. Cancelling returns the stock, as a movement
  -- ==========================================================================
  perform auth.logout();
  select out_order_id, out_token into r
    from public.retail_place_order(
      'storealpha', 'main',
      jsonb_build_array(jsonb_build_object('variant_id', var_a, 'quantity', 3)),
      'pickup', 'زائر ثاني', '01000000001');
  ord2 := r.out_order_id; tok2 := r.out_token;

  perform auth.as_admin();
  select quantity into qty from public.retail_stock_levels
   where branch_id = br_a and variant_id = var_a;
  assert qty = 5, format('FAIL: stock is %s after a second order of 3', qty);

  perform auth.login_as(u_a);
  perform public.retail_order_cancel(org_a, br_a, ord2, 'نفدت الكمية');

  select quantity into qty from public.retail_stock_levels
   where branch_id = br_a and variant_id = var_a;
  assert qty = 8, format('FAIL: cancelling did not return the stock (%s)', qty);

  -- Both facts survive: the order took it, and gave it back.
  select count(*) into n from public.retail_stock_movements
   where ref_type = 'retail_order' and ref_id = ord2;
  assert n = 2, format('FAIL: %s movements for a placed-then-cancelled order, expected 2', n);

  select status into st from public.retail_orders where id = ord2;
  assert st = 'cancelled', format('FAIL: status is %s after cancelling', st);

  raise notice 'STORE: cancelling compensates the ledger rather than editing it';

  -- ==========================================================================
  -- 10. Tenant isolation
  -- ==========================================================================
  perform auth.login_as(u_b);
  select count(*) into n from public.retail_orders where id = ord;
  assert n = 0, 'FAIL: tenant B read tenant A''s order';

  select count(*) into n from public.retail_order_items where order_id = ord;
  assert n = 0, 'FAIL: tenant B read tenant A''s order lines';

  for st in select unnest(array['status','cancel','complete']) loop
    ok := false;
    begin
      if st = 'status' then
        perform public.retail_order_set_status(org_b, br_b, ord, 'confirmed');
      elsif st = 'cancel' then
        perform public.retail_order_cancel(org_b, br_b, ord, null);
      else
        perform public.retail_order_complete(org_b, br_b, ord);
      end if;
    exception when others then ok := true; end;
    assert ok, format('FAIL: tenant B ran %s on tenant A''s order', st);

    -- Nor by naming tenant A's own identifiers.
    ok := false;
    begin
      if st = 'status' then
        perform public.retail_order_set_status(org_a, br_a, ord, 'confirmed');
      elsif st = 'cancel' then
        perform public.retail_order_cancel(org_a, br_a, ord, null);
      else
        perform public.retail_order_complete(org_a, br_a, ord);
      end if;
    exception when others then ok := true; end;
    assert ok, format('FAIL: tenant B ran %s by naming tenant A', st);
  end loop;

  -- A basket cannot reach across shops.
  perform auth.logout();
  ok := false;
  begin
    perform public.retail_place_order(
      'storealpha', 'main',
      jsonb_build_array(jsonb_build_object('variant_id', var_b, 'quantity', 1)),
      'pickup', 'زائر', '01000000000');
  exception when others then ok := true; end;
  assert ok, 'FAIL: a basket bought another shop''s product';

  raise notice 'STORE: one shop cannot see or touch another''s orders';

  -- ==========================================================================
  -- 11. Delivery needs an address, and the fee is the shop's
  -- ==========================================================================
  perform auth.as_admin();
  insert into public.settings (organization_id, branch_id, key, value)
    values (org_a, null, 'retail.delivery_fee_cents', '2500'::jsonb);
  perform auth.logout();

  ok := false;
  begin
    perform public.retail_place_order(
      'storealpha', 'main',
      jsonb_build_array(jsonb_build_object('variant_id', var_a, 'quantity', 1)),
      'delivery', 'زائر', '01000000000');
  exception when others then ok := true; end;
  assert ok, 'FAIL: a delivery order was placed with no address';

  select out_order_id, out_total_cents into r
    from public.retail_place_order(
      'storealpha', 'main',
      jsonb_build_array(jsonb_build_object('variant_id', var_a, 'quantity', 1)),
      'delivery', 'زائر التوصيل', '01000000002', 'cash_on_delivery', null, null,
      'المستلم', '01000000002', 'القاهرة', 'المعادي', 'شارع 9، عمارة 3', 'بجوار الصيدلية');
  -- 20000 + 2800 tax + 2500 fee
  assert r.out_total_cents = 25300,
    format('FAIL: the delivery total is %s, expected 25300', r.out_total_cents);

  perform auth.as_admin();
  select count(*) into n from public.retail_order_deliveries where order_id = r.out_order_id;
  assert n = 1, 'FAIL: the delivery address was not recorded';

  -- A negative fee cannot be stored in the first place.
  ok := false;
  begin
    update public.settings set value = '-100'::jsonb
     where organization_id = org_a and key = 'retail.delivery_fee_cents';
  exception when others then ok := true; end;
  assert ok, 'FAIL: a negative delivery fee was accepted';

  raise notice 'STORE: delivery needs an address and the fee is the shop''s own';

  -- ==========================================================================
  -- 12. Audit
  -- ==========================================================================
  select count(distinct action) into n from public.audit_logs
   where organization_id = org_a and entity_type = 'retail_order';
  assert n >= 4,
    format('FAIL: %s distinct store actions audited, expected at least 4', n);

  raise notice 'STORE: every order action is audited';

  raise notice 'RETAIL STORE: all assertions passed';
end $$;
