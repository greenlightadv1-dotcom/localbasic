-- =============================================================================
-- LOCAL BASIC — restaurant hub (0117): add items to an open order, the
-- modifier builder (save, retire, copy), and order lines in Realtime
-- =============================================================================
\set ON_ERROR_STOP on

do $$
declare
  u_owner uuid; u_cash uuid; u_chef uuid; u_other uuid;
  org uuid; br uuid; org_b uuid; br_b uuid; m uuid;
  cat uuid; p_burger uuid; p_fries uuid; p_other uuid; v_burger uuid; v_fries uuid;
  t1 uuid; o uuid; g uuid; g2 uuid; mod_cheese uuid; mod_onion uuid; mod_x uuid;
  r record; n int; refused boolean; ids uuid[];
begin
  insert into auth.users (email) values ('r49-owner@test.local') returning id into u_owner;
  insert into auth.users (email) values ('r49-cash@test.local')  returning id into u_cash;
  insert into auth.users (email) values ('r49-chef@test.local')  returning id into u_chef;
  insert into auth.users (email) values ('r49-other@test.local') returning id into u_other;
  perform auth.login_as(u_owner);
  select out_organization_id, out_branch_id into org, br from public.provision_workspace('R49 Diner', 'r49diner', 'restaurant');
  perform auth.login_as(u_other);
  select out_organization_id, out_branch_id into org_b, br_b from public.provision_workspace('R49 Other', 'r49other', 'restaurant');

  perform auth.as_admin();
  for r in select * from (values (u_cash, 'cashier'), (u_chef, 'kitchen')) as x(u, k) loop
    insert into public.organization_members (organization_id, user_id, status, all_branches, joined_at)
    values (org, r.u, 'active', true, now()) returning id into m;
    insert into public.user_roles (member_id, role_id) select m, id from public.roles where organization_id = org and key = r.k;
  end loop;
  insert into public.restaurant_categories (organization_id, name, default_station_kind) values (org, 'سندوتشات', 'kitchen') returning id into cat;
  insert into public.restaurant_products (organization_id, category_id, name) values (org, cat, 'برجر') returning id into p_burger;
  insert into public.restaurant_variants (organization_id, product_id, name, price_cents) values (org, p_burger, 'default', 10000) returning id into v_burger;
  insert into public.restaurant_products (organization_id, category_id, name, tax_rate_bp) values (org, cat, 'بطاطس', 1400) returning id into p_fries;
  insert into public.restaurant_variants (organization_id, product_id, name, price_cents) values (org, p_fries, 'default', 2000) returning id into v_fries;
  insert into public.restaurant_products (organization_id, name) values (org_b, 'غريب') returning id into p_other;
  insert into public.restaurant_tables (organization_id, branch_id, name, seats) values (org, br, 'T1', 4) returning id into t1;

  -- ---- modifier builder ----------------------------------------------------
  perform auth.login_as(u_cash);
  refused := false;
  begin perform public.restaurant_modifier_group_save(org, null, p_burger, 'إضافات', 0, 2, true, '[]'::jsonb);
  exception when insufficient_privilege then refused := true; end;
  assert refused, 'a cashier cannot edit the menu';

  perform auth.login_as(u_owner);
  g := public.restaurant_modifier_group_save(org, null, p_burger, 'إضافات', 0, 2, true,
         '[{"name":"جبنة زيادة","price_cents":1500},{"name":"بدون بصل","price_cents":0},{"name":"الصوص جانبًا"}]'::jsonb);
  assert (select count(*) from public.restaurant_modifiers where group_id = g and is_active) = 3, 'three choices';
  select id into mod_cheese from public.restaurant_modifiers where group_id = g and name = 'جبنة زيادة';
  select id into mod_onion  from public.restaurant_modifiers where group_id = g and name = 'بدون بصل';
  select id into mod_x      from public.restaurant_modifiers where group_id = g and name = 'الصوص جانبًا';
  assert (select sort_order from public.restaurant_modifiers where id = mod_x) = 3, 'choices keep their order';

  refused := false;
  begin perform public.restaurant_modifier_group_save(org, null, p_burger, 'خطأ', 3, 2, true, '[]'::jsonb);
  exception when sqlstate '22023' then refused := true; end;
  assert refused, 'min above max is refused';
  refused := false;
  begin perform public.restaurant_modifier_group_save(org, null, p_burger, 'الحجم', 1, 1, true, '[]'::jsonb);
  exception when sqlstate '22023' then refused := true; end;
  assert refused, 'a required group needs choices';
  refused := false;
  begin perform public.restaurant_modifier_group_save(org, null, p_other, 'غريب', 0, 1, true, '[]'::jsonb);
  exception when check_violation then refused := true; end;
  assert refused, 'another organization''s product is refused';
  refused := false;
  begin perform public.restaurant_modifier_group_save(org, null, p_burger, 'سعر', 0, 1, true, '[{"name":"x","price_cents":-5}]'::jsonb);
  exception when sqlstate '22023' then refused := true; end;
  assert refused, 'a negative price is refused';

  -- Edit: rename the cheese, drop "sauce on the side" (retired, not deleted).
  perform public.restaurant_modifier_group_save(org, g, null, 'الإضافات', 0, 2, true,
    jsonb_build_array(jsonb_build_object('id', mod_cheese, 'name', 'جبنة شيدر زيادة', 'price_cents', 2000),
                      jsonb_build_object('id', mod_onion, 'name', 'بدون بصل', 'price_cents', 0)));
  assert (select name = 'جبنة شيدر زيادة' and price_cents = 2000 from public.restaurant_modifiers where id = mod_cheese), 'choice edited';
  assert exists (select 1 from public.restaurant_modifiers where id = mod_x and not is_active), 'a dropped choice is retired, not deleted';
  assert (select name from public.restaurant_modifier_groups where id = g) = 'الإضافات', 'group renamed';
  assert exists (select 1 from public.audit_logs where entity_id = g::text and action = 'restaurant.modifier_group.updated'), 'audited';

  -- Copy to the fries; a second copy is a no-op.
  n := public.restaurant_modifier_group_copy(org, g, array[p_fries, p_burger, p_other]);
  assert n = 1, 'copied to the fries only (not its own product, not another org)';
  select id into g2 from public.restaurant_modifier_groups where product_id = p_fries;
  assert (select count(*) from public.restaurant_modifiers where group_id = g2) = 2, 'only active choices are copied';
  assert public.restaurant_modifier_group_copy(org, g, array[p_fries]) = 0, 'copying twice does not double the group';

  -- ---- add items to an open order -----------------------------------------
  perform auth.login_as(u_cash);
  select out_order_id into o from public.restaurant_create_order(org, br,
    jsonb_build_array(jsonb_build_object('variant_id', v_burger, 'quantity', 1, 'modifier_ids', jsonb_build_array(mod_cheese))),
    t1, 'dine_in', 'cashier');
  assert (select total_cents from public.restaurant_orders where id = o) = 12000, 'first round: 100 + 20 cheese';
  perform public.restaurant_set_order_status(org, o, 'confirmed');

  -- The kitchen finishes the first round, the table orders more.
  perform auth.login_as(u_chef);
  select array_agg(id) into ids from public.restaurant_order_items where order_id = o;
  perform public.restaurant_kds_bump(org, ids, 'ready');
  assert (select status from public.restaurant_orders where id = o) = 'ready', 'order ready';

  refused := false;
  begin perform public.restaurant_order_add_items(org, o, jsonb_build_array(jsonb_build_object('variant_id', v_fries, 'quantity', 1)));
  exception when insufficient_privilege then refused := true; end;
  assert refused, 'the chef does not take orders';

  perform auth.login_as(u_cash);
  select * into r from public.restaurant_order_add_items(org, o,
    jsonb_build_array(jsonb_build_object('variant_id', v_fries, 'quantity', 2, 'note', 'مقرمشة')));
  -- fries 2 × 20 = 40, tax 14% = 5.60 → 4560 + the first 12000
  assert r.out_added = 1 and r.out_total_cents = 16560, format('totals cover every line (%s)', r.out_total_cents);
  assert (select subtotal_cents = 16000 and tax_cents = 560 from public.restaurant_orders where id = o), 'subtotal and tax recomputed';
  assert (select position from public.restaurant_order_items where order_id = o and variant_id = v_fries) = 2, 'new lines follow the old ones';
  assert (select status from public.restaurant_orders where id = o) = 'preparing', 'back to the kitchen';
  assert (select prep_status from public.restaurant_order_items where order_id = o and variant_id = v_burger) = 'ready', 'the finished burger stays finished';
  assert (select prep_status from public.restaurant_order_items where order_id = o and variant_id = v_fries) = 'queued', 'the fries are to cook';

  perform auth.login_as(u_owner);
  perform public.restaurant_modifier_group_save(org, g, null, 'الإضافات', 0, 1, true,
    jsonb_build_array(jsonb_build_object('id', mod_cheese, 'name', 'جبنة شيدر زيادة', 'price_cents', 2000),
                      jsonb_build_object('id', mod_onion, 'name', 'بدون بصل', 'price_cents', 0)));
  perform auth.login_as(u_cash);
  refused := false;
  begin perform public.restaurant_order_add_items(org, o, jsonb_build_array(jsonb_build_object('variant_id', v_burger, 'quantity', 1,
          'modifier_ids', jsonb_build_array(mod_cheese, mod_onion))));
  exception when check_violation then refused := true; end;
  assert refused, 'modifier rules apply to added items';
  assert (select count(*) from public.restaurant_order_items where order_id = o) = 2, 'a refused round adds nothing';

  -- Once payment starts, the check is closed to additions.
  perform public.restaurant_pay_order(org, o, 'cash', 5000, 0);
  refused := false;
  begin perform public.restaurant_order_add_items(org, o, jsonb_build_array(jsonb_build_object('variant_id', v_fries, 'quantity', 1)));
  exception when check_violation then refused := true; end;
  assert refused, 'a check being paid takes no more items';

  perform auth.login_as(u_other);
  refused := false;
  begin perform public.restaurant_order_add_items(org, o, jsonb_build_array(jsonb_build_object('variant_id', v_fries, 'quantity', 1)));
  exception when insufficient_privilege or check_violation then refused := true; end;
  assert refused, 'another organization cannot touch the order';

  raise notice 'RESTAURANT HUB: all assertions passed';
end $$;
