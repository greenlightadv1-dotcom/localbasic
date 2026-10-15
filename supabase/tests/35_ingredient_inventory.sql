-- =============================================================================
-- LOCAL BASIC — raw-material inventory (0102 + 0103): recipes, consumption on
-- confirmation, custody (issue → blind receipt → dispute), waste, requests,
-- alarms, and isolation.
-- =============================================================================
\set ON_ERROR_STOP on

do $$
declare
  u_owner uuid; u_store uuid; u_chef uuid; u_bar uuid; u_cash uuid; u_other uuid;
  org uuid; br uuid; org_b uuid; br_b uuid;
  m uuid; m_owner uuid;
  cat_food uuid; cat_drink uuid; p_salad uuid; v_salad uuid; p_juice uuid; v_juice uuid;
  i_tomato uuid; i_orange uuid; i_milk uuid;
  t1 uuid; t2 uuid; t3 uuid; req uuid; ord uuid; ord2 uuid; ord3 uuid; g uuid;
  loc_k uuid; loc_b uuid; loc_w uuid; loc_t uuid;
  r record; n int; q numeric; refused boolean; v_status text; v_err text;
begin
  insert into auth.users (email) values ('r35-owner@test.local') returning id into u_owner;
  insert into auth.users (email) values ('r35-store@test.local') returning id into u_store;
  insert into auth.users (email) values ('r35-chef@test.local')  returning id into u_chef;
  insert into auth.users (email) values ('r35-bar@test.local')   returning id into u_bar;
  insert into auth.users (email) values ('r35-cash@test.local')  returning id into u_cash;
  insert into auth.users (email) values ('r35-other@test.local') returning id into u_other;

  perform auth.login_as(u_owner);
  select out_organization_id, out_branch_id into org, br from public.provision_workspace('Inv Cafe', 'r35cafe', 'restaurant');
  perform auth.login_as(u_other);
  select out_organization_id, out_branch_id into org_b, br_b from public.provision_workspace('Inv Other', 'r35other', 'restaurant');
  perform auth.as_admin();

  -- Staff: storekeeper, chef (kitchen role), barista, cashier — one role each.
  for r in select * from (values (u_store, 'storekeeper'), (u_chef, 'kitchen'), (u_bar, 'barista'), (u_cash, 'cashier')) as x(u, k) loop
    insert into public.organization_members (organization_id, user_id, status, all_branches, joined_at)
    values (org, r.u, 'active', true, now()) returning id into m;
    insert into public.user_roles (member_id, role_id)
    select m, id from public.roles where organization_id = org and key = r.k;
  end loop;
  assert (select count(*) from public.roles where organization_id = org and key in ('storekeeper', 'main_cashier')) = 2,
    'new roles are cloned into new organizations';

  -- Menu: a kitchen dish and a bar drink.
  insert into public.restaurant_categories (organization_id, name, sort_order, default_station_kind) values (org, 'سلطات', 0, 'kitchen') returning id into cat_food;
  insert into public.restaurant_categories (organization_id, name, sort_order, default_station_kind) values (org, 'عصائر', 1, 'bar') returning id into cat_drink;
  insert into public.restaurant_products (organization_id, category_id, name) values (org, cat_food, 'سلطة طماطم') returning id into p_salad;
  insert into public.restaurant_variants (organization_id, product_id, name, price_cents) values (org, p_salad, 'default', 4000) returning id into v_salad;
  insert into public.restaurant_products (organization_id, category_id, name) values (org, cat_drink, 'عصير برتقال') returning id into p_juice;
  insert into public.restaurant_variants (organization_id, product_id, name, price_cents) values (org, p_juice, 'default', 3000) returning id into v_juice;

  -- ---- master data -------------------------------------------------------
  perform auth.login_as(u_store);
  i_tomato := public.inventory_item_save(org, null, 'طماطم', 'g');
  i_orange := public.inventory_item_save(org, null, 'برتقال', 'pc');
  i_milk   := public.inventory_item_save(org, null, 'حليب', 'ml');
  refused := false;
  begin perform public.inventory_item_save(org, null, ' طماطم ', 'g');
  exception when unique_violation then refused := true; end;
  assert refused, 'duplicate item names are refused';

  perform public.restaurant_recipe_save(org, v_salad, jsonb_build_array(jsonb_build_object('item_id', i_tomato, 'qty', 150)));
  perform public.restaurant_recipe_save(org, v_juice, jsonb_build_array(jsonb_build_object('item_id', i_orange, 'qty', 3)));
  perform auth.as_admin();
  assert exists (select 1 from public.audit_logs where organization_id = org and action = 'inventory.recipe.saved' and entity_id = v_salad::text),
    'recipe changes are audited';

  -- ---- stock in, issue, blind receipt ------------------------------------
  perform auth.login_as(u_store);
  perform public.inventory_stock_in(org, br, jsonb_build_array(
    jsonb_build_object('item_id', i_tomato, 'qty', 5000, 'unit_cost_cents', 0.5),
    jsonb_build_object('item_id', i_orange, 'qty', 50, 'unit_cost_cents', 300)), 'فاتورة 1');
  t1 := public.inventory_issue(org, br, 'kitchen', jsonb_build_array(jsonb_build_object('item_id', i_tomato, 'qty', 2000)));
  t2 := public.inventory_issue(org, br, 'bar',     jsonb_build_array(jsonb_build_object('item_id', i_orange, 'qty', 20)));
  perform auth.as_admin();
  loc_w := app.inventory_location(org, br, 'warehouse'); loc_t := app.inventory_location(org, br, 'transit');
  loc_k := app.inventory_location(org, br, 'kitchen');   loc_b := app.inventory_location(org, br, 'bar');
  assert (select qty from public.inventory_levels where location_id = loc_w and item_id = i_tomato) = 3000, 'warehouse after issue';
  assert (select qty from public.inventory_levels where location_id = loc_t and item_id = i_tomato) = 2000, 'issued stock sits in transit';
  assert not exists (select 1 from public.inventory_levels where location_id = loc_k and item_id = i_tomato and qty <> 0),
    'the kitchen owns nothing until it confirms';

  -- The warehouse cannot issue more than it has.
  perform auth.login_as(u_store);
  refused := false;
  begin perform public.inventory_issue(org, br, 'kitchen', jsonb_build_array(jsonb_build_object('item_id', i_tomato, 'qty', 999999)));
  exception when check_violation then refused := true; end;
  assert refused, 'warehouse may not go negative';

  -- The chef counts blind: issued quantities are hidden until received.
  perform auth.login_as(u_chef);
  assert (select count(*) from public.inventory_transfer_lines where transfer_id = t1) = 0, 'blind receipt: issued qty hidden';
  select out_line_id into g from public.inventory_transfer_items(org, t1);
  assert g is not null, 'the chef sees what to count (names only)';
  -- The chef cannot receive into the bar.
  refused := false;
  begin perform public.inventory_receive(org, t2, '[]'::jsonb);
  exception when insufficient_privilege then refused := true; end;
  assert refused, 'the kitchen cannot accept the bar''s stock';
  v_status := public.inventory_receive(org, t1, jsonb_build_array(jsonb_build_object('line_id', g, 'received_qty', 2000)));
  assert v_status = 'received', 'full receipt';
  assert (select count(*) from public.inventory_transfer_lines where transfer_id = t1) = 1, 'after receipt the lines are visible';

  -- The bar receives two oranges short: a dispute, the rest stays in transit.
  perform auth.login_as(u_bar);
  select out_line_id into g from public.inventory_transfer_items(org, t2);
  refused := false;
  begin perform public.inventory_receive(org, t2, jsonb_build_array(jsonb_build_object('line_id', g, 'received_qty', 25)));
  exception when check_violation then refused := true; end;
  assert refused, 'cannot receive more than was issued';
  v_status := public.inventory_receive(org, t2, jsonb_build_array(jsonb_build_object('line_id', g, 'received_qty', 18)));
  assert v_status = 'disputed', 'short receipt is a dispute';
  perform auth.as_admin();
  assert (select qty from public.inventory_levels where location_id = loc_b and item_id = i_orange) = 18, 'bar owns what it signed for';
  assert (select qty from public.inventory_levels where location_id = loc_t and item_id = i_orange) = 2, 'short part stays in transit';

  -- Two people: the owner may not issue and accept the same transfer.
  perform auth.login_as(u_owner);
  t3 := public.inventory_issue(org, br, 'kitchen', jsonb_build_array(jsonb_build_object('item_id', i_tomato, 'qty', 100)));
  select out_line_id into g from public.inventory_transfer_items(org, t3);
  refused := false;
  begin perform public.inventory_receive(org, t3, jsonb_build_array(jsonb_build_object('line_id', g, 'received_qty', 100)));
  exception when insufficient_privilege then refused := true; end;
  assert refused, 'issuer cannot also receive';
  perform public.inventory_transfer_cancel(org, t3);
  perform auth.as_admin();
  assert (select qty from public.inventory_levels where location_id = loc_w and item_id = i_tomato) = 3000, 'cancelled issue returns to the warehouse';

  -- Resolving the dispute needs a manager's PIN for the storekeeper.
  perform auth.login_as(u_owner);
  perform public.approval_set_pin(org, '2468');
  perform auth.as_admin();
  select id into m_owner from public.organization_members where organization_id = org and user_id = u_owner;
  perform auth.login_as(u_store);
  refused := false;
  begin perform public.inventory_transfer_resolve(org, t2, 'lost');
  exception when sqlstate 'LB403' then refused := true; end;
  assert refused, 'resolving a dispute needs approval';
  select out_grant, out_error into g, v_err from public.approval_grant(org, br, 'inventory.resolve', t2, null, m_owner, '2468');
  assert g is not null, format('owner PIN approves: %s', v_err);
  perform public.inventory_transfer_resolve(org, t2, 'lost');
  perform auth.as_admin();
  assert (select qty from public.inventory_levels where location_id = loc_t and item_id = i_orange) = 0, 'transit cleared';
  assert exists (select 1 from public.inventory_waste where organization_id = org and reason = 'transit_loss' and qty = 2), 'loss written off as waste';
  assert (select approved_by from public.inventory_movements where doc_id = t2 and reason = 'dispute_lost' limit 1) = u_owner,
    'the approver is on the ledger row';

  -- ---- consumption on confirmation ---------------------------------------
  perform auth.login_as(u_cash);
  select out_order_id into ord from public.restaurant_create_order(org, br,
    jsonb_build_array(jsonb_build_object('variant_id', v_salad, 'quantity', 2), jsonb_build_object('variant_id', v_juice, 'quantity', 1)),
    null, 'takeaway', 'cashier');
  perform auth.as_admin();
  assert (select qty from public.inventory_levels where location_id = loc_k and item_id = i_tomato) = 2000, 'nothing taken before confirmation';
  perform auth.login_as(u_cash);
  perform public.restaurant_set_order_status(org, ord, 'confirmed');
  perform auth.as_admin();
  assert (select qty from public.inventory_levels where location_id = loc_k and item_id = i_tomato) = 1700, 'kitchen: 2 × 150 g taken';
  assert (select qty from public.inventory_levels where location_id = loc_b and item_id = i_orange) = 15, 'bar: 1 × 3 oranges taken';

  -- Idempotent: consuming the same line again does nothing.
  for g in select id from public.restaurant_order_items where order_id = ord loop
    perform app.inventory_consume_line(g);
  end loop;
  assert (select qty from public.inventory_levels where location_id = loc_k and item_id = i_tomato) = 1700, 'never consumed twice';

  -- Cancelled before preparation (owner: approval.grant) → ingredients return.
  perform auth.login_as(u_owner);
  perform public.restaurant_set_order_status(org, ord, 'cancelled', 'طلب خاطئ');
  perform auth.as_admin();
  assert (select qty from public.inventory_levels where location_id = loc_k and item_id = i_tomato) = 2000, 'returned to kitchen';
  assert (select qty from public.inventory_levels where location_id = loc_b and item_id = i_orange) = 18, 'returned to bar';

  -- Cancelled after preparation began → no return; documented as waste.
  perform auth.login_as(u_cash);
  select out_order_id into ord2 from public.restaurant_create_order(org, br,
    jsonb_build_array(jsonb_build_object('variant_id', v_salad, 'quantity', 1)), null, 'takeaway', 'cashier');
  perform public.restaurant_set_order_status(org, ord2, 'confirmed');
  perform auth.login_as(u_chef);
  perform public.restaurant_set_order_status(org, ord2, 'preparing');
  perform auth.login_as(u_owner);
  perform public.restaurant_set_order_status(org, ord2, 'cancelled', 'العميل غادر');
  perform auth.as_admin();
  assert (select qty from public.inventory_levels where location_id = loc_k and item_id = i_tomato) = 1850, 'prepared food is not given back';
  assert exists (select 1 from public.inventory_waste where order_id = ord2 and reason = 'order_cancelled' and qty = 150 and not moved_stock),
    'cancelled-after-preparation recorded as waste';

  -- ---- alarms -------------------------------------------------------------
  perform auth.login_as(u_store);
  perform public.inventory_par_level_save(org, br, 'kitchen', i_tomato, 1800);
  perform auth.as_admin();
  assert (select count(*) from public.inventory_alerts where location_id = loc_k and item_id = i_tomato and resolved_at is null) = 0,
    'above the level: no alarm';
  perform auth.login_as(u_cash);
  select out_order_id into ord3 from public.restaurant_create_order(org, br,
    jsonb_build_array(jsonb_build_object('variant_id', v_salad, 'quantity', 1)), null, 'takeaway', 'cashier');
  perform public.restaurant_set_order_status(org, ord3, 'confirmed');
  perform auth.as_admin();
  assert (select kind from public.inventory_alerts where location_id = loc_k and item_id = i_tomato and resolved_at is null) = 'low',
    'dropping to the safety level opens a low alarm';
  -- A big order takes the kitchen below zero: allowed, alarm turns to "out".
  perform auth.login_as(u_cash);
  select out_order_id into ord3 from public.restaurant_create_order(org, br,
    jsonb_build_array(jsonb_build_object('variant_id', v_salad, 'quantity', 20)), null, 'takeaway', 'cashier');
  perform public.restaurant_set_order_status(org, ord3, 'confirmed');
  perform auth.as_admin();
  assert (select qty from public.inventory_levels where location_id = loc_k and item_id = i_tomato) = -1300, 'kitchen may go negative';
  assert (select count(*) from public.inventory_alerts where location_id = loc_k and item_id = i_tomato and resolved_at is null) = 1,
    'still exactly one open alarm';
  assert (select kind from public.inventory_alerts where location_id = loc_k and item_id = i_tomato and resolved_at is null) = 'out', 'alarm escalates to out';

  -- The chef can see the alarm (it is what the kitchen screen subscribes to).
  perform auth.login_as(u_chef);
  assert (select count(*) from public.inventory_alerts where branch_id = br and resolved_at is null) >= 1, 'chef sees alarms';

  -- ---- replenishment request → issue → receipt clears the alarm ----------
  req := public.inventory_request_create(org, br, 'kitchen', jsonb_build_array(jsonb_build_object('item_id', i_tomato, 'qty', 3000)), 'قبل الذروة');
  refused := false;
  begin perform public.inventory_request_create(org, br, 'bar', jsonb_build_array(jsonb_build_object('item_id', i_orange, 'qty', 5)));
  exception when insufficient_privilege then refused := true; end;
  assert refused, 'the kitchen cannot request for the bar';
  perform auth.login_as(u_store);
  t3 := public.inventory_issue(org, br, 'kitchen', jsonb_build_array(jsonb_build_object('item_id', i_tomato, 'qty', 3000)), req);
  perform auth.as_admin();
  assert (select status from public.inventory_requests where id = req) = 'fulfilled', 'request fulfilled by the issue';
  perform auth.login_as(u_chef);
  select out_line_id into g from public.inventory_transfer_items(org, t3);
  perform public.inventory_receive(org, t3, jsonb_build_array(jsonb_build_object('line_id', g, 'received_qty', 3000)));
  perform auth.as_admin();
  assert (select kind from public.inventory_alerts where location_id = loc_k and item_id = i_tomato and resolved_at is null) = 'low',
    'back above zero but under the level: the alarm returns to low';
  -- Top up past the safety level: the alarm resolves itself.
  perform auth.login_as(u_store);
  perform public.inventory_stock_in(org, br, jsonb_build_array(jsonb_build_object('item_id', i_tomato, 'qty', 1000, 'unit_cost_cents', 0.6)));
  t3 := public.inventory_issue(org, br, 'kitchen', jsonb_build_array(jsonb_build_object('item_id', i_tomato, 'qty', 500)));
  perform auth.login_as(u_chef);
  select out_line_id into g from public.inventory_transfer_items(org, t3);
  perform public.inventory_receive(org, t3, jsonb_build_array(jsonb_build_object('line_id', g, 'received_qty', 500)));
  perform auth.as_admin();
  assert (select qty from public.inventory_levels where location_id = loc_k and item_id = i_tomato) = 2200, 'kitchen topped up';
  assert (select count(*) from public.inventory_alerts where location_id = loc_k and item_id = i_tomato and resolved_at is null) = 0,
    'restocking above the level resolves the alarm';
  -- Moving average cost: 3000 g on hand at 0.5 plus 1000 g at 0.6.
  assert (select round(avg_cost_cents, 4) from public.inventory_items where id = i_tomato) between 0.5 and 0.6,
    'moving average cost updated on stock-in';
  perform auth.login_as(u_chef);

  -- ---- waste --------------------------------------------------------------
  perform auth.login_as(u_chef);
  perform public.inventory_record_waste(org, br, 'kitchen', i_tomato, 200, 'spoiled', null);
  refused := false;
  begin perform public.inventory_record_waste(org, br, 'bar', i_orange, 1, 'dropped', null);
  exception when insufficient_privilege then refused := true; end;
  assert refused, 'the kitchen cannot record the bar''s waste';
  refused := false;
  begin perform public.inventory_record_waste(org, br, 'kitchen', i_tomato, 10, 'other', '  ');
  exception when sqlstate '22023' then refused := true; end;
  assert refused, '"other" needs a note';
  perform auth.as_admin();
  assert (select qty from public.inventory_levels where location_id = loc_k and item_id = i_tomato) = 2000, 'waste leaves the kitchen';

  -- ---- manual adjustment needs approval -----------------------------------
  perform auth.login_as(u_store);
  refused := false;
  begin perform public.inventory_adjust(org, br, 'warehouse', i_milk, 1000, 'جرد');
  exception when sqlstate 'LB403' then refused := true; end;
  assert refused, 'storekeeper adjustment needs a manager PIN';
  select out_grant into g from public.approval_grant(org, br, 'inventory.adjust', i_milk, 1000, m_owner, '2468');
  perform public.inventory_adjust(org, br, 'warehouse', i_milk, 1000, 'جرد');
  perform auth.as_admin();
  assert (select qty from public.inventory_levels where location_id = loc_w and item_id = i_milk) = 1000, 'approved adjustment applied';

  -- The cashier has no stock access at all.
  perform auth.login_as(u_cash);
  assert (select count(*) from public.inventory_levels) = 0, 'cashier reads no stock';
  refused := false;
  begin perform public.inventory_stock_in(org, br, jsonb_build_array(jsonb_build_object('item_id', i_milk, 'qty', 1)));
  exception when insufficient_privilege then refused := true; end;
  assert refused, 'cashier cannot stock in';

  -- ---- isolation ----------------------------------------------------------
  perform auth.login_as(u_other);
  assert (select count(*) from public.inventory_items where organization_id = org) = 0, 'another store reads none of our items';
  refused := false;
  begin perform public.inventory_issue(org, br, 'kitchen', jsonb_build_array(jsonb_build_object('item_id', i_tomato, 'qty', 1)));
  exception when insufficient_privilege then refused := true; end;
  assert refused, 'another store cannot issue our stock';
  refused := false;
  begin perform public.inventory_stock_in(org_b, br_b, jsonb_build_array(jsonb_build_object('item_id', i_tomato, 'qty', 1)));
  exception when check_violation then refused := true; end;
  assert refused, 'our item id is "not found" in another store';
  refused := false;
  begin perform public.restaurant_recipe_save(org_b, v_salad, '[]'::jsonb);
  exception when check_violation then refused := true; end;
  assert refused, 'cannot write a recipe onto another store''s dish';

  -- ---- the ledger is append-only ------------------------------------------
  perform auth.as_admin();
  refused := false;
  begin update public.inventory_movements set qty = 1 where organization_id = org;
  exception when check_violation then refused := true; end;
  assert refused, 'movements cannot be edited';
  refused := false;
  begin delete from public.inventory_movements where organization_id = org;
  exception when check_violation then refused := true; end;
  assert refused, 'movements cannot be deleted';
  -- …except with their organization.
  delete from public.organizations where id = org_b;

  -- The projection always equals the ledger.
  select count(*) into n from public.inventory_levels l
   where l.organization_id = org
     and l.qty <> (select coalesce(sum(m.qty), 0) from public.inventory_movements m where m.location_id = l.location_id and m.item_id = l.item_id);
  assert n = 0, 'levels equal the sum of movements';

  raise notice 'ingredient inventory OK';
end $$;
