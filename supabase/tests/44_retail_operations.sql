-- =============================================================================
-- LOCAL BASIC — retail operations (0112): transfer workflow with partial
-- receipt, promotions in checkout, store credit, PIN-gated cash returns,
-- damaged-goods write-off, exchanges, loyalty points and auto-reorder
-- =============================================================================
\set ON_ERROR_STOP on

do $$
declare
  u_owner uuid; u_mgr uuid; u_cash uuid; u_other uuid;
  org uuid; br uuid; br2 uuid; org_b uuid; br_b uuid; m uuid;
  cat uuid; p1 uuid; p2 uuid; v1 uuid; v2 uuid; sup uuid; cust uuid;
  pa uuid; pb uuid; pc uuid; tr uuid; inv uuid; inv2 uuid; r record; refused boolean; n int; q numeric; b bigint;
begin
  insert into auth.users (email) values ('r44-owner@test.local') returning id into u_owner;
  insert into auth.users (email) values ('r44-mgr@test.local')   returning id into u_mgr;
  insert into auth.users (email) values ('r44-cash@test.local')  returning id into u_cash;
  insert into auth.users (email) values ('r44-other@test.local') returning id into u_other;
  perform auth.login_as(u_owner);
  select out_organization_id, out_branch_id into org, br from public.provision_workspace('R44 Shop', 'r44shop', 'retail');
  perform auth.login_as(u_other);
  select out_organization_id, out_branch_id into org_b, br_b from public.provision_workspace('R44 Other', 'r44other', 'retail');

  perform auth.as_admin();
  insert into public.branches (organization_id, slug, name) values (org, 'b2', 'فرع 2') returning id into br2;
  for r in select * from (values (u_mgr, 'manager'), (u_cash, 'cashier')) as t(u, kk) loop
    insert into public.organization_members (organization_id, user_id, status, all_branches, joined_at)
    values (org, r.u, 'active', true, now()) returning id into m;
    insert into public.user_roles (member_id, role_id) select m, id from public.roles where organization_id = org and key = r.kk;
  end loop;

  insert into public.retail_categories (organization_id, name) values (org, 'مشروبات') returning id into cat;
  insert into public.retail_products (organization_id, name) values (org, 'سماعة') returning id into p1;
  insert into public.retail_variants (organization_id, product_id, sku, price_cents, cost_cents) values (org, p1, 'HP', 10000, 6000) returning id into v1;
  insert into public.retail_products (organization_id, name, category_id) values (org, 'عصير', cat) returning id into p2;
  insert into public.retail_variants (organization_id, product_id, sku, price_cents, cost_cents) values (org, p2, 'JU', 2000, 800) returning id into v2;
  insert into public.retail_stock_movements (organization_id, branch_id, variant_id, quantity_delta, reason, ref_type)
  values (org, br, v1, 50, 'initial', 'manual'), (org, br, v2, 100, 'initial', 'manual');
  insert into public.retail_suppliers (organization_id, name) values (org, 'المورد') returning id into sup;
  insert into public.customers (organization_id, name, phone) values (org, 'هالة', '01055555555') returning id into cust;
  insert into public.restaurant_loyalty_settings (organization_id, enabled, cents_per_point) values (org, true, 1000);

  -- =========================== transfers ===========================================
  perform auth.login_as(u_mgr);
  select out_transfer_id into tr from public.retail_transfer_request(org, br, br2,
    jsonb_build_array(jsonb_build_object('variant_id', v1, 'quantity', 10)), 'نقص في الفرع');
  assert (select status from public.retail_stock_transfers where id = tr) = 'requested', 'requested';
  assert (select number from public.retail_stock_transfers where id = tr) like 'TR-%', 'numbered';
  perform auth.login_as(u_cash);
  refused := false;
  begin perform public.retail_transfer_decide(org, tr, true); exception when insufficient_privilege then refused := true; end;
  assert refused, 'a cashier cannot approve transfers';
  perform auth.login_as(u_mgr);
  refused := false;
  begin perform public.retail_transfer_dispatch(org, tr); exception when check_violation then refused := true; end;
  assert refused, 'cannot ship before approval';
  perform public.retail_transfer_decide(org, tr, true, null);
  perform auth.login_as(u_owner);
  perform public.retail_transfer_dispatch(org, tr);
  perform auth.as_admin();
  assert (select quantity from public.retail_stock_levels where branch_id = br and variant_id = v1) = 40, 'stock left the source';
  assert not exists (select 1 from public.retail_stock_levels where branch_id = br2 and variant_id = v1 and quantity > 0),
         'nothing arrives while in transit';
  perform auth.login_as(u_mgr);
  select * into r from public.retail_transfer_receive(org, tr,
    jsonb_build_array(jsonb_build_object('variant_id', v1, 'quantity_received', 8)), 'كرتونة ناقصة');
  assert r.out_shortage_lines = 1 and r.out_shortage_qty = 2, 'shortage is reported';
  perform auth.as_admin();
  assert (select quantity from public.retail_stock_levels where branch_id = br2 and variant_id = v1) = 8, 'partial receipt lands';
  assert (select status from public.retail_stock_transfers where id = tr) = 'received', 'received';

  perform auth.login_as(u_mgr);
  select out_transfer_id into tr from public.retail_transfer_request(org, br, br2,
    jsonb_build_array(jsonb_build_object('variant_id', v2, 'quantity', 5)));
  refused := false;
  begin perform public.retail_transfer_decide(org, tr, false, ''); exception when invalid_parameter_value then refused := true; end;
  assert refused, 'a rejection needs a reason';
  perform public.retail_transfer_decide(org, tr, false, 'لا يوجد فائض');
  refused := false;
  begin perform public.retail_transfer_cancel(org, tr, 'x'); exception when check_violation then refused := true; end;
  assert refused, 'a rejected transfer cannot be cancelled';
  select out_transfer_id into tr from public.retail_transfer_request(org, br, br2,
    jsonb_build_array(jsonb_build_object('variant_id', v2, 'quantity', 5)));
  perform public.retail_transfer_cancel(org, tr, 'طلب مكرر');
  assert (select status from public.retail_stock_transfers where id = tr) = 'cancelled', 'cancelled';

  -- =========================== promotions ===========================================
  perform auth.as_admin();
  insert into public.retail_promotions (organization_id, name, kind, percent_off, stackable)
  values (org, 'خصم المشروبات', 'percent', 10, true) returning id into pa;
  insert into public.retail_promotion_items (organization_id, promotion_id, category_id) values (org, pa, cat);
  insert into public.retail_promotions (organization_id, name, kind, code, amount_off_cents, stackable, max_uses)
  values (org, 'كود العيد', 'amount', 'EID', 1000, true, 1) returning id into pb;
  insert into public.retail_promotions (organization_id, name, kind, buy_qty, get_qty, priority, is_active)
  values (org, 'اشتر واحدة', 'bogo', 1, 1, -1, true) returning id into pc;
  insert into public.retail_promotion_items (organization_id, promotion_id, variant_id) values (org, pc, v1);

  perform auth.login_as(u_cash);
  select sum(discount_cents) filter (where applied), count(*) filter (where applied) into b, n
    from public.retail_promotions_preview(org, br,
      jsonb_build_array(jsonb_build_object('variant_id', v1, 'quantity', 2), jsonb_build_object('variant_id', v2, 'quantity', 3)),
      cust, 'eid');
  assert b = 1600 and n = 2, 'stackable winner: 10%% of 6000 + 1000 code (case-insensitive), got ' || coalesce(b::text, 'null');

  refused := false;
  begin perform public.retail_checkout(org, br, jsonb_build_array(jsonb_build_object('variant_id', v2, 'quantity', 1)),
                                       'cash', 5000, null, 'NOPE');
  exception when invalid_parameter_value then refused := true; end;
  assert refused, 'an unknown code is refused, not silently ignored';

  select * into r from public.retail_checkout(org, br,
    jsonb_build_array(jsonb_build_object('variant_id', v1, 'quantity', 2), jsonb_build_object('variant_id', v2, 'quantity', 3)),
    'cash', 30000, cust, 'EID');
  inv := r.out_invoice_id;
  assert r.out_promo_cents = 1600 and r.out_total_cents = 24400 and r.out_change_cents = 5600,
         'checkout applies promotions, got ' || r.out_total_cents;
  assert r.out_points_earned = 24, 'loyalty points on the net total';
  perform auth.as_admin();
  assert (select uses_count from public.retail_promotions where id = pb) = 1, 'code use counted';
  assert (select count(*) from public.retail_sale_promotions where invoice_id = inv) = 2, 'applications recorded';
  assert (select sum(points) from public.restaurant_loyalty_adjustments where organization_id = org) = 24, 'points written';

  perform auth.login_as(u_cash);
  refused := false;
  begin perform public.retail_checkout(org, br, jsonb_build_array(jsonb_build_object('variant_id', v2, 'quantity', 1)),
                                       'cash', 5000, cust, 'EID');
  exception when invalid_parameter_value then refused := true; end;
  assert refused, 'a used-up code no longer applies';

  perform auth.as_admin();
  update public.retail_promotions set priority = 5 where id = pc;
  perform auth.login_as(u_cash);
  select * into r from public.retail_checkout(org, br,
    jsonb_build_array(jsonb_build_object('variant_id', v1, 'quantity', 2), jsonb_build_object('variant_id', v2, 'quantity', 1)),
    'card', 12000);
  assert r.out_promo_cents = 10000 and r.out_total_cents = 12000, 'a non-stackable BOGO winner applies alone, got ' || r.out_total_cents;
  perform auth.as_admin();
  update public.retail_promotions set is_active = false where id = pc;

  -- =========================== returns ===========================================
  perform auth.login_as(u_cash);
  refused := false;
  begin perform public.retail_process_return(org, br, inv,
    jsonb_build_array(jsonb_build_object('variant_id', v2, 'quantity', 1)), 'cash');
  exception when sqlstate 'LB403' then refused := true; end;
  assert refused, 'a cashier cash-back needs the manager PIN';

  perform auth.login_as(u_owner);
  select * into r from public.retail_process_return(org, br, inv,
    jsonb_build_array(jsonb_build_object('variant_id', v2, 'quantity', 1)), 'cash', null, 'لا يعجبه');
  -- 2000 per unit, scaled by 24400/26000 for the invoice-level discounts.
  assert r.out_refund_cents = 1877, 'refund shares the invoice discount, got ' || r.out_refund_cents;
  perform auth.as_admin();
  assert (select cashback_approved_by from public.retail_returns where id = r.out_return_id) = u_owner, 'approver recorded';
  select quantity into q from public.retail_stock_levels where branch_id = br and variant_id = v1;

  perform auth.login_as(u_cash);
  select * into r from public.retail_process_return(org, br, inv,
    jsonb_build_array(jsonb_build_object('variant_id', v1, 'quantity', 1, 'condition', 'damaged', 'note', 'مكسورة')), 'store_credit');
  perform auth.as_admin();
  assert (select quantity from public.retail_stock_levels where branch_id = br and variant_id = v1) = q,
         'damaged goods come back and are written off';
  assert exists (select 1 from public.retail_stock_movements where ref_type = 'retail_return' and ref_id = r.out_return_id and reason = 'damage'),
         'the write-off is a damage movement';
  b := app.retail_store_credit_balance(org, cust);
  assert b = r.out_store_credit_cents and b = 9385, 'store credit issued, got ' || b;

  perform auth.login_as(u_cash);
  select * into r from public.retail_process_return(org, br, inv,
    jsonb_build_array(jsonb_build_object('variant_id', v2, 'quantity', 1)), 'exchange', null, 'مقاس',
    jsonb_build_array(jsonb_build_object('variant_id', v2, 'quantity', 2)), 'cash', 2000);
  inv2 := r.out_exchange_invoice_id;
  perform auth.as_admin();
  assert inv2 is not null and (select status from public.invoices where id = inv2) = 'paid', 'exchange invoice paid from credit: ' || coalesce((select status || ' ' || total_cents || ' ' || paid_cents from public.invoices where id = inv2), 'none');
  assert (select total_cents from public.invoices where id = inv2) = 3600, 'the new goods get the running promotion';
  assert app.retail_store_credit_balance(org, cust) = 9385, 'the exchange used exactly the returned value; the difference was paid in cash';

  perform auth.login_as(u_cash);
  refused := false;
  begin perform public.retail_process_return(org, br, inv,
    jsonb_build_array(jsonb_build_object('variant_id', v2, 'quantity', 2)), 'store_credit');
  exception when check_violation then refused := true; end;
  assert refused, 'cannot return more than was sold';
  refused := false;
  begin perform public.retail_store_credit_adjust(org, br, cust, 500, 'هدية'); exception when insufficient_privilege then refused := true; end;
  assert refused, 'a cashier cannot adjust store credit';
  perform auth.login_as(u_other);
  refused := false;
  begin perform public.retail_process_return(org, br, inv, jsonb_build_array(jsonb_build_object('variant_id', v2, 'quantity', 1)), 'cash');
  exception when insufficient_privilege then refused := true; end;
  assert refused, 'another org cannot touch the invoice';

  perform auth.login_as(u_owner);
  assert public.retail_store_credit_adjust(org, br, cust, -385, 'تسوية') = 9000, 'owner adjusts with their own approval';

  -- =========================== auto-reorder ===========================================
  perform auth.as_admin();
  update public.retail_variants set reorder_point = 200, reorder_qty = 120, preferred_supplier_id = sup where id = v2;
  update public.retail_variants set reorder_point = 100 where id = v1;
  perform auth.login_as(u_mgr);
  assert (select count(*) from public.retail_reorder_suggestions(org, br)) = 2, 'two variants under their point';
  select count(*) into n from public.retail_reorder_generate(org, br);
  assert n = 2, 'one draft per supplier group';
  perform auth.as_admin();
  assert (select quantity_ordered from public.retail_purchase_order_items i join public.retail_purchase_orders o on o.id = i.purchase_order_id
           where o.organization_id = org and o.auto_generated and i.variant_id = v2) = 120, 'reorder_qty used';
  assert (select total_cents from public.retail_purchase_orders where organization_id = org and supplier_id = sup and auto_generated) = 96000,
         'totals derived from cost';
  perform auth.login_as(u_mgr);
  assert (select count(*) from public.retail_reorder_generate(org, br)) = 0, 'no duplicate drafts while one is open';
  perform auth.login_as(u_cash);
  refused := false;
  begin perform public.retail_reorder_generate(org, br); exception when insufficient_privilege then refused := true; end;
  assert refused, 'cashiers cannot raise purchase orders';

  raise notice 'RETAIL OPERATIONS: all assertions passed';
end $$;
