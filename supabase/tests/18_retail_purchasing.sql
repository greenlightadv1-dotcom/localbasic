-- =============================================================================
-- LOCAL BASIC — Retail purchasing suite (migration 0045)
--
-- Purchasing is the only way stock legitimately arrives, so the claims to
-- prove are about what it may and may not do to the ledger and the till:
--
--   1. Totals are derived from the lines. A client cannot state one.
--   2. Receiving writes the SAME ledger POS reads, so the shelf figure and
--      the movements never disagree.
--   3. Over-receiving is refused — twice: by the function and by a CHECK.
--   4. Partial receipts are an ordinary state, and the status follows the
--      outstanding quantity rather than being set by the caller.
--   5. The state machine is enumerated; a received or cancelled order is final.
--   6. Permissions separate raising an order, receiving goods, and paying.
--   7. One tenant cannot see, receive against or pay another's orders.
--   8. Supplier payment leaves the treasury, is capped at the order total, and
--      `paid_cents` is recomputed from the ledger rather than incremented.
--
-- Run with:  psql -v ON_ERROR_STOP=1 -f supabase/tests/18_retail_purchasing.sql
-- =============================================================================

\set ON_ERROR_STOP on

do $$
declare
  u_a      uuid;  u_b uuid;  u_clerk uuid;
  org_a    uuid;  org_b uuid;
  branch_a uuid;  branch_b uuid;
  sup_a    uuid;  sup_b uuid;
  cat_a    uuid;
  prod_a   uuid;  var_a uuid;  var_a2 uuid;
  prod_b   uuid;  var_b uuid;
  po       uuid;  po_number text;  po_total bigint;
  po_b     uuid;
  item_1   uuid;  item_2 uuid;
  role_clerk uuid;  member_clerk uuid;
  acct_a   uuid;
  n        int;
  ok       boolean;
  qty      numeric(14,3);
  amt      bigint;
  st       text;
  r        record;
