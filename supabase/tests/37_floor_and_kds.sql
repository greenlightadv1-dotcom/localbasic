-- =============================================================================
-- LOCAL BASIC — floor plan, table operations, waiting list, KDS (0105)
-- =============================================================================
\set ON_ERROR_STOP on

do $$
declare
  u_owner uuid; u_cash uuid; u_chef uuid; u_bar uuid; u_other uuid;
  org uuid; br uuid; org_b uuid; br_b uuid; m uuid; m_owner uuid;
  cat_food uuid; cat_drink uuid; p uuid; v_burger uuid; v_juice uuid;
  st_grill uuid; st_bar uuid; sec uuid;
  t1 uuid; t2 uuid; t3 uuid; t4 uuid; t_big uuid; t_other uuid;
  o1 uuid; o2 uuid; o3 uuid; o_new uuid; g uuid; v_err text;
  i_beef uuid; i_orange uuid; loc_k uuid; loc_b uuid;
  item_b uuid; item_j uuid; ids uuid[];
  w1 uuid; w2 uuid; q int; n int; refused boolean; a jsonb; total_before bigint;
  lvl_beef numeric; r record;
begin
  insert into auth.users (email) values ('r37-owner@test.local') returning id into u_owner;
  insert into auth.users (email) values ('r37-cash@test.local')  returning id into u_cash;
  insert into auth.users (email) values ('r37-chef@test.local')  returning id into u_chef;
  insert into auth.users (email) values ('r37-bar@test.local')   returning id into u_bar;
  insert into auth.users (email) values ('r37-other@test.local') returning id into u_other;
  perform auth.login_as(u_owner);
  select out_organization_id, out_branch_id into org, br from public.provision_workspace('R37 Grill', 'r37grill', 'restaurant');
  perform auth.login_as(u_other);
  select out_organization_id, out_branch_id into org_b, br_b from public.provision_workspace('R37 Other', 'r37other', 'restaurant');
  perform auth.as_admin();
  select id into m_owner from public.organization_members where organization_id = org and user_id = u_owner;
  for r in select * from (values (u_cash, 'cashier'), (u_chef, 'kitchen'), (u_bar, 'barista')) as x(u, k) loop
    insert into public.organization_members (organization_id, user_id, status, all_branches, joined_at)
    values (org, r.u, 'active', true, now()) returning id into m;
    insert into public.user_roles (member_id, role_id) select m, id from public.roles where organization_id = org and key = r.k;
  end loop;

  insert into public.restaurant_stations (organization_id, branch_id, name, kind) values (org, br, 'الشواية', 'kitchen') returning id into st_grill;
  insert into public.restaurant_stations (organization_id, branch_id, name, kind) values (org, br, 'البار', 'bar') returning id into st_bar;
  insert into public.restaurant_categories (organization_id, name, default_station_kind) values (org, 'مشويات', 'kitchen') returning id into cat_food;
  insert into public.restaurant_categories (organization_id, name, default_station_kind) values (org, 'عصائر', 'bar') returning id into cat_drink;
  insert into public.restaurant_products (organization_id, category_id, name) values (org, cat_food, 'برجر') returning id into p;
  insert into public.restaurant_variants (organization_id, product_id, name, price_cents) values (org, p, 'default', 10000) returning id into v_burger;
  insert into public.restaurant_products (organization_id, category_id, name) values (org, cat_drink, 'عصير') returning id into p;
  insert into public.restaurant_variants (organization_id, product_id, name, price_cents) values (org, p, 'default', 3000) returning id into v_juice;
  insert into public.restaurant_sections (organization_id, branch_id, name) values (org, br, 'الصالة') returning id into sec;
  insert into public.restaurant_tables (organization_id, branch_id, section_id, name, seats) values (org, br, sec, 'T1', 4) returning id into t1;
  insert into public.restaurant_tables (organization_id, branch_id, section_id, name, seats) values (org, br, sec, 'T2', 4) returning id into t2;
  insert into public.restaurant_tables (organization_id, branch_id, section_id, name, seats) values (org, br, sec, 'T3', 2) returning id into t3;
  insert into public.restaurant_tables (organization_id, branch_id, section_id, name, seats) values (org, br, sec, 'T4', 2) returning id into t4;
  insert into public.restaurant_tables (organization_id, branch_id, section_id, name, seats) values (org, br, sec, 'Big', 10) returning id into t_big;
  insert into public.restaurant_tables (organization_id, branch_id, name) values (org_b, br_b, 'X1') returning id into t_other;

  -- Recipes, and stock at the kitchen and bar.
  perform auth.login_as(u_owner);
  perform public.approval_set_pin(org, '4826');
  i_beef   := public.inventory_item_save(org, null, 'لحم', 'g');
  i_orange := public.inventory_item_save(org, null, 'برتقال', 'pc');
  perform public.restaurant_recipe_save(org, v_burger, jsonb_build_array(jsonb_build_object('item_id', i_beef, 'qty', 150)));
  perform public.restaurant_recipe_save(org, v_juice,  jsonb_build_array(jsonb_build_object('item_id', i_orange, 'qty', 3)));
  perform auth.as_admin();
  loc_k := app.inventory_location(org, br, 'kitchen');
  loc_b := app.inventory_location(org, br, 'bar');
  perform app.inventory_move(org, br, loc_k, i_beef, 10000, 'adjustment');
  perform app.inventory_move(org, br, loc_b, i_orange, 100, 'adjustment');

  -- ---- floor plan ---------------------------------------------------------
  perform auth.login_as(u_cash);
  refused := false;
  begin perform public.restaurant_floor_layout_save(org, br, jsonb_build_array(jsonb_build_object('id', t1, 'x', 10, 'y', 10)));
  exception when insufficient_privilege then refused := true; end;
  assert refused, 'a cashier cannot redesign the floor';
  perform auth.login_as(u_owner);
  n := public.restaurant_floor_layout_save(org, br, jsonb_build_array(
    jsonb_build_object('id', t1, 'section_id', sec, 'x', 10, 'y', 15, 'w', 12, 'h', 12, 'shape', 'round'),
    jsonb_build_object('id', t2, 'section_id', sec, 'x', 140, 'y', -5, 'w', 99, 'h', 1, 'shape', 'bogus')));
  assert n = 2, 'layout saved';
  assert (select layout_x = 100 and layout_y = 0 and layout_w = 60 and layout_h = 4 and shape = 'square'
            from public.restaurant_tables where id = t2), 'positions are clamped, unknown shapes ignored';
  refused := false;
  begin perform public.restaurant_floor_layout_save(org, br, jsonb_build_array(jsonb_build_object('id', t_other, 'x', 1, 'y', 1)));
  exception when check_violation then refused := true; end;
  assert refused, 'another store''s table cannot be placed';

  -- ---- KDS: one ticket, two stations -------------------------------------
  perform auth.login_as(u_cash);
  select out_order_id into o1 from public.restaurant_create_order(org, br, jsonb_build_array(
    jsonb_build_object('variant_id', v_burger, 'quantity', 2),
    jsonb_build_object('variant_id', v_juice, 'quantity', 1)), t1);
  perform public.restaurant_set_order_status(org, o1, 'confirmed');
  perform auth.as_admin();
  select id into item_b from public.restaurant_order_items where order_id = o1 and variant_id = v_burger;
  select id into item_j from public.restaurant_order_items where order_id = o1 and variant_id = v_juice;
  assert (select station_id from public.restaurant_order_items where id = item_b) = st_grill, 'burger routed to the grill';
  assert (select station_id from public.restaurant_order_items where id = item_j) = st_bar, 'juice routed to the bar';
  assert (select prep_status from public.restaurant_order_items where id = item_b) = 'queued', 'lines start queued';
  assert (select qty from public.inventory_levels where location_id = loc_k and item_id = i_beef) = 9700, 'recipe consumed on confirm';

  perform auth.login_as(u_chef);
  refused := false;
  begin perform public.restaurant_kds_bump(org, array[item_j], 'ready');
  exception when insufficient_privilege then refused := true; end;
  assert refused, 'the chef cannot bump the bar''s line';
  perform public.restaurant_kds_bump(org, array[item_b], 'preparing');
  perform auth.as_admin();
  assert (select status from public.restaurant_orders where id = o1) = 'preparing', 'first started line starts the order';
  assert (select prep_status from public.restaurant_order_items where id = item_j) = 'queued', 'the bar''s line is untouched';

  perform auth.login_as(u_chef);
  perform public.restaurant_kds_bump(org, array[item_b], 'ready');
  perform auth.as_admin();
  assert (select status from public.restaurant_orders where id = o1) = 'preparing', 'not ready until every station is';
  perform auth.login_as(u_bar);
  perform public.restaurant_kds_bump(org, array[item_j], 'ready');
  perform auth.as_admin();
  assert (select status from public.restaurant_orders where id = o1) = 'ready', 'last ready line readies the order';
  assert (select prepared_by from public.restaurant_order_items where id = item_b) = u_chef, 'who prepared it is recorded';
  perform auth.login_as(u_bar);
  refused := false;
  begin perform public.restaurant_kds_bump(org, array[item_j], 'queued');
  exception when check_violation then refused := true; end;
  assert refused, 'a ready order cannot be pulled back line by line';

  -- Analytics: managers and owners only.
  perform auth.login_as(u_cash);
  refused := false;
  begin perform public.restaurant_kitchen_analytics(org, br, 7);
  exception when insufficient_privilege then refused := true; end;
  assert refused, 'the cashier cannot read kitchen analytics';
  perform auth.login_as(u_owner);
  a := public.restaurant_kitchen_analytics(org, br, 7);
  assert (a -> 'overall' ->> 'lines')::int = 2, 'two prepared lines';
  assert jsonb_array_length(a -> 'by_item') = 2 and jsonb_array_length(a -> 'by_station') = 2, 'per item and per station';
  assert exists (select 1 from jsonb_array_elements(a -> 'by_chef') x where (x ->> 'user_id')::uuid = u_chef), 'per chef';

  -- ---- cancellation is decided line by line -------------------------------
  perform auth.login_as(u_cash);
  select out_order_id into o2 from public.restaurant_create_order(org, br, jsonb_build_array(
    jsonb_build_object('variant_id', v_burger, 'quantity', 1),
    jsonb_build_object('variant_id', v_juice, 'quantity', 2)), t2);
  perform public.restaurant_set_order_status(org, o2, 'confirmed');
  perform auth.as_admin();
  select id into item_b from public.restaurant_order_items where order_id = o2 and variant_id = v_burger;
  perform auth.login_as(u_chef);
  perform public.restaurant_kds_bump(org, array[item_b], 'preparing');
  perform auth.login_as(u_owner);
  perform public.restaurant_set_order_status(org, o2, 'cancelled', 'العميل غادر');
  perform auth.as_admin();
  assert (select qty from public.inventory_levels where location_id = loc_b and item_id = i_orange) = 100 - 3, 'the untouched juice went back';
  assert (select qty from public.inventory_levels where location_id = loc_k and item_id = i_beef) = 9550, 'the started burger did not';
  assert exists (select 1 from public.inventory_waste where order_id = o2 and item_id = i_beef and qty = 150 and not moved_stock),
    'the started burger is waste';
  assert not exists (select 1 from public.inventory_waste where order_id = o2 and item_id = i_orange), 'the juice is not waste';

  -- ---- transfer ------------------------------------------------------------
  perform auth.login_as(u_owner);
  perform public.restaurant_set_order_status(org, o1, 'served');
  perform auth.login_as(u_cash);
  n := public.restaurant_table_transfer(org, t1, t3);
  assert n = 1, 'one order moved';
  perform auth.as_admin();
  assert (select table_id from public.restaurant_orders where id = o1) = t3, 'the order is on the new table';
  assert (select status from public.restaurant_tables where id = t3) = 'occupied', 'new table occupied';
  assert (select status from public.restaurant_tables where id = t1) = 'cleaning', 'old table to be cleaned';
  assert exists (select 1 from public.audit_logs where action = 'restaurant.table.transferred' and entity_id = t1::text), 'transfer audited';
  perform auth.login_as(u_cash);
  refused := false;
  begin perform public.restaurant_table_transfer(org, t3, t_other);
  exception when check_violation then refused := true; end;
  assert refused, 'cannot transfer to another store''s table';

  -- ---- merge ---------------------------------------------------------------
  perform auth.login_as(u_cash);
  select out_order_id into o3 from public.restaurant_create_order(org, br, jsonb_build_array(
    jsonb_build_object('variant_id', v_burger, 'quantity', 1)), t4);
  refused := false;
  begin perform public.restaurant_table_merge(org, t3, array[t4]);
  exception when check_violation then refused := true; end;
  assert refused, 'unconfirmed orders must be confirmed before a merge';
  perform public.restaurant_set_order_status(org, o3, 'confirmed');
  perform auth.as_admin();
  lvl_beef := (select qty from public.inventory_levels where location_id = loc_k and item_id = i_beef);
  perform auth.login_as(u_cash);
  total_before := (select sum(total_cents) from public.restaurant_orders where id in (o1, o3));
  refused := false;
  begin perform public.restaurant_table_merge(org, t3, array[t4]);
  exception when sqlstate 'LB403' then refused := true; end;
  assert refused, 'a sub-cashier needs a manager PIN to merge';
  select out_grant into g from public.approval_grant(org, br, 'table.merge', t3, null, m_owner, '4826');
  o_new := public.restaurant_table_merge(org, t3, array[t4]);
  perform auth.as_admin();
  assert o_new = o3, 'the check is the least advanced order (confirmed, not served)';
  assert (select count(*) from public.restaurant_order_items where order_id = o3) = 3, 'all lines on one check';
  assert (select total_cents from public.restaurant_orders where id = o3) = total_before, 'nothing gained or lost';
  assert (select status from public.restaurant_orders where id = o1) = 'completed'
     and (select merged_into_order_id from public.restaurant_orders where id = o1) = o3, 'the emptied served order is closed into the check';
  assert (select table_id from public.restaurant_orders where id = o3) = t3, 'the check sits on the target table';
  assert (select merged_into from public.restaurant_tables where id = t4) = t3, 'T4 shares T3''s check';
  assert (select qty from public.inventory_levels where location_id = loc_k and item_id = i_beef) = lvl_beef, 'a merge moves no stock';
  assert exists (select 1 from public.audit_logs where action = 'restaurant.table.merged' and entity_id = t3::text
                   and (after ->> 'approved_by')::uuid = u_owner), 'merge audited with its approver';

  -- ---- split ---------------------------------------------------------------
  -- Two of the three lines' units: one burger of the two, out of the served order's lines.
  perform auth.as_admin();
  select id into item_b from public.restaurant_order_items where order_id = o3 and variant_id = v_burger and quantity = 2;
  total_before := (select total_cents from public.restaurant_orders where id = o3);
  perform auth.login_as(u_cash);
  refused := false;
  begin perform public.restaurant_check_split(org, o3, jsonb_build_array(jsonb_build_object('item_id', item_b, 'qty', 1)));
  exception when sqlstate 'LB403' then refused := true; end;
  assert refused, 'a sub-cashier needs a manager PIN to split';
  select out_grant into g from public.approval_grant(org, br, 'check.split', o3, null, m_owner, '4826');
  select out_order_id into o_new from public.restaurant_check_split(org, o3, jsonb_build_array(jsonb_build_object('item_id', item_b, 'qty', 1)));
  perform auth.as_admin();
  assert (select quantity from public.restaurant_order_items where id = item_b) = 1, 'one burger stays';
  assert (select quantity from public.restaurant_order_items where order_id = o_new) = 1, 'one burger moves';
  assert (select split_from from public.restaurant_order_items where order_id = o_new) = item_b, 'the moved part points at its line';
  assert (select total_cents from public.restaurant_orders where id = o3) + (select total_cents from public.restaurant_orders where id = o_new)
         = total_before, 'the two checks add up to the original';
  assert (select status from public.restaurant_orders where id = o_new) = (select status from public.restaurant_orders where id = o3), 'same stage';
  assert (select qty from public.inventory_levels where location_id = loc_k and item_id = i_beef) = lvl_beef, 'a split consumes nothing';

  -- Everything on the merged check is queued (o3 was only confirmed), so
  -- cancelling both checks returns exactly what they consumed, shared by quantity.
  perform auth.login_as(u_owner);
  perform public.restaurant_set_order_status(org, o_new, 'cancelled', 'اختبار');
  perform auth.as_admin();
  assert (select status from public.restaurant_tables where id = t3) = 'occupied', 'closing one of two checks keeps the table busy';
  perform auth.login_as(u_owner);
  perform public.restaurant_set_order_status(org, o3, 'cancelled', 'اختبار');
  perform auth.as_admin();
  -- o3 held: its own burger (queued, 150) + o1's two burgers (ready → waste) + o1's juice (ready → waste).
  assert (select qty from public.inventory_levels where location_id = loc_k and item_id = i_beef) = lvl_beef + 150,
    'the queued burger came back; the prepared ones are waste';
  assert (select coalesce(sum(qty), 0) from public.inventory_waste where order_id in (o3, o_new) and item_id = i_beef) = 300,
    'two prepared burgers written off, across the two checks';
  assert (select status from public.restaurant_tables where id = t3) = 'cleaning', 'the table is freed';
  assert (select merged_into from public.restaurant_tables where id = t4) is null
     and (select status from public.restaurant_tables where id = t4) = 'cleaning', 'its merged partner is freed with it';

  -- ---- waiting list ---------------------------------------------------------
  perform auth.login_as(u_chef);
  refused := false;
  begin perform public.restaurant_waitlist_add(org, br, 'عائلة', null, 4);
  exception when insufficient_privilege then refused := true; end;
  assert refused, 'the kitchen does not run the waiting list';
  perform auth.login_as(u_cash);
  select out_id, out_quoted_min into w1, q from public.restaurant_waitlist_add(org, br, 'عائلة أحمد', '01000000000', 4);
  assert q = 0, 'a free table that fits: no wait';
  perform auth.as_admin();
  update public.restaurant_tables set status = 'available' where organization_id = org and seats >= 4 and status = 'cleaning';
  update public.restaurant_tables set status = 'occupied' where organization_id = org and seats >= 4 and status <> 'occupied';
  perform auth.login_as(u_cash);
  q := public.restaurant_waitlist_estimate(org, br, 4);
  assert q > 0, 'every big-enough table taken: a positive wait';
  assert public.restaurant_waitlist_estimate(org, br, 30) is null, 'no table seats thirty';
  select out_id into w2 from public.restaurant_waitlist_add(org, br, 'حجز سارة', null, 2, 'reservation', now() + interval '2 hours');
  perform public.restaurant_waitlist_action(org, w2, 'assign', t4);
  perform auth.as_admin();
  assert (select status from public.restaurant_tables where id = t4) = 'reserved', 'a held table shows reserved';
  perform auth.login_as(u_cash);
  perform public.restaurant_waitlist_action(org, w2, 'seat');
  perform auth.as_admin();
  assert (select status from public.restaurant_tables where id = t4) = 'occupied', 'seated';
  assert (select status from public.restaurant_waitlist where id = w2) = 'seated', 'entry closed as seated';
  perform auth.login_as(u_cash);
  perform public.restaurant_waitlist_action(org, w1, 'assign', t3);
  perform public.restaurant_waitlist_action(org, w1, 'cancel');
  perform auth.as_admin();
  assert (select status from public.restaurant_tables where id = t3) = 'available', 'a cancelled hold frees its table';
  -- Isolation: another store sees none of it.
  perform auth.login_as(u_other);
  assert (select count(*) from public.restaurant_waitlist where organization_id = org) = 0, 'waitlist is private';
  refused := false;
  begin perform public.restaurant_waitlist_action(org, w1, 'notify');
  exception when check_violation or insufficient_privilege then refused := true; end;
  assert refused, 'another store cannot touch it';

  perform auth.as_admin();
  raise notice 'floor and kds OK';
end $$;
