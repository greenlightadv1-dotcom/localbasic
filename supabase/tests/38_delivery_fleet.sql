-- =============================================================================
-- LOCAL BASIC — call center, dispatch, driver custody & commission, intake (0106)
-- =============================================================================
\set ON_ERROR_STOP on

do $$
declare
  u_owner uuid; u_cash uuid; u_drv uuid; u_drv2 uuid; u_settler uuid; u_other uuid;
  org uuid; br uuid; org_b uuid; br_b uuid; m uuid; m_owner uuid; m_drv uuid; m_drv2 uuid; role_settle uuid;
  cat uuid; p uuid; v uuid; z uuid; drv uuid; drv2 uuid; cust uuid; addr uuid; integ uuid;
  o1 uuid; o2 uuid; o3 uuid; g uuid; r record; j jsonb; refused boolean; acct uuid;
  bal record; n bigint; inv uuid;
begin
  insert into auth.users (email) values ('r38-owner@test.local') returning id into u_owner;
  insert into auth.users (email) values ('r38-cash@test.local')  returning id into u_cash;
  insert into auth.users (email) values ('r38-drv@test.local')   returning id into u_drv;
  insert into auth.users (email) values ('r38-drv2@test.local')  returning id into u_drv2;
  insert into auth.users (email) values ('r38-settle@test.local') returning id into u_settler;
  insert into auth.users (email) values ('r38-other@test.local') returning id into u_other;
  perform auth.login_as(u_owner);
  select out_organization_id, out_branch_id into org, br from public.provision_workspace('R38 Kitchen', 'r38kitchen', 'restaurant');
  perform public.approval_set_pin(org, '4826');
  perform auth.login_as(u_other);
  select out_organization_id, out_branch_id into org_b, br_b from public.provision_workspace('R38 Other', 'r38other', 'restaurant');
  perform auth.as_admin();
  select id into m_owner from public.organization_members where organization_id = org and user_id = u_owner;
  assert exists (select 1 from public.roles where organization_id = org and key = 'driver'), 'the driver role is cloned into new organizations';

  for r in select * from (values (u_cash, 'cashier'), (u_drv, 'driver'), (u_drv2, 'driver')) as x(u, k) loop
    insert into public.organization_members (organization_id, user_id, status, all_branches, joined_at)
    values (org, r.u, 'active', true, now()) returning id into m;
    insert into public.user_roles (member_id, role_id) select m, id from public.roles where organization_id = org and key = r.k;
    if r.u = u_drv then m_drv := m; elsif r.u = u_drv2 then m_drv2 := m; end if;
  end loop;
  -- A settler without approval rights, to see the PIN gates.
  insert into public.roles (organization_id, key, name_ar, name_en, is_system, is_owner, module_key)
  values (org, 'r38_settler', 'تسوية', 'Settler', false, false, 'restaurant') returning id into role_settle;
  insert into public.role_permissions (role_id, permission_key)
  values (role_settle, 'restaurant.driver.settle'), (role_settle, 'restaurant.pos.use'), (role_settle, 'payment.create'),
         (role_settle, 'restaurant.pos.discount'), (role_settle, 'restaurant.driver.manage');
  insert into public.organization_members (organization_id, user_id, status, all_branches, joined_at)
  values (org, u_settler, 'active', true, now()) returning id into m;
  insert into public.user_roles (member_id, role_id) values (m, role_settle);

  insert into public.restaurant_categories (organization_id, name) values (org, 'وجبات') returning id into cat;
  insert into public.restaurant_products (organization_id, category_id, name) values (org, cat, 'كشري') returning id into p;
  insert into public.restaurant_variants (organization_id, product_id, name, price_cents) values (org, p, 'default', 10000) returning id into v;

  -- ---- zones and drivers -----------------------------------------------------
  perform auth.login_as(u_cash);
  refused := false;
  begin perform public.restaurant_delivery_zone_save(org, br, null, 'المعادي', 2000, 1500);
  exception when insufficient_privilege then refused := true; end;
  assert refused, 'a cashier does not set zones';
  perform auth.login_as(u_owner);
  z := public.restaurant_delivery_zone_save(org, br, null, 'المعادي', 2000, 1500);
  drv := public.restaurant_driver_save(org, br, null, 'حسن', '01111111111', m_drv, 'موتوسيكل', 'zone', 0, 0);
  drv2 := public.restaurant_driver_save(org, br, null, 'سيد', '01222222222', m_drv2, null, 'percent', 1000, 0);
  perform auth.login_as(u_drv);
  perform public.restaurant_driver_shift(org, drv, true);
  refused := false;
  begin perform public.restaurant_driver_shift(org, drv2, true);
  exception when insufficient_privilege then refused := true; end;
  assert refused, 'a driver clocks only themself in';

  -- ---- call center -----------------------------------------------------------
  perform auth.login_as(u_cash);
  j := public.restaurant_callcenter_lookup(org, br, '0100 000 0000');
  assert jsonb_array_length(j -> 'customers') = 0, 'unknown caller';
  cust := public.restaurant_customer_upsert(org, br, null, 'منى علي', '01000000000', 'تفضل الاتصال قبل الوصول');
  assert public.restaurant_customer_upsert(org, br, null, 'منى', '+20 100-000-0000') = cust, 'same phone, another format: same customer';
  addr := public.restaurant_customer_address_save(org, br, cust, null, 'البيت', null, null, 'القاهرة', 'المعادي', 'شارع 9 عمارة 12', 'بجوار الصيدلية', true);
  j := public.restaurant_callcenter_lookup(org, br, '+201000000000');
  assert jsonb_array_length(j -> 'customers') = 1 and jsonb_array_length(j -> 'addresses') = 1, 'found with the saved address';

  select out_order_id into o1 from public.restaurant_callcenter_place_order(org, br, cust, 'delivery',
    jsonb_build_array(jsonb_build_object('variant_id', v, 'quantity', 2)), jsonb_build_object('id', addr), z, null, true);
  perform auth.as_admin();
  select * into r from public.restaurant_orders where id = o1;
  assert r.channel = 'phone' and r.type = 'delivery' and r.status = 'confirmed', 'a confirmed phone delivery order';
  assert r.delivery_fee_cents = 2000 and r.total_cents = 22000, 'zone fee on the bill';
  assert r.guest_phone = '01000000000' and r.guest_name = 'منى', 'the caller is on the order (for loyalty)';
  assert (select address from public.restaurant_order_deliveries where order_id = o1) = 'شارع 9 عمارة 12', 'address snapshotted';
  assert (select status from public.restaurant_delivery_jobs where order_id = o1) = 'pending', 'a delivery job waits for a driver';
  perform auth.login_as(u_cash);
  j := public.restaurant_callcenter_lookup(org, br, '01000000000');
  assert jsonb_array_length(j -> 'orders') = 1
     and (j -> 'orders' -> 0 -> 'lines' -> 0 ->> 'variant_id')::uuid = v, 'order history recalls the lines to repeat';
  perform auth.login_as(u_other);
  refused := false;
  begin perform public.restaurant_callcenter_lookup(org, br, '01000000000');
  exception when insufficient_privilege then refused := true; end;
  assert refused, 'another store cannot look up our callers';

  -- ---- dispatch --------------------------------------------------------------
  perform auth.login_as(u_cash);
  perform public.restaurant_delivery_assign(org, o1, drv);
  refused := false;
  begin perform public.restaurant_delivery_status(org, o1, 'dispatched');
  exception when check_violation then refused := true; end;
  assert refused, 'not dispatched before the kitchen is done';
  perform auth.login_as(u_owner);
  perform public.restaurant_set_order_status(org, o1, 'ready');
  perform auth.login_as(u_cash);
  perform public.restaurant_delivery_status(org, o1, 'dispatched');
  perform auth.as_admin();
  assert (select status from public.restaurant_orders where id = o1) = 'served', 'dispatched = handed out, off the kitchen screens';

  perform auth.login_as(u_drv2);
  refused := false;
  begin perform public.restaurant_delivery_status(org, o1, 'delivered');
  exception when insufficient_privilege then refused := true; end;
  assert refused, 'another driver cannot close my trip';
  perform auth.login_as(u_drv);
  assert (select count(*) from public.restaurant_delivery_jobs where order_id = o1) = 1, 'the driver sees their job';
  assert (select count(*) from public.restaurant_order_deliveries where order_id = o1) = 1, 'and its address';
  refused := false;
  begin perform public.restaurant_delivery_status(org, o1, 'returned', 'رفض الاستلام');
  exception when insufficient_privilege then refused := true; end;
  assert refused, 'a return is the dispatcher''s call';
  perform public.restaurant_delivery_status(org, o1, 'in_transit');
  perform public.restaurant_delivery_status(org, o1, 'delivered');
  perform auth.as_admin();
  assert (select cash_to_collect_cents from public.restaurant_delivery_jobs where order_id = o1) = 22000, 'cash to collect includes the fee';
  select * into bal from app.driver_balances(drv);
  assert bal.out_custody = 22000 and bal.out_commission = 1500, 'collection and zone commission booked';
  refused := false;
  begin update public.restaurant_driver_ledger set amount_cents = 1 where driver_id = drv;
  exception when check_violation then refused := true; end;
  assert refused, 'the driver ledger is append-only';

  -- ---- settlement ------------------------------------------------------------
  perform auth.login_as(u_owner);
  perform public.restaurant_driver_float(org, drv, 5000, 'فكة');
  perform auth.login_as(u_cash);
  refused := false;
  begin perform public.restaurant_driver_settle(org, drv, 27000);
  exception when insufficient_privilege then refused := true; end;
  assert refused, 'a cashier does not settle drivers';

  perform auth.login_as(u_settler);
  refused := false;
  begin perform public.restaurant_driver_settle(org, drv, 30000);
  exception when check_violation then refused := true; end;
  assert refused, 'cannot hand in more than the custody';
  refused := false;
  begin perform public.restaurant_driver_settle(org, drv, 26000);
  exception when sqlstate 'LB403' then refused := true; end;
  assert refused, 'a 1000 shortage needs a manager';
  select out_grant into g from public.approval_grant(org, br, 'driver.shortage', drv, 1000, m_owner, '4826');
  j := public.restaurant_driver_settle(org, drv, 26000);
  perform auth.as_admin();
  assert (j ->> 'orders')::int = 1 and (j ->> 'collected')::bigint = 22000 and (j ->> 'shortage')::bigint = 1000, 'settled';
  select invoice_id into inv from public.restaurant_orders where id = o1;
  assert (select total_cents = 22000 and paid_cents = 22000 from public.invoices where id = inv), 'invoice includes the delivery fee, fully paid';
  assert exists (select 1 from public.invoice_items where invoice_id = inv and ref_type = 'delivery_fee' and total_cents = 2000), 'fee line on the invoice';
  assert (select status from public.restaurant_orders where id = o1) = 'completed', 'closed on settlement';
  select * into bal from app.driver_balances(drv);
  assert bal.out_custody = 0 and bal.out_commission = 1500, 'custody cleared; commission still due';
  -- Drawer: −5000 float, +22000 payment, +4000 float returned = the 26000 handed in − the 5000 that left earlier.
  select id into acct from public.treasury_accounts where branch_id = br and is_default;
  assert (select coalesce(sum(case direction when 'in' then amount_cents else -amount_cents end), 0)
            from public.treasury_transactions where account_id = acct) = 21000, 'the drawer matches the cash';

  perform auth.login_as(u_settler);
  refused := false;
  begin perform public.restaurant_driver_settle(org, drv, 0, true);
  exception when sqlstate 'LB403' then refused := true; end;
  assert refused, 'paying commission needs a manager';
  select out_grant into g from public.approval_grant(org, br, 'driver.payout', drv, 1500, m_owner, '4826');
  perform public.restaurant_driver_settle(org, drv, 0, true);
  perform auth.as_admin();
  select * into bal from app.driver_balances(drv);
  assert bal.out_commission = 0, 'commission paid';
  perform auth.login_as(u_settler);
  refused := false;
  begin perform public.restaurant_driver_adjust(org, drv, 500, 'مكافأة');
  exception when sqlstate 'LB403' then refused := true; end;
  assert refused, 'a commission adjustment needs a manager';

  -- ---- percent commission, and a return --------------------------------------
  perform auth.login_as(u_cash);
  select out_order_id into o2 from public.restaurant_callcenter_place_order(org, br, cust, 'delivery',
    jsonb_build_array(jsonb_build_object('variant_id', v, 'quantity', 1)), jsonb_build_object('address', 'عنوان جديد للتجربة'), null);
  select out_order_id into o3 from public.restaurant_callcenter_place_order(org, br, cust, 'delivery',
    jsonb_build_array(jsonb_build_object('variant_id', v, 'quantity', 1)), jsonb_build_object('id', addr), z);
  perform public.restaurant_delivery_assign(org, o2, drv2);
  perform public.restaurant_delivery_assign(org, o3, drv2);
  perform auth.login_as(u_owner);
  perform public.restaurant_set_order_status(org, o2, 'ready');
  perform public.restaurant_set_order_status(org, o3, 'ready');
  perform auth.login_as(u_cash);
  perform public.restaurant_delivery_status(org, o2, 'dispatched');
  perform public.restaurant_delivery_status(org, o3, 'dispatched');
  perform auth.login_as(u_drv2);
  perform public.restaurant_delivery_status(org, o2, 'delivered');
  perform auth.as_admin();
  assert (select commission_cents from public.restaurant_delivery_jobs where order_id = o2) = 1000, '10% of 10000';
  perform auth.login_as(u_cash);
  refused := false;
  begin perform public.restaurant_delivery_status(org, o3, 'returned', 'العميل رفض الاستلام');
  exception when sqlstate 'LB403' then refused := true; end;
  assert refused, 'a return cancels the order: it needs a manager';
  select out_grant into g from public.approval_grant(org, br, 'order.cancel', o3, null, m_owner, '4826');
  perform public.restaurant_delivery_status(org, o3, 'returned', 'العميل رفض الاستلام');
  perform auth.as_admin();
  assert (select status from public.restaurant_orders where id = o3) = 'cancelled', 'returned order cancelled';
  assert (select status from public.restaurant_delivery_jobs where order_id = o3) = 'returned', 'job returned';
  select * into bal from app.driver_balances(drv2);
  assert bal.out_custody = 10000, 'nothing collected for the return';
  perform auth.login_as(u_settler);
  refused := false;
  begin perform public.restaurant_driver_settle(org, drv2, 10000);
  exception when check_violation then refused := true; end;
  assert refused is false, 'settles once nothing is on the road';

  -- ---- intake --------------------------------------------------------------
  perform auth.login_as(u_cash);
  refused := false;
  begin perform public.restaurant_integration_create(org, br, 'طلبات', 'talabat', repeat('a', 64), 'tk_aaaa');
  exception when insufficient_privilege then refused := true; end;
  assert refused, 'integrations are a manager''s';
  perform auth.login_as(u_owner);
  integ := public.restaurant_integration_create(org, br, 'طلبات', 'talabat', repeat('a', 64), 'tk_aaaa', true);
  perform auth.login_as(u_cash);
  refused := false;
  begin perform public.restaurant_intake_order(repeat('a', 64), '{}'::jsonb);
  exception when insufficient_privilege then refused := true; end;
  assert refused, 'staff cannot call the intake';
  perform auth.as_service_role();
  refused := false;
  begin perform public.restaurant_intake_order(repeat('b', 64), '{}'::jsonb);
  exception when sqlstate '28000' then refused := true; end;
  assert refused, 'a wrong key is refused';
  j := public.restaurant_intake_order(repeat('a', 64), jsonb_build_object(
    'external_id', 'TLB-1', 'type', 'delivery', 'paid', true, 'total_cents', 10500,
    'customer', jsonb_build_object('name', 'عمر', 'phone', '01099999999'),
    'delivery', jsonb_build_object('address', 'التجمع الخامس فيلا 3'),
    'items', jsonb_build_array(jsonb_build_object('variant_id', v, 'quantity', 1, 'note', 'بدون بصل'))));
  assert j ->> 'status' = 'confirmed' and (j ->> 'duplicate')::boolean = false, 'auto-confirmed to the kitchen';
  assert (public.restaurant_intake_order(repeat('a', 64), jsonb_build_object(
    'external_id', 'TLB-1', 'type', 'delivery', 'customer', jsonb_build_object('name', 'عمر', 'phone', '01099999999'),
    'delivery', jsonb_build_object('address', 'التجمع الخامس فيلا 3'),
    'items', jsonb_build_array(jsonb_build_object('variant_id', v, 'quantity', 1)))) ->> 'duplicate')::boolean,
    'the same external order twice is one order';
  perform auth.as_admin();
  select * into r from public.restaurant_orders where id = (j ->> 'order_id')::uuid;
  assert r.channel = 'aggregator' and r.external_source = 'talabat' and r.external_total_cents = 10500, 'source kept for reconciliation';
  assert (select paid_cents from public.invoices where id = r.invoice_id) = r.total_cents, 'paid on the platform';
  assert exists (select 1 from public.restaurant_delivery_jobs where order_id = r.id and status = 'pending'), 'ready for dispatch';
  assert (select count(*) from public.restaurant_orders where organization_id = org and external_ref = 'TLB-1') = 1, 'no duplicate';

  -- ---- isolation -----------------------------------------------------------
  perform auth.login_as(u_other);
  assert (select count(*) from public.restaurant_drivers where organization_id = org) = 0, 'drivers private';
  assert (select count(*) from public.restaurant_driver_ledger where organization_id = org) = 0, 'driver money private';
  assert (select count(*) from public.restaurant_delivery_jobs where organization_id = org) = 0, 'jobs private';
  perform auth.login_as(u_drv);
  assert (select count(*) from public.restaurant_delivery_jobs where order_id = o2) = 0, 'a driver sees only their own jobs';
  assert (select count(*) from public.restaurant_driver_ledger where driver_id = drv2) = 0, 'and only their own money';

  perform auth.as_admin();
  raise notice 'delivery and fleet OK';
end $$;