begin
  -- ==========================================================================
  -- Fixture: two retail shops, each with a supplier and a stocked product.
  -- ==========================================================================
  insert into auth.users (email) values ('purcha@test.local')  returning id into u_a;
  insert into auth.users (email) values ('purchb@test.local')  returning id into u_b;
  insert into auth.users (email) values ('purchclerk@test.local') returning id into u_clerk;

  perform auth.login_as(u_a);
  select out_organization_id, out_branch_id into org_a, branch_a
    from public.provision_workspace('متجر المشتريات', 'purchalpha', 'retail');
  perform auth.login_as(u_b);
  select out_organization_id, out_branch_id into org_b, branch_b
    from public.provision_workspace('متجر آخر', 'purchbeta', 'retail');

  perform auth.as_admin();
  insert into public.retail_suppliers (organization_id, name)
    values (org_a, 'مورد الحارة') returning id into sup_a;
  insert into public.retail_suppliers (organization_id, name)
    values (org_b, 'مورد آخر') returning id into sup_b;

  insert into public.retail_categories (organization_id, name)
    values (org_a, 'مشروبات') returning id into cat_a;

  insert into public.retail_products (organization_id, category_id, name, tax_rate_bp)
    values (org_a, cat_a, 'شاي', 1400) returning id into prod_a;
  insert into public.retail_variants (organization_id, product_id, name, price_cents, cost_cents)
    values (org_a, prod_a, 'علبة', 5000, 3000) returning id into var_a;
  insert into public.retail_variants (organization_id, product_id, name, price_cents, cost_cents)
    values (org_a, prod_a, 'كرتونة', 40000, 26000) returning id into var_a2;

  insert into public.retail_products (organization_id, name) values (org_b, 'سكر')
    returning id into prod_b;
  insert into public.retail_variants (organization_id, product_id, price_cents)
    values (org_b, prod_b, 2000) returning id into var_b;

  select id into acct_a from public.treasury_accounts
   where organization_id = org_a and branch_id = branch_a and is_default limit 1;
  assert acct_a is not null, 'FAIL: provisioning left no default treasury account';

  -- ==========================================================================
  -- 1. Creating an order: totals derived, document numbered
  -- ==========================================================================
  perform auth.login_as(u_a);
  select out_id, out_number, out_total_cents into po, po_number, po_total
    from public.retail_purchase_create(
      org_a, branch_a, sup_a,
      jsonb_build_array(
        jsonb_build_object('variant_id', var_a,  'quantity', 10, 'unit_cost_cents', 3000),
        jsonb_build_object('variant_id', var_a2, 'quantity',  2, 'unit_cost_cents', 26000)
      ),
      null, 'أول طلبية');

  assert po is not null, 'FAIL: no purchase order was created';
  assert po_number is not null and length(po_number) > 0, 'FAIL: the order has no number';
  -- 10 × 3000 + 2 × 26000 = 82000
  assert po_total = 82000, format('FAIL: total is %s, expected 82000', po_total);

  select count(*) into n from public.retail_purchase_order_items where purchase_order_id = po;
  assert n = 2, format('FAIL: %s lines written, expected 2', n);

  select id into item_1 from public.retail_purchase_order_items
   where purchase_order_id = po and variant_id = var_a;
  select id into item_2 from public.retail_purchase_order_items
   where purchase_order_id = po and variant_id = var_a2;

  -- The snapshot is taken at creation, so renaming the product later does not
  -- rewrite history.
  select product_name into st from public.retail_purchase_order_items where id = item_1;
  assert st = 'شاي', format('FAIL: the line did not snapshot the product name (%s)', st);

  raise notice 'PURCHASING: an order is numbered and totalled from its lines';

  -- ==========================================================================
  -- 2. A client cannot state a total
  -- ==========================================================================
  perform auth.as_admin();
  update public.retail_purchase_orders set total_cents = 1 where id = po;
  -- The column is writable by the owner, but the roll-up trigger rewrites it
  -- the moment any line changes — and no client role may write it at all.
  update public.retail_purchase_order_items
     set quantity_ordered = quantity_ordered where id = item_1;
  select total_cents into po_total from public.retail_purchase_orders where id = po;
  assert po_total = 82000,
    format('FAIL: a written total survived a line change (%s)', po_total);

  perform auth.login_as(u_a);
  ok := false;
  begin
    update public.retail_purchase_orders set total_cents = 1 where id = po;
    -- No update policy exists, so this affects zero rows rather than raising.
    ok := not found;
  exception when others then ok := true; end;
  assert ok, 'FAIL: a tenant wrote a purchase order total directly';

  raise notice 'PURCHASING: totals are derived and cannot be written by a client';

  -- ==========================================================================
  -- 3. Receiving requires an ordered document, and writes the stock ledger
  -- ==========================================================================
  ok := false;
  begin
    perform public.retail_purchase_receive(
      org_a, branch_a, po,
      jsonb_build_array(jsonb_build_object('item_id', item_1, 'quantity', 1)));
  exception when others then ok := true; end;
  assert ok, 'FAIL: goods were received against a draft order';

  perform public.retail_purchase_submit(org_a, branch_a, po);
  select status into st from public.retail_purchase_orders where id = po;
  assert st = 'ordered', format('FAIL: status is %s after submit', st);

  -- Stock before.
  select coalesce(quantity, 0) into qty from public.retail_stock_levels
   where branch_id = branch_a and variant_id = var_a;
  assert coalesce(qty, 0) = 0, format('FAIL: the fixture already had stock (%s)', qty);

  select out_status, out_received_lines into r
    from public.retail_purchase_receive(
      org_a, branch_a, po,
      jsonb_build_array(jsonb_build_object('item_id', item_1, 'quantity', 4)),
      'دفعة أولى');
  assert r.out_status = 'partially_received',
    format('FAIL: status is %s after a short receipt', r.out_status);

  select quantity into qty from public.retail_stock_levels
   where branch_id = branch_a and variant_id = var_a;
  assert qty = 4, format('FAIL: stock is %s after receiving 4', qty);

  -- The movement is in the same ledger POS writes, with the purchase reason.
  select count(*) into n from public.retail_stock_movements
   where ref_type = 'retail_purchase' and ref_id = po
     and reason = 'purchase' and variant_id = var_a and quantity_delta = 4;
  assert n = 1, 'FAIL: receiving did not write one purchase movement';

  -- And the projection agrees with the ledger, which is the whole point.
  select coalesce(sum(quantity_delta), 0) into qty from public.retail_stock_movements
   where branch_id = branch_a and variant_id = var_a;
  select quantity into amt from public.retail_stock_levels
   where branch_id = branch_a and variant_id = var_a;
  assert qty = amt, format('FAIL: ledger says %s, projection says %s', qty, amt);

  raise notice 'PURCHASING: receiving writes the one stock ledger';

  -- ==========================================================================
  -- 4. Over-receiving is refused
  -- ==========================================================================
  ok := false;
  begin
    perform public.retail_purchase_receive(
      org_a, branch_a, po,
      jsonb_build_array(jsonb_build_object('item_id', item_1, 'quantity', 7)));
  exception when others then ok := true; end;
  assert ok, 'FAIL: more was received than was ordered';

  -- And the refusal left nothing behind.
  select quantity into qty from public.retail_stock_levels
   where branch_id = branch_a and variant_id = var_a;
  assert qty = 4, format('FAIL: a refused receipt still moved stock (%s)', qty);

  -- The CHECK is the second lock, independent of the function.
  perform auth.as_admin();
  ok := false;
  begin
    update public.retail_purchase_order_items
       set quantity_received = quantity_ordered + 1 where id = item_1;
  exception when others then ok := true; end;
  assert ok, 'FAIL: the over-receipt CHECK did not fire';
  perform auth.login_as(u_a);

  raise notice 'PURCHASING: over-receiving is refused by function and by CHECK';

  -- ==========================================================================
  -- 5. Completing the order closes it, and it stays closed
  -- ==========================================================================
  perform public.retail_purchase_receive(
    org_a, branch_a, po,
    jsonb_build_array(
      jsonb_build_object('item_id', item_1, 'quantity', 6),
      jsonb_build_object('item_id', item_2, 'quantity', 2)));

  select status, received_at is not null into r
    from public.retail_purchase_orders where id = po;
  assert r.status = 'received', format('FAIL: status is %s once fully received', r.status);

  select quantity into qty from public.retail_stock_levels
   where branch_id = branch_a and variant_id = var_a;
  assert qty = 10, format('FAIL: stock is %s after receiving everything', qty);

  -- Receiving the last unit updates the catalog cost, not the selling price.
  select cost_cents, price_cents into r from public.retail_variants where id = var_a2;
  assert r.cost_cents = 26000, format('FAIL: cost is %s after receiving', r.cost_cents);
  assert r.price_cents = 40000, format('FAIL: receiving changed the selling price (%s)', r.price_cents);

  ok := false;
  begin
    perform public.retail_purchase_receive(
      org_a, branch_a, po,
      jsonb_build_array(jsonb_build_object('item_id', item_1, 'quantity', 1)));
  exception when others then ok := true; end;
  assert ok, 'FAIL: a received order accepted more goods';

  -- The state machine refuses an illegal jump even from the owner.
  perform auth.as_admin();
  ok := false;
  begin
    update public.retail_purchase_orders set status = 'draft' where id = po;
  exception when others then ok := true; end;
  assert ok, 'FAIL: a received order was reopened as a draft';
  perform auth.login_as(u_a);

  raise notice 'PURCHASING: the state machine is enumerated and final states hold';

  -- ==========================================================================
  -- 6. Paying the supplier: treasury out, capped, derived
  -- ==========================================================================
  select out_paid_cents, out_total_cents into r
    from public.retail_purchase_pay(org_a, branch_a, po, 50000, null, null);
  assert r.out_paid_cents = 50000, format('FAIL: paid is %s', r.out_paid_cents);
  assert r.out_total_cents = 82000, format('FAIL: total is %s', r.out_total_cents);

  select count(*) into n from public.treasury_transactions
   where ref_type = 'retail_purchase' and ref_id = po
     and direction = 'out' and amount_cents = 50000 and category = 'purchase';
  assert n = 1, 'FAIL: paying a supplier did not leave the treasury';

  ok := false;
  begin
    perform public.retail_purchase_pay(org_a, branch_a, po, 40000, null, null);
  exception when others then ok := true; end;
  assert ok, 'FAIL: a supplier was paid more than the order total';

  -- paid_cents is recomputed from the ledger, so it survives tampering.
  perform auth.as_admin();
  update public.retail_purchase_orders set paid_cents = 999 where id = po;
  perform auth.login_as(u_a);
  perform public.retail_purchase_pay(org_a, branch_a, po, 32000, null, null);
  select paid_cents into amt from public.retail_purchase_orders where id = po;
  assert amt = 82000, format('FAIL: paid_cents is %s, expected 82000', amt);

  raise notice 'PURCHASING: supplier payment is treasury money, capped and derived';

  -- ==========================================================================
  -- 7. Permission separation
  --
  -- A clerk who may read purchasing holds neither the right to raise an order
  -- nor the right to declare that goods arrived.
  -- ==========================================================================
  perform auth.as_admin();
  insert into public.organization_members (organization_id, user_id, status)
    values (org_a, u_clerk, 'active') returning id into member_clerk;
  insert into public.member_branches (member_id, branch_id) values (member_clerk, branch_a);
  insert into public.roles (organization_id, key, name_ar, name_en)
    values (org_a, 'purchclerk', 'كاتب مشتريات', 'Purchasing clerk') returning id into role_clerk;
  insert into public.role_permissions (role_id, permission_key)
    values (role_clerk, 'retail.purchase.read');
  insert into public.user_roles (member_id, role_id)
    values (member_clerk, role_clerk);

  perform auth.login_as(u_clerk);
  select count(*) into n from public.retail_purchase_orders where id = po;
  assert n = 1, 'FAIL: a reader could not read the order';

  ok := false;
  begin
    perform public.retail_purchase_create(
      org_a, branch_a, sup_a,
      jsonb_build_array(jsonb_build_object('variant_id', var_a, 'quantity', 1, 'unit_cost_cents', 1)));
  exception when others then ok := true; end;
  assert ok, 'FAIL: a reader raised a purchase order';

  ok := false;
  begin
    perform public.retail_purchase_receive(
      org_a, branch_a, po,
      jsonb_build_array(jsonb_build_object('item_id', item_1, 'quantity', 1)));
  exception when others then ok := true; end;
  assert ok, 'FAIL: a reader received goods';

  ok := false;
  begin
    perform public.retail_purchase_pay(org_a, branch_a, po, 1, null, null);
  exception when others then ok := true; end;
  assert ok, 'FAIL: a reader paid a supplier';

  raise notice 'PURCHASING: raising, receiving and paying are separate privileges';

  -- ==========================================================================
  -- 8. Tenant isolation
  -- ==========================================================================
  perform auth.login_as(u_b);
  select count(*) into n from public.retail_purchase_orders where id = po;
  assert n = 0, 'FAIL: tenant B read tenant A''s purchase order';

  select count(*) into n from public.retail_purchase_order_items where purchase_order_id = po;
  assert n = 0, 'FAIL: tenant B read tenant A''s purchase lines';

  for st in select unnest(array['submit','receive','pay','cancel']) loop
    ok := false;
    begin
      if st = 'submit' then
        perform public.retail_purchase_submit(org_b, branch_b, po);
      elsif st = 'receive' then
        perform public.retail_purchase_receive(
          org_b, branch_b, po,
          jsonb_build_array(jsonb_build_object('item_id', item_1, 'quantity', 1)));
      elsif st = 'pay' then
        perform public.retail_purchase_pay(org_b, branch_b, po, 100, null, null);
      else
        perform public.retail_purchase_cancel(org_b, branch_b, po, null);
      end if;
    exception when others then ok := true; end;
    assert ok, format('FAIL: tenant B ran %s against tenant A''s order', st);
  end loop;

  -- Nor by naming tenant A's identifiers, which they do not belong to.
  ok := false;
  begin perform public.retail_purchase_submit(org_a, branch_a, po);
  exception when others then ok := true; end;
  assert ok, 'FAIL: tenant B acted on tenant A''s order by naming tenant A';

  -- A supplier from another organization cannot be attached.
  ok := false;
  begin
    perform public.retail_purchase_create(
      org_b, branch_b, sup_a,
      jsonb_build_array(jsonb_build_object('variant_id', var_b, 'quantity', 1, 'unit_cost_cents', 100)));
  exception when others then ok := true; end;
  assert ok, 'FAIL: an order was raised against another organization''s supplier';

  -- Nor a variant from another organization.
  ok := false;
  begin
    perform public.retail_purchase_create(
      org_b, branch_b, sup_b,
      jsonb_build_array(jsonb_build_object('variant_id', var_a, 'quantity', 1, 'unit_cost_cents', 100)));
  exception when others then ok := true; end;
  assert ok, 'FAIL: an order was raised against another organization''s variant';

  raise notice 'PURCHASING: one tenant cannot see or touch another''s purchasing';

  -- ==========================================================================
  -- 9. Cancellation keeps delivered stock
  -- ==========================================================================
  perform auth.login_as(u_a);
  select out_id into po_b from public.retail_purchase_create(
    org_a, branch_a, sup_a,
    jsonb_build_array(jsonb_build_object('variant_id', var_a, 'quantity', 5, 'unit_cost_cents', 3000)));
  perform public.retail_purchase_submit(org_a, branch_a, po_b);

  select id into item_1 from public.retail_purchase_order_items
   where purchase_order_id = po_b and variant_id = var_a;
  perform public.retail_purchase_receive(
    org_a, branch_a, po_b,
    jsonb_build_array(jsonb_build_object('item_id', item_1, 'quantity', 2)));

  perform public.retail_purchase_cancel(org_a, branch_a, po_b, 'المورد اعتذر');
  select status into st from public.retail_purchase_orders where id = po_b;
  assert st = 'cancelled', format('FAIL: status is %s after cancelling', st);

  -- Cancelling paperwork does not un-deliver goods: 10 + 2 are still on hand.
  select quantity into qty from public.retail_stock_levels
   where branch_id = branch_a and variant_id = var_a;
  assert qty = 12, format('FAIL: cancelling removed delivered stock (%s)', qty);

  ok := false;
  begin
    perform public.retail_purchase_receive(
      org_a, branch_a, po_b,
      jsonb_build_array(jsonb_build_object('item_id', item_1, 'quantity', 1)));
  exception when others then ok := true; end;
  assert ok, 'FAIL: a cancelled order accepted goods';

  raise notice 'PURCHASING: cancelling closes the document without rewriting the ledger';

  -- ==========================================================================
  -- 10. Audit
  -- ==========================================================================
  perform auth.as_admin();
  select count(distinct action) into n from public.audit_logs
   where organization_id = org_a and entity_type = 'retail_purchase_order';
  assert n >= 5,
    format('FAIL: %s distinct purchasing actions audited, expected at least 5', n);

  raise notice 'PURCHASING: every purchasing action is audited';

  raise notice 'RETAIL PURCHASING: all assertions passed';
end $$;
