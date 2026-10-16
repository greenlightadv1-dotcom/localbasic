-- =============================================================================
-- LOCAL BASIC — executive analytics (0110): basket, cost variance, SOS, RFM,
-- KPIs, margin alerts, campaigns and automated re-engagement
-- =============================================================================
\set ON_ERROR_STOP on

do $$
declare
  u_owner uuid; u_mgr uuid; u_cash uuid; u_other uuid;
  org uuid; br uuid; org_b uuid; br_b uuid; m uuid;
  cat uuid; p_b uuid; p_f uuid; p_c uuid; v_b uuid; v_f uuid; v_c uuid; i_beef uuid;
  o uuid; orders uuid[] := array[]::uuid[]; j jsonb; r record; refused boolean; n int; tot int;
  phones text[] := array['01011111111', '+20 101 111 1111', '01022222222', '01033333333'];
  baskets jsonb := '[["b","f"],["b","f","c"],["b"],["c"]]'::jsonb;
  lines jsonb; x text; k int;
begin
  insert into auth.users (email) values ('r42-owner@test.local') returning id into u_owner;
  insert into auth.users (email) values ('r42-mgr@test.local')   returning id into u_mgr;
  insert into auth.users (email) values ('r42-cash@test.local')  returning id into u_cash;
  insert into auth.users (email) values ('r42-other@test.local') returning id into u_other;
  perform auth.login_as(u_owner);
  select out_organization_id, out_branch_id into org, br from public.provision_workspace('R42 Grill', 'r42grill', 'restaurant');
  perform auth.login_as(u_other);
  select out_organization_id, out_branch_id into org_b, br_b from public.provision_workspace('R42 Other', 'r42other', 'restaurant');
  perform auth.as_admin();
  for r in select * from (values (u_mgr, 'manager'), (u_cash, 'cashier')) as t(u, kk) loop
    insert into public.organization_members (organization_id, user_id, status, all_branches, joined_at)
    values (org, r.u, 'active', true, now()) returning id into m;
    insert into public.user_roles (member_id, role_id) select m, id from public.roles where organization_id = org and key = r.kk;
  end loop;
  assert exists (select 1 from public.role_permissions rp join public.roles ro on ro.id = rp.role_id
                  where ro.organization_id = org and ro.key = 'manager' and rp.permission_key = 'restaurant.analytics.executive'),
         'managers see the executive dashboard';
  assert not exists (select 1 from public.role_permissions rp join public.roles ro on ro.id = rp.role_id
                      where ro.organization_id = org and ro.key = 'cashier' and rp.permission_key like 'restaurant.%executive'),
         'cashiers do not';

  insert into public.restaurant_categories (organization_id, name, default_station_kind) values (org, 'وجبات', 'kitchen') returning id into cat;
  insert into public.restaurant_products (organization_id, category_id, name) values (org, cat, 'برجر') returning id into p_b;
  insert into public.restaurant_variants (organization_id, product_id, name, price_cents) values (org, p_b, 'default', 5000) returning id into v_b;
  insert into public.restaurant_products (organization_id, category_id, name) values (org, cat, 'بطاطس') returning id into p_f;
  insert into public.restaurant_variants (organization_id, product_id, name, price_cents) values (org, p_f, 'default', 2000) returning id into v_f;
  insert into public.restaurant_products (organization_id, category_id, name) values (org, cat, 'كولا') returning id into p_c;
  insert into public.restaurant_variants (organization_id, product_id, name, price_cents) values (org, p_c, 'default', 1500) returning id into v_c;

  -- Beef at 5 cents/g; a burger is 150 g → cost 750 on a 5000 price (85% margin).
  perform auth.login_as(u_owner);
  i_beef := public.inventory_item_save(org, null, 'لحم', 'g');
  perform public.inventory_stock_in(org, br, jsonb_build_array(jsonb_build_object('item_id', i_beef, 'qty', 10000, 'unit_cost_cents', 5)), 'افتتاحي');
  perform public.restaurant_recipe_save(org, v_b, jsonb_build_array(jsonb_build_object('item_id', i_beef, 'qty', 150)));
  -- Run the commit-time recipe check now (each request is its own transaction in the app).
  set constraints public.restaurant_recipe_lines_margin_check immediate;
  set constraints public.restaurant_recipe_lines_margin_check deferred;
  perform auth.as_admin();
  assert not exists (select 1 from public.restaurant_margin_alerts where organization_id = org), 'a healthy margin raises nothing';

  -- ---- four completed orders --------------------------------------------------------
  for k in 0..3 loop
    lines := '[]'::jsonb;
    for x in select jsonb_array_elements_text(baskets -> k) loop
      lines := lines || jsonb_build_object('variant_id', case x when 'b' then v_b when 'f' then v_f else v_c end, 'quantity', 1);
    end loop;
    perform auth.login_as(u_owner);
    select out_order_id into o from public.restaurant_create_order(org, br, lines, null, case when k = 3 then 'delivery' else 'takeaway' end);
    perform auth.as_admin();
    update public.restaurant_orders set guest_phone = phones[k + 1], guest_name = 'عميل ' || k where id = o;
    perform auth.login_as(u_owner);
    perform public.restaurant_set_order_status(org, o, 'confirmed');
    perform public.restaurant_set_order_status(org, o, 'preparing');
    perform public.restaurant_set_order_status(org, o, 'ready');
    perform public.restaurant_set_order_status(org, o, 'served');
    perform public.restaurant_pay_order(org, o, 'cash', 100000, 0);
    perform public.restaurant_set_order_status(org, o, 'completed');
    orders := orders || o;
  end loop;

  -- ---- market basket ------------------------------------------------------------------
  perform auth.login_as(u_cash);
  refused := false;
  begin perform * from public.restaurant_market_basket(org, null, now() - interval '1 day', now() + interval '1 minute');
  exception when insufficient_privilege then refused := true; end;
  assert refused, 'a cashier has no executive analytics';
  perform auth.login_as(u_mgr);
  select * into r from public.restaurant_market_basket(org, null, now() - interval '1 day', now() + interval '1 minute', 2)
   where (out_a_product = p_b and out_b_product = p_f) or (out_a_product = p_f and out_b_product = p_b);
  assert r.out_together = 2 and r.out_total_orders = 4, format('pair counts %s', row_to_json(r));
  assert r.out_support = 0.5, 'support = 2/4';
  assert round(r.out_lift, 3) = round(2.0 * 4 / (3 * 2), 3), format('lift %s', r.out_lift);
  assert (case when r.out_a_product = p_b then r.out_conf_a_b else r.out_conf_b_a end) = round(2.0 / 3, 4), 'confidence burger → fries';
  assert not exists (select 1 from public.restaurant_market_basket(org, null, now() - interval '1 day', now() + interval '1 minute', 2)
                      where p_c in (out_a_product, out_b_product)), 'pairs seen once are below the minimum';

  -- ---- speed of service ----------------------------------------------------------------
  select sum(out_n) into tot from public.restaurant_sos_stages(org, br, now() - interval '1 day', now() + interval '1 minute') where out_stage = 'total';
  assert tot = 4, format('every served order has a total time (%s)', tot);
  assert exists (select 1 from public.restaurant_sos_stages(org, br, now() - interval '1 day', now() + interval '1 minute')
                  where out_type = 'delivery' and out_stage = 'accept'), 'by order type';
  assert (select sum(out_orders) from public.restaurant_sos_hourly(org, br, now() - interval '1 day', now() + interval '1 minute')) = 4, 'hourly';

  -- ---- RFM base data --------------------------------------------------------------------
  select count(*) into n from public.restaurant_rfm_customers(org, 365);
  assert n = 3, format('two phone formats are one customer (%s)', n);
  select * into r from public.restaurant_rfm_customers(org, 365) where out_phone_key = '011111111';
  assert r.out_orders = 2 and r.out_monetary_cents > 0, format('frequency and monetary %s', row_to_json(r));
  assert (select out_delivery_orders from public.restaurant_rfm_customers(org, 365) where out_phone_key = '033333333') = 1, 'delivery orders counted';

  -- ---- KPIs --------------------------------------------------------------------------------
  perform auth.login_as(u_owner);
  perform public.inventory_record_waste(org, br, 'warehouse', i_beef, 100, 'burnt', null);
  perform auth.login_as(u_mgr);
  j := public.restaurant_executive_kpis(org, br, now() - interval '1 day', now() + interval '1 minute');
  assert (j ->> 'orders')::int = 4, 'orders';
  assert (j ->> 'cogs_cents')::numeric = 3 * 750, format('COGS from consumption (%s)', j ->> 'cogs_cents');
  assert (j ->> 'waste_manual_cents')::numeric = 500, 'manual waste';
  assert (j ->> 'net_revenue_cents')::bigint = (j ->> 'gross_cents')::bigint - (j ->> 'tax_cents')::bigint, 'net of tax';
  assert (j ->> 'inventory_now_cents')::numeric = 9900 * 5, format('inventory value (%s)', j ->> 'inventory_now_cents');
  assert (j ->> 'inventory_start_cents')::numeric = 0, 'nothing on hand before the period';

  -- ---- margin alerts on an ingredient price hike ------------------------------------------
  perform auth.login_as(u_owner);
  perform public.inventory_stock_in(org, br, jsonb_build_array(jsonb_build_object('item_id', i_beef, 'qty', 10000, 'unit_cost_cents', 40)), 'غالي');
  perform auth.as_admin();
  select * into r from public.restaurant_margin_alerts where variant_id = v_b and status = 'open';
  assert r.id is not null and r.margin_bp < 6500 and r.floor_bp = 6500 and r.cause_item_id = i_beef, format('alert opened %s', row_to_json(r));
  assert (select count(*) from public.notifications where organization_id = org and template = 'restaurant.margin.below_floor') = 2,
         'owner and manager are notified in-app';
  assert not exists (select 1 from public.notifications where organization_id = org and template = 'restaurant.margin.below_floor' and user_id = u_cash),
         'not the cashier';
  perform auth.login_as(u_owner);
  perform public.inventory_stock_in(org, br, jsonb_build_array(jsonb_build_object('item_id', i_beef, 'qty', 100, 'unit_cost_cents', 60)), null);
  perform auth.as_admin();
  assert (select count(*) from public.restaurant_margin_alerts where variant_id = v_b) = 1, 'one alert, updated, not duplicated';
  assert (select count(*) from public.notifications where organization_id = org and template = 'restaurant.margin.below_floor') = 2, 'no repeat notifications';
  -- Re-saving the recipe (delete + insert) does not reopen it.
  perform auth.login_as(u_owner);
  perform public.restaurant_recipe_save(org, v_b, jsonb_build_array(jsonb_build_object('item_id', i_beef, 'qty', 150)));
  -- Run the commit-time recipe check now (each request is its own transaction in the app).
  set constraints public.restaurant_recipe_lines_margin_check immediate;
  set constraints public.restaurant_recipe_lines_margin_check deferred;
  perform auth.as_admin();
  assert (select count(*) from public.restaurant_margin_alerts where variant_id = v_b) = 1, 'a recipe re-save keeps the same alert';
  -- A lower floor resolves it.
  perform auth.login_as(u_owner);
  perform public.restaurant_analytics_settings_save(org, 3000, 14, false, 'whatsapp', 1000, 14, null);
  perform auth.as_admin();
  assert (select status from public.restaurant_margin_alerts where variant_id = v_b) = 'resolved', 'margin back above the floor';

  -- ---- live cost variance ---------------------------------------------------------------------
  perform auth.login_as(u_mgr);
  select * into r from public.restaurant_food_cost_variance(org, now() - interval '1 hour') where out_variant_id = v_b;
  assert r.out_live_cost = 150 * 60, format('live = latest purchase price (%s)', r.out_live_cost);
  assert r.out_book_cost < r.out_live_cost, 'the books lag the market';
  select * into r from public.restaurant_ingredient_price_changes(org, now() - interval '1 hour') where out_item_id = i_beef;
  assert r.out_price_now = 60 and r.out_purchases = 3 and r.out_used_in = 1, format('price changes %s', row_to_json(r));

  -- ---- campaigns ---------------------------------------------------------------------------------
  perform auth.login_as(u_cash);
  refused := false;
  begin perform public.restaurant_campaign_send(org, 'x', 'vip', 'sms', 'hi', '[{"phone":"01011111111"}]'::jsonb, null, null);
  exception when insufficient_privilege then refused := true; end;
  assert refused, 'a cashier cannot send campaigns';
  perform auth.login_as(u_mgr);
  j := public.restaurant_campaign_send(org, 'VIP شكر', 'vip', 'whatsapp', 'شكرًا لك!',
         '[{"phone":"01011111111","name":"أ"},{"phone":"01099999999","name":"غريب"}]'::jsonb, 1500, 7);
  assert (j ->> 'recipients')::int = 1, format('only real customers (%s)', j);
  assert (j ->> 'code') like 'BACK-%', 'a promo code';
  perform auth.as_admin();
  assert (select max_uses = 1 and percent_bp = 1500 and kind = 'code' from public.restaurant_promotions where organization_id = org and code = j ->> 'code'),
         'capped at the recipients';
  assert (select count(*) from public.notifications where organization_id = org and template = 'restaurant.campaign'
            and channel = 'whatsapp' and recipient = '01011111111' and payload ->> 'code' = j ->> 'code') = 1, 'one queued message';
  perform auth.login_as(u_mgr);
  j := public.restaurant_campaign_send(org, 'مرة ثانية', 'vip', 'sms', 'تاني', '[{"phone":"01011111111"}]'::jsonb, null, null);
  assert (j ->> 'recipients')::int = 0 and (j ->> 'skipped_recent')::int = 1, 'nobody hears from us twice in a week';
  refused := false;
  begin perform public.restaurant_campaign_send(org, 'x', 'vip', 'sms', '   ', '[{"phone":"01022222222"}]'::jsonb, null, null);
  exception when sqlstate '22023' then refused := true; end;
  assert refused, 'an empty message is refused';

  -- ---- automated re-engagement ------------------------------------------------------------------
  perform auth.as_admin();
  -- Customer 2 (two orders) last ordered 20 days ago; customer 3 (one order) too.
  update public.restaurant_orders set placed_at = now() - interval '20 days'
   where id in (orders[1], orders[2], orders[4]);
  perform auth.as_service_role();
  j := public.restaurant_analytics_worker();
  assert (j ->> 'organizations')::int = 0, 'off by default';
  perform auth.login_as(u_mgr);
  perform public.restaurant_analytics_settings_save(org, 3000, 14, true, 'sms', 1000, 14, 'وحشتنا');
  perform auth.as_service_role();
  j := public.restaurant_analytics_worker();
  assert (j #>> '{runs,0,result,recipients}')::int = 0, format('the only lapsed regular was messaged this week (%s)', j);
  -- Clear the recent contact (as if a month passed) and run again.
  perform auth.as_admin();
  update public.restaurant_campaign_recipients set created_at = now() - interval '31 days' where organization_id = org;
  update public.restaurant_analytics_settings set last_reengage_run_at = null where organization_id = org;
  perform auth.as_service_role();
  j := public.restaurant_analytics_worker();
  assert (j #>> '{runs,0,result,recipients}')::int = 1, format('lapsed regular re-engaged (%s)', j);
  perform auth.as_admin();
  assert exists (select 1 from public.restaurant_campaigns where organization_id = org and auto_generated and segment = 'lapsed'
                  and channel = 'sms' and promo_code is not null), 'an automatic campaign with its code';
  assert not exists (select 1 from public.restaurant_campaign_recipients cr join public.restaurant_campaigns c on c.id = cr.campaign_id
                      where c.auto_generated and cr.phone_key = '033333333'), 'one-time customers are not chased';
  perform auth.as_service_role();
  j := public.restaurant_analytics_worker();
  assert j #>> '{runs,0,result,skipped}' = 'ran_recently', 'once a day';
  perform auth.login_as(u_mgr);
  refused := false;
  begin perform public.restaurant_analytics_worker();
  exception when insufficient_privilege then refused := true; end;
  assert refused, 'the worker is the service''s alone';

  -- ---- isolation -----------------------------------------------------------------------------------
  perform auth.login_as(u_other);
  assert (select count(*) from public.restaurant_campaigns where organization_id = org) = 0, 'other org: no campaigns';
  assert (select count(*) from public.restaurant_margin_alerts where organization_id = org) = 0, 'no alerts';
  assert (select count(*) from public.restaurant_campaign_recipients where organization_id = org) = 0, 'no recipients';
  refused := false;
  begin perform public.restaurant_executive_kpis(org, null, now() - interval '1 day', now());
  exception when insufficient_privilege then refused := true; end;
  assert refused, 'no KPIs';
  perform auth.login_as(u_cash);
  assert (select count(*) from public.restaurant_margin_alerts where organization_id = org) = 0, 'a cashier sees no margins';

  raise notice 'test 42 ok';
end $$;
