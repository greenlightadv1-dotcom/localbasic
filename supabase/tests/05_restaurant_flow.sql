-- =============================================================================
-- LOCAL BASIC — Restaurant critical flow
--
-- The whole journey, end to end, exactly as a real branch would run it:
--   organization → branch → tables → QR → menu → guest scan → order →
--   cashier → kitchen → waiter → payment → receipt → treasury → reports
-- =============================================================================

\set ON_ERROR_STOP on

do $$
declare
  u_owner uuid; u_cash uuid; u_kitchen uuid; u_waiter uuid;
  org uuid; branch uuid;
  section uuid; tbl uuid; token text;
  cat uuid; prod uuid; var_small uuid; var_large uuid;
  grp uuid; mod_extra uuid; mod_none uuid;
  m_cash uuid; m_kitchen uuid; m_waiter uuid;
  r_cash uuid; r_kitchen uuid; r_waiter uuid;
  ctx record; menu jsonb;
  order_number text; v_order uuid; total bigint;
  inv uuid; receipt text; paid bigint; due bigint; change bigint;
  acct uuid; bal bigint;
  n int; ok boolean; st text;
begin
  -- ==========================================================================
  -- 1-2. Organization and branch
  -- ==========================================================================
  insert into auth.users (email) values ('cafe-owner@test.local') returning id into u_owner;
  insert into auth.users (email) values ('cafe-cash@test.local')  returning id into u_cash;
  insert into auth.users (email) values ('cafe-kitchen@test.local') returning id into u_kitchen;
  insert into auth.users (email) values ('cafe-waiter@test.local') returning id into u_waiter;

  perform auth.login_as(u_owner);
  select out_organization_id, out_branch_id into org, branch
    from public.provision_workspace('قهوة المدينة', 'madina-cafe', 'restaurant', 'الفرع الرئيسي');
  perform auth.as_admin();

  -- ==========================================================================
  -- 3-4. Tables and QR codes — created by the module bootstrap hook
  -- ==========================================================================
  perform auth.login_as(u_owner);

  select count(*) into n from public.restaurant_tables where branch_id = branch;
  assert n = 6, format('FAIL: expected 6 bootstrapped tables, got %s', n);

  select count(*) into n from public.restaurant_tables
   where branch_id = branch and public_link_id is not null;
  assert n = 6, 'FAIL: not every table received a QR link';

  select t.id, pl.token into tbl, token
    from public.restaurant_tables t
    join public.public_links pl on pl.id = t.public_link_id
   where t.branch_id = branch and t.name = '3';
  assert tbl is not null and token is not null, 'FAIL: table 3 has no QR token';

  -- The token is opaque: it is not any of our internal identifiers.
  assert token <> tbl::text and token <> branch::text and token <> org::text,
    'FAIL: the QR token exposes an internal id';
  assert length(token) >= 22, 'FAIL: QR token is too short to be unguessable';

  -- ==========================================================================
  -- 5. Menu
  -- ==========================================================================
  insert into public.restaurant_categories (organization_id, name, sort_order)
  values (org, 'مشروبات ساخنة', 0) returning id into cat;

  insert into public.restaurant_products
    (organization_id, category_id, name, description, tax_rate_bp, prep_minutes)
  values (org, cat, 'لاتيه', 'إسبريسو مع حليب', 1400, 5) returning id into prod;

  insert into public.restaurant_variants (organization_id, product_id, name, price_cents, sort_order)
  values (org, prod, 'صغير', 5000, 0) returning id into var_small;
  insert into public.restaurant_variants (organization_id, product_id, name, price_cents, sort_order)
  values (org, prod, 'كبير', 7000, 1) returning id into var_large;

  insert into public.restaurant_modifier_groups
    (organization_id, product_id, name, min_select, max_select)
  values (org, prod, 'إضافات', 0, 2) returning id into grp;

  insert into public.restaurant_modifiers (organization_id, group_id, name, price_cents)
  values (org, grp, 'شوت إسبريسو إضافي', 1500) returning id into mod_extra;
  insert into public.restaurant_modifiers (organization_id, group_id, name, price_cents)
  values (org, grp, 'بدون سكر', 0) returning id into mod_none;

  -- Staff accounts: cashier, kitchen, waiter — each with only their own role.
  insert into public.organization_members (organization_id, user_id, status, all_branches, joined_at)
  values (org, u_cash, 'active', true, now()) returning id into m_cash;
  insert into public.organization_members (organization_id, user_id, status, all_branches, joined_at)
  values (org, u_kitchen, 'active', true, now()) returning id into m_kitchen;
  insert into public.organization_members (organization_id, user_id, status, all_branches, joined_at)
  values (org, u_waiter, 'active', true, now()) returning id into m_waiter;

  select id into r_cash    from public.roles where organization_id = org and key = 'cashier';
  select id into r_kitchen from public.roles where organization_id = org and key = 'kitchen';
  select id into r_waiter  from public.roles where organization_id = org and key = 'waiter';
  assert r_cash is not null and r_kitchen is not null and r_waiter is not null,
    'FAIL: restaurant role templates were not cloned into the organization';

  insert into public.user_roles (member_id, role_id) values
    (m_cash, r_cash), (m_kitchen, r_kitchen), (m_waiter, r_waiter);
  perform auth.as_admin();

  -- ==========================================================================
  -- 6. The guest scans the QR — anonymous, no account
  -- ==========================================================================
  perform auth.logout();

  select * into ctx from public.restaurant_public_context(token);
  assert ctx.table_name = '3', format('FAIL: token resolved to table %s', ctx.table_name);
  assert ctx.organization_name = 'قهوة المدينة', 'FAIL: token did not resolve the restaurant';
  assert ctx.ordering_enabled, 'FAIL: guest ordering should be enabled by default';

  menu := public.restaurant_public_menu(token);
  assert jsonb_array_length(menu) = 1, 'FAIL: the public menu is empty';
  assert menu #>> '{0,name}' = 'مشروبات ساخنة', 'FAIL: category missing from the public menu';
  assert jsonb_array_length(menu #> '{0,products,0,variants}') = 2,
    'FAIL: both variants should appear on the public menu';

  -- ==========================================================================
  -- 7. The guest places an order
  --    1 × large latte + extra shot  = 7000 + 1500 = 8500, +14% = 9690
  --    2 × small latte               = 10000,        +14% = 11400
  --    total                         = 21090
  -- ==========================================================================
  select out_order_number, out_total_cents into order_number, total
  from public.restaurant_place_public_order(
    token,
    ('[{"variant_id":"' || var_large || '","quantity":1,"modifier_ids":["' || mod_extra || '"],"note":"ساخن جدًا"},
       {"variant_id":"' || var_small || '","quantity":2}]')::jsonb,
    'أحمد', '01000000000', 'بدون مناديل');

  assert total = 21090, format('FAIL: expected total 21090, got %s', total);
  perform auth.as_admin();

  select id into v_order from public.restaurant_orders
   where organization_id = org and number = order_number;

  select (status = 'new' and channel = 'qr' and table_id = tbl and created_by is null)
    into ok from public.restaurant_orders where id = v_order;
  assert ok, 'FAIL: the guest order was not recorded as an anonymous QR order at the table';

  -- Scanning seats the table.
  select status into st from public.restaurant_tables where id = tbl;
  assert st = 'occupied', format('FAIL: table should be occupied, is %s', st);

  -- Price snapshots, not live menu prices.
  select count(*) into n from public.restaurant_order_items where order_id = v_order;
  assert n = 2, 'FAIL: expected 2 order lines';

  select (unit_price_cents = 7000 and modifiers_cents = 1500 and line_total_cents = 9690)
    into ok from public.restaurant_order_items
   where order_id = v_order and variant_id = var_large;
  assert ok, 'FAIL: the large latte line was not priced from the database';

  -- ==========================================================================
  -- 8. The order reaches the cashier, who confirms it
  -- ==========================================================================
  perform auth.login_as(u_cash);
  select count(*) into n from public.restaurant_orders where id = v_order;
  assert n = 1, 'FAIL: the cashier cannot see the order';

  perform public.restaurant_set_order_status(org, v_order, 'confirmed');
  perform auth.as_admin();

  select status into st from public.restaurant_orders where id = v_order;
  assert st = 'confirmed', format('FAIL: expected confirmed, got %s', st);

  -- ==========================================================================
  -- 9-10. The kitchen prepares it and marks it ready
  -- ==========================================================================
  perform auth.login_as(u_kitchen);
  select count(*) into n from public.restaurant_orders
   where branch_id = branch and status = 'confirmed';
  assert n = 1, 'FAIL: the order is not on the kitchen display';

  perform public.restaurant_set_order_status(org, v_order, 'preparing');
  perform public.restaurant_set_order_status(org, v_order, 'ready');
  perform auth.as_admin();

  select (status = 'ready' and ready_at is not null) into ok
    from public.restaurant_orders where id = v_order;
  assert ok, 'FAIL: the kitchen could not mark the order ready';

  -- ==========================================================================
  -- 11. The waiter serves it
  -- ==========================================================================
  perform auth.login_as(u_waiter);
  perform public.restaurant_set_order_status(org, v_order, 'served');
  perform auth.as_admin();

  select (status = 'served' and served_at is not null) into ok
    from public.restaurant_orders where id = v_order;
  assert ok, 'FAIL: the waiter could not mark the order served';

  -- ==========================================================================
  -- 12-14. The cashier takes payment → receipt, payment, treasury
  -- ==========================================================================
  select id into acct from public.treasury_accounts where branch_id = branch and is_default;
  bal := public.treasury_account_balance(acct);
  assert bal = 0, 'FAIL: the till should start empty';

  perform auth.login_as(u_cash);
  select out_invoice_id, out_receipt_number, out_total_cents, out_paid_cents,
         out_due_cents, out_change_cents
    into inv, receipt, total, paid, due, change
  from public.restaurant_pay_order(org, v_order, 'cash', 25000, 0);

  assert total = 21090, format('FAIL: payment total %s', total);
  assert paid = 21090, format('FAIL: paid %s', paid);
  assert due = 0, format('FAIL: due should be 0, got %s', due);
  assert change = 3910, format('FAIL: change should be 3910, got %s', change);

  -- 15. Close the order.
  perform public.restaurant_set_order_status(org, v_order, 'completed');
  perform auth.as_admin();

  select (status = 'paid' and source = 'restaurant' and total_cents = 21090
          and paid_cents = 21090) into ok
    from public.invoices where id = inv;
  assert ok, 'FAIL: the Core invoice does not reflect the paid order';

  select count(*) into n from public.invoice_items where invoice_id = inv;
  assert n = 2, 'FAIL: receipt lines were not copied from the order';

  select count(*) into n from public.payments where invoice_id = inv and kind = 'payment';
  assert n = 1, 'FAIL: expected exactly one payment';

  bal := public.treasury_account_balance(acct);
  assert bal = 21090, format('FAIL: treasury balance %s, expected 21090', bal);

  select count(*) into n from public.treasury_transactions
   where ref_type = 'invoice' and ref_id = inv and direction = 'in';
  assert n = 1, 'FAIL: the payment did not reach the treasury ledger';

  select status into st from public.restaurant_orders where id = v_order;
  assert st = 'completed', format('FAIL: order should be completed, is %s', st);

  -- The table is released for cleaning once the party is closed out.
  select status into st from public.restaurant_tables where id = tbl;
  assert st = 'cleaning', format('FAIL: table should be cleaning, is %s', st);

  update public.restaurant_tables set status = 'available' where id = tbl;
  select status into st from public.restaurant_tables where id = tbl;
  assert st = 'available', 'FAIL: a cleaned table cannot be made available';

  -- Every important step is auditable.
  select count(*) into n from public.audit_logs
   where organization_id = org and action like 'restaurant.%';
  assert n >= 7, format('FAIL: expected the flow to be audited, found %s entries', n);

  -- ==========================================================================
  -- Reports reflect the transaction
  -- ==========================================================================
  select coalesce(sum(total_cents), 0) into total
    from public.invoices
   where organization_id = org and branch_id = branch
     and status = 'paid' and voided_at is null;
  assert total = 21090, format('FAIL: reported revenue %s', total);

  raise notice 'RESTAURANT FLOW: all 15 steps passed';
end $$;
