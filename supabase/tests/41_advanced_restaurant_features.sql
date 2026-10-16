-- =============================================================================
-- LOCAL BASIC — recipe costing, BOM deduction, wastage, automated purchasing,
-- menu engineering (0109 over 0102)
-- =============================================================================
\set ON_ERROR_STOP on

do $$
declare
  u_owner uuid; u_store uuid; u_chef uuid; u_cash uuid; u_other uuid;
  org uuid; br uuid; org_b uuid; br_b uuid; m uuid;
  cat uuid; p_salad uuid; v_salad uuid; p_juice uuid; v_juice uuid;
  i_tomato uuid; i_orange uuid; i_milk uuid; sup uuid;
  loc_w uuid; loc_k uuid; o1 uuid; o2 uuid; j jsonb; po_or uuid; po_tom uuid;
  r record; refused boolean; q numeric; n int; k_before numeric;
begin
  insert into auth.users (email) values ('r41-owner@test.local') returning id into u_owner;
  insert into auth.users (email) values ('r41-store@test.local') returning id into u_store;
  insert into auth.users (email) values ('r41-chef@test.local')  returning id into u_chef;
  insert into auth.users (email) values ('r41-cash@test.local')  returning id into u_cash;
  insert into auth.users (email) values ('r41-other@test.local') returning id into u_other;
  perform auth.login_as(u_owner);
  select out_organization_id, out_branch_id into org, br from public.provision_workspace('R41 Bistro', 'r41bistro', 'restaurant');
  perform auth.login_as(u_other);
  select out_organization_id, out_branch_id into org_b, br_b from public.provision_workspace('R41 Other', 'r41other', 'restaurant');
  perform auth.as_admin();
  for r in select * from (values (u_store, 'storekeeper'), (u_chef, 'kitchen'), (u_cash, 'cashier')) as x(u, k) loop
    insert into public.organization_members (organization_id, user_id, status, all_branches, joined_at)
    values (org, r.u, 'active', true, now()) returning id into m;
    insert into public.user_roles (member_id, role_id) select m, id from public.roles where organization_id = org and key = r.k;
  end loop;
  assert exists (select 1 from public.role_permissions rp join public.roles ro on ro.id = rp.role_id
                  where ro.organization_id = org and ro.key = 'storekeeper' and rp.permission_key = 'inventory.purchase'),
         'the storekeeper may purchase';
  assert not exists (select 1 from public.role_permissions rp join public.roles ro on ro.id = rp.role_id
                      where ro.organization_id = org and ro.key = 'cashier' and rp.permission_key = 'inventory.purchase'),
         'a cashier may not';

  insert into public.restaurant_categories (organization_id, name, default_station_kind) values (org, 'سلطات', 'kitchen') returning id into cat;
  insert into public.restaurant_products (organization_id, category_id, name) values (org, cat, 'سلطة') returning id into p_salad;
  insert into public.restaurant_variants (organization_id, product_id, name, price_cents) values (org, p_salad, 'default', 4000) returning id into v_salad;
  insert into public.restaurant_products (organization_id, category_id, name) values (org, cat, 'عصير') returning id into p_juice;
  insert into public.restaurant_variants (organization_id, product_id, name, price_cents) values (org, p_juice, 'default', 3000) returning id into v_juice;

  -- ---- items, cost, recipes (BOM) -----------------------------------------------
  perform auth.login_as(u_store);
  i_tomato := public.inventory_item_save(org, null, 'طماطم', 'g');
  i_orange := public.inventory_item_save(org, null, 'برتقال', 'pc');
  i_milk   := public.inventory_item_save(org, null, 'حليب', 'ml');
  perform public.inventory_stock_in(org, br, jsonb_build_array(
    jsonb_build_object('item_id', i_tomato, 'qty', 5000, 'unit_cost_cents', 2),
    jsonb_build_object('item_id', i_orange, 'qty', 50, 'unit_cost_cents', 300)), 'افتتاحي');
  -- Salad: 150 g tomato + 1 orange slice-piece; juice: 3 oranges.
  perform public.restaurant_recipe_save(org, v_salad, jsonb_build_array(
    jsonb_build_object('item_id', i_tomato, 'qty', 150), jsonb_build_object('item_id', i_orange, 'qty', 1)));
  perform public.restaurant_recipe_save(org, v_juice, jsonb_build_array(jsonb_build_object('item_id', i_orange, 'qty', 3)));

  select * into r from public.restaurant_recipe_costs(org) where out_variant_id = v_salad;
  assert r.out_cost_cents = 150 * 2 + 1 * 300 and r.out_line_count = 2 and not r.out_missing_cost and r.out_price_cents = 4000,
         format('salad recipe cost %s', row_to_json(r));
  select * into r from public.restaurant_recipe_costs(org) where out_variant_id = v_juice;
  assert r.out_cost_cents = 900, 'juice cost';
  assert (select sum(line_cost_cents) from public.restaurant_recipe_items where variant_id = v_salad) = 600,
         'the recipe_items view prices each line';
  assert (select unit from public.restaurant_recipe_items where variant_id = v_juice) = 'pc', 'with its unit';
  -- A line on an item never costed is flagged.
  perform public.restaurant_recipe_save(org, v_juice, jsonb_build_array(
    jsonb_build_object('item_id', i_orange, 'qty', 3), jsonb_build_object('item_id', i_milk, 'qty', 50)));
  assert (select out_missing_cost from public.restaurant_recipe_costs(org) where out_variant_id = v_juice), 'uncosted item flagged';
  perform public.restaurant_recipe_save(org, v_juice, jsonb_build_array(jsonb_build_object('item_id', i_orange, 'qty', 3)));

  -- ---- BOM deduction on confirmation, restored on early cancel ----------------------
  perform auth.as_admin();
  loc_w := app.inventory_location(org, br, 'warehouse');
  loc_k := app.inventory_location(org, br, 'kitchen');
  select coalesce(qty, 0) into k_before from public.inventory_levels where location_id = loc_k and item_id = i_tomato;
  k_before := coalesce(k_before, 0);
  perform auth.login_as(u_cash);
  select out_order_id into o1 from public.restaurant_create_order(org, br, jsonb_build_array(
    jsonb_build_object('variant_id', v_salad, 'quantity', 2)));
  perform auth.as_admin();
  assert coalesce((select qty from public.inventory_levels where location_id = loc_k and item_id = i_tomato), 0) = k_before,
         'nothing leaves before the order is confirmed';
  perform auth.login_as(u_cash);
  perform public.restaurant_set_order_status(org, o1, 'confirmed');
  perform auth.as_admin();
  assert (select qty from public.inventory_levels where location_id = loc_k and item_id = i_tomato) = k_before - 300,
         'confirmation deducts recipe × quantity from the station';
  assert (select qty from public.inventory_levels where location_id = loc_k and item_id = i_orange) = -2,
         'every recipe line is deducted (a station may go negative)';
  perform auth.login_as(u_cash);
  select out_order_id into o2 from public.restaurant_create_order(org, br, jsonb_build_array(jsonb_build_object('variant_id', v_juice, 'quantity', 1)));
  perform public.restaurant_set_order_status(org, o2, 'confirmed');
  perform auth.as_admin();
  assert (select qty from public.inventory_levels where location_id = loc_k and item_id = i_orange) = -5, 'juice: 3 more oranges';
  -- (A cashier would need a manager's PIN to cancel a confirmed order — 0103.)
  perform auth.login_as(u_owner);
  perform public.restaurant_set_order_status(org, o2, 'cancelled', 'غلط');
  perform auth.as_admin();
  assert (select qty from public.inventory_levels where location_id = loc_k and item_id = i_orange) = -2,
         'cancelling before preparation puts the stock back';

  -- ---- wastage ------------------------------------------------------------------
  perform auth.login_as(u_store);
  perform public.inventory_record_waste(org, br, 'warehouse', i_tomato, 200, 'burnt', 'احترقت في الفرن');
  perform public.inventory_record_waste(org, br, 'warehouse', i_tomato, 50, 'tasting', null);
  refused := false;
  begin perform public.inventory_record_waste(org, br, 'warehouse', i_tomato, 50, 'stolen', null);
  exception when sqlstate '22023' then refused := true; end;
  assert refused, 'unknown waste reasons are refused';
  assert (select count(*) from public.restaurant_wastage_logs where organization_id = org and reason in ('burnt', 'tasting')) = 2,
         'the wastage view lists the new reasons';
  assert (select cost_cents from public.restaurant_wastage_logs where reason = 'burnt' and organization_id = org) = 400, 'waste is costed';
  assert (select location_kind from public.restaurant_wastage_logs where reason = 'tasting' and organization_id = org) = 'warehouse', 'with its location';
  perform auth.as_admin();
  assert (select qty from public.inventory_levels where location_id = loc_w and item_id = i_tomato) = 4750, 'waste left the warehouse';

  -- ---- thresholds, suggestions, automatic purchase orders ---------------------------------
  perform auth.login_as(u_store);
  perform public.inventory_threshold_save(org, br, 'warehouse', i_tomato, 6000, null);   -- refill to 2 × min
  perform public.inventory_threshold_save(org, br, 'warehouse', i_orange, 100, 200);     -- buy 200 at a time
  perform public.inventory_threshold_save(org, br, 'warehouse', i_milk, 0, null);        -- nothing to buy at 0/0
  refused := false;
  begin perform public.inventory_threshold_save(org, br, 'warehouse', i_milk, 10, -5);
  exception when sqlstate '22023' or check_violation then refused := true; end;
  assert refused, 'a negative reorder quantity is refused';
  select * into r from public.restaurant_inventory_thresholds where inventory_item_id = i_orange and location_kind = 'warehouse';
  assert r.below_min and r.on_hand_qty = 50 and r.reorder_qty = 200 and r.min_stock_qty = 100, format('threshold view %s', row_to_json(r));

  sup := public.restaurant_supplier_save(org, null, 'سوق العبور', '0100000000', null, true);
  perform public.inventory_item_set_supplier(org, i_orange, sup);
  select * into r from public.restaurant_reorder_suggestions(org, br) where out_item_id = i_tomato;
  assert r.out_suggested = 2 * 6000 - 4750, format('refill to twice the minimum (%s)', r.out_suggested);
  select * into r from public.restaurant_reorder_suggestions(org, br) where out_item_id = i_orange;
  assert r.out_suggested = 200 and r.out_supplier_id = sup, 'the reorder quantity and the preferred supplier';
  assert not exists (select 1 from public.restaurant_reorder_suggestions(org, br) where out_item_id = i_milk), 'nothing at 0/0';

  perform auth.login_as(u_cash);
  refused := false;
  begin perform public.restaurant_po_generate(org, br);
  exception when insufficient_privilege then refused := true; end;
  assert refused, 'a cashier cannot generate purchase orders';

  perform auth.login_as(u_store);
  j := public.restaurant_po_generate(org, br);
  assert (j ->> 'count')::int = 2, format('one order per supplier (%s)', j);
  select id into po_or from public.restaurant_purchase_orders where branch_id = br and supplier_id = sup;
  select id into po_tom from public.restaurant_purchase_orders where branch_id = br and supplier_id is null;
  assert (select auto_generated and status = 'draft' and number like 'PO-%' from public.restaurant_purchase_orders where id = po_or), 'a numbered automatic draft';
  assert (select qty_ordered from public.restaurant_purchase_order_items where purchase_order_id = po_or and item_id = i_orange) = 200, 'ordered qty';
  assert (select unit_cost_cents from public.restaurant_purchase_order_items where purchase_order_id = po_tom and item_id = i_tomato) = 2,
         'priced at the average cost';
  j := public.restaurant_po_generate(org, br);
  assert (j ->> 'count')::int = 0, 'items covered by an open order are not ordered again';

  -- Edit the tomato draft, send it, then no more edits; cancel it.
  perform public.restaurant_po_save(org, br, po_tom, null, 'تعديل', null, jsonb_build_array(
    jsonb_build_object('item_id', i_tomato, 'qty', 8000, 'unit_cost_cents', 2.5)));
  assert (select qty_ordered from public.restaurant_purchase_order_items where purchase_order_id = po_tom) = 8000, 'draft edited';
  perform public.restaurant_po_set_status(org, po_tom, 'sent');
  refused := false;
  begin perform public.restaurant_po_save(org, br, po_tom, null, null, null, jsonb_build_array(jsonb_build_object('item_id', i_tomato, 'qty', 1)));
  exception when check_violation then refused := true; end;
  assert refused, 'a sent order is not edited';
  perform public.restaurant_po_set_status(org, po_tom, 'cancelled');
  assert exists (select 1 from public.restaurant_reorder_suggestions(org, br) where out_item_id = i_tomato), 'a cancelled order no longer covers the item';

  -- Receive the oranges short and dearer: stock and moving-average cost follow.
  perform public.restaurant_po_set_status(org, po_or, 'sent');
  j := public.restaurant_po_receive(org, po_or, jsonb_build_array(jsonb_build_object('item_id', i_orange, 'qty', 180, 'unit_cost_cents', 320)), null);
  assert (j ->> 'total_cents')::numeric = 180 * 320, 'received value';
  perform auth.as_admin();
  assert (select qty from public.inventory_levels where location_id = loc_w and item_id = i_orange) = 50 + 180, 'received into the warehouse';
  assert (select round(avg_cost_cents, 2) from public.inventory_items where id = i_orange) = round((50 * 300 + 180 * 320)::numeric / 230, 2),
         'moving-average cost updated';
  assert (select status from public.restaurant_purchase_orders where id = po_or) = 'received', 'order closed';
  assert (select qty_received from public.restaurant_purchase_order_items where purchase_order_id = po_or) = 180, 'received qty kept';
  perform auth.login_as(u_store);
  refused := false;
  begin perform public.restaurant_po_receive(org, po_or, jsonb_build_array(jsonb_build_object('item_id', i_orange, 'qty', 1)), null);
  exception when check_violation then refused := true; end;
  assert refused, 'an order is received once';
  assert not exists (select 1 from public.restaurant_reorder_suggestions(org, br) where out_item_id = i_orange), 'oranges are above the minimum now';

  -- ---- menu engineering --------------------------------------------------------------------
  perform auth.login_as(u_owner);
  perform public.restaurant_set_order_status(org, o1, 'preparing');
  perform public.restaurant_set_order_status(org, o1, 'ready');
  perform public.restaurant_set_order_status(org, o1, 'served');
  perform public.restaurant_pay_order(org, o1, 'cash', 100000, 0);
  perform public.restaurant_set_order_status(org, o1, 'completed');
  select * into r from public.restaurant_menu_engineering(org, br, now() - interval '1 day', now() + interval '1 minute') where out_variant_id = v_salad;
  assert r.out_qty_sold = 2 and r.out_revenue_cents = 8000 and r.out_has_recipe, format('sales %s', row_to_json(r));
  assert round(r.out_unit_cost_cents, 2) = round(150 * 2 + (50 * 300 + 180 * 320)::numeric / 230, 2), 'unit cost at today''s average';
  assert not exists (select 1 from public.restaurant_menu_engineering(org, br, now() - interval '1 day', now() + interval '1 minute')
                      where out_variant_id = v_juice), 'a cancelled order is not a sale';
  perform auth.login_as(u_chef);
  refused := false;
  begin perform * from public.restaurant_menu_engineering(org, br, now() - interval '1 day', now());
  exception when insufficient_privilege then refused := true; end;
  assert refused, 'the kitchen does not see margins';

  -- ---- isolation ------------------------------------------------------------------------
  perform auth.login_as(u_other);
  assert (select count(*) from public.restaurant_purchase_orders where organization_id = org) = 0, 'other org: no orders';
  assert (select count(*) from public.restaurant_purchase_order_items where organization_id = org) = 0, 'no order lines';
  assert (select count(*) from public.restaurant_suppliers where organization_id = org) = 0, 'no suppliers';
  assert (select count(*) from public.restaurant_recipe_items where organization_id = org) = 0, 'views follow the base RLS';
  assert (select count(*) from public.restaurant_wastage_logs where organization_id = org) = 0, 'no waste';
  assert (select count(*) from public.restaurant_inventory_thresholds where organization_id = org) = 0, 'no thresholds';
  refused := false;
  begin perform * from public.restaurant_recipe_costs(org);
  exception when insufficient_privilege then refused := true; end;
  assert refused, 'no costs for another organization';
  refused := false;
  begin perform public.restaurant_po_generate(org, br);
  exception when insufficient_privilege then refused := true; end;
  assert refused, 'nor purchase orders';
  perform auth.login_as(u_store);
  refused := false;
  begin insert into public.restaurant_purchase_orders (organization_id, branch_id, number) values (org, br, 'X-1');
  exception when insufficient_privilege then refused := true; end;
  assert refused, 'orders are written only through the functions';

  raise notice 'test 41 ok';
end $$;
