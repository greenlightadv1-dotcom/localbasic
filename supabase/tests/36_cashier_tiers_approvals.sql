-- =============================================================================
-- LOCAL BASIC — cashier tiers, zones and manager PIN approvals (0103)
-- =============================================================================
\set ON_ERROR_STOP on

do $$
declare
  u_owner uuid; u_cash uuid; u_main uuid; u_chef uuid; u_mgr uuid;
  org uuid; br uuid; m uuid; m_owner uuid; m_cash uuid; m_mgr uuid;
  cat uuid; p uuid; v uuid; sec_a uuid; sec_b uuid; tbl_a uuid; tbl_b uuid;
  o1 uuid; o2 uuid; o3 uuid; o4 uuid; o5 uuid; g uuid; g2 uuid; v_err text;
  refused boolean; n int; i int;
begin
  insert into auth.users (email) values ('r36-owner@test.local') returning id into u_owner;
  insert into auth.users (email) values ('r36-cash@test.local')  returning id into u_cash;
  insert into auth.users (email) values ('r36-main@test.local')  returning id into u_main;
  insert into auth.users (email) values ('r36-chef@test.local')  returning id into u_chef;
  insert into auth.users (email) values ('r36-mgr@test.local')   returning id into u_mgr;
  perform auth.login_as(u_owner);
  select out_organization_id, out_branch_id into org, br from public.provision_workspace('R36 Cafe', 'r36cafe', 'restaurant');
  perform auth.as_admin();

  insert into public.organization_members (organization_id, user_id, status, all_branches, joined_at)
  values (org, u_cash, 'active', true, now()) returning id into m_cash;
  insert into public.user_roles (member_id, role_id) select m_cash, id from public.roles where organization_id = org and key = 'cashier';
  insert into public.organization_members (organization_id, user_id, status, all_branches, joined_at)
  values (org, u_main, 'active', true, now()) returning id into m;
  insert into public.user_roles (member_id, role_id) select m, id from public.roles where organization_id = org and key = 'main_cashier';
  insert into public.organization_members (organization_id, user_id, status, all_branches, joined_at)
  values (org, u_chef, 'active', true, now()) returning id into m;
  insert into public.user_roles (member_id, role_id) select m, id from public.roles where organization_id = org and key = 'kitchen';
  insert into public.organization_members (organization_id, user_id, status, all_branches, joined_at)
  values (org, u_mgr, 'active', true, now()) returning id into m_mgr;
  insert into public.user_roles (member_id, role_id) select m_mgr, id from public.roles where organization_id = org and key = 'manager';
  select id into m_owner from public.organization_members where organization_id = org and user_id = u_owner;

  insert into public.restaurant_categories (organization_id, name) values (org, 'أطباق') returning id into cat;
  insert into public.restaurant_products (organization_id, category_id, name) values (org, cat, 'طبق') returning id into p;
  insert into public.restaurant_variants (organization_id, product_id, name, price_cents) values (org, p, 'default', 10000) returning id into v;
  insert into public.restaurant_sections (organization_id, branch_id, name) values (org, br, 'الدور الأول') returning id into sec_a;
  insert into public.restaurant_sections (organization_id, branch_id, name) values (org, br, 'التراس') returning id into sec_b;
  insert into public.restaurant_tables (organization_id, branch_id, section_id, name) values (org, br, sec_a, 'A1') returning id into tbl_a;
  insert into public.restaurant_tables (organization_id, branch_id, section_id, name) values (org, br, sec_b, 'B1') returning id into tbl_b;

  -- ---- PINs ---------------------------------------------------------------
  perform auth.login_as(u_cash);
  refused := false;
  begin perform public.approval_set_pin(org, '4826');
  exception when insufficient_privilege then refused := true; end;
  assert refused, 'a sub-cashier cannot hold an approval PIN';

  perform auth.login_as(u_owner);
  foreach v_err in array array['12', 'abcd', '1111', '1234', '123456789'] loop
    refused := false;
    begin perform public.approval_set_pin(org, v_err);
    exception when sqlstate '22023' then refused := true; end;
    assert refused, format('weak or malformed PIN refused: %s', v_err);
  end loop;
  perform public.approval_set_pin(org, '4826');
  perform auth.as_admin();
  assert (select pin_hash from public.member_approval_pins where member_id = m_owner) not like '%4826%', 'PIN stored hashed';

  -- The approvers list never includes the caller, and only lists PIN holders.
  perform auth.login_as(u_cash);
  assert (select count(*) from public.approval_approvers(org, br)) = 1, 'one approver (the owner) for the cashier';
  perform auth.login_as(u_owner);
  assert (select count(*) from public.approval_approvers(org, br) where out_member_id = m_owner) = 0, 'never yourself';

  -- ---- cancellation -------------------------------------------------------
  perform auth.login_as(u_cash);
  select out_order_id into o1 from public.restaurant_create_order(org, br, jsonb_build_array(jsonb_build_object('variant_id', v, 'quantity', 1)), tbl_a);
  select out_order_id into o2 from public.restaurant_create_order(org, br, jsonb_build_array(jsonb_build_object('variant_id', v, 'quantity', 1)), tbl_a);
  -- Not yet sent to the kitchen: the cashier may cancel freely.
  perform public.restaurant_set_order_status(org, o2, 'cancelled', 'خطأ إدخال');
  perform public.restaurant_set_order_status(org, o1, 'confirmed');
  refused := false;
  begin perform public.restaurant_set_order_status(org, o1, 'cancelled', 'العميل غيّر رأيه');
  exception when sqlstate 'LB403' then refused := true; end;
  assert refused, 'cancelling a confirmed order needs a manager';

  -- Wrong PIN: refused, counted. A grant for another order does not help.
  select out_grant, out_error into g, v_err from public.approval_grant(org, br, 'order.cancel', o1, null, m_owner, '0000');
  assert g is null and v_err = 'الرمز غير صحيح', 'wrong PIN refused';
  select out_grant into g from public.approval_grant(org, br, 'order.cancel', o2, null, m_owner, '4826');
  refused := false;
  begin perform public.restaurant_set_order_status(org, o1, 'cancelled', 'x');
  exception when sqlstate 'LB403' then refused := true; end;
  assert refused, 'a grant is bound to its order';

  -- An expired grant does not work.
  select out_grant into g from public.approval_grant(org, br, 'order.cancel', o1, null, m_owner, '4826');
  perform auth.as_admin();
  update public.approval_grants set expires_at = now() - interval '1 second' where id = g;
  perform auth.login_as(u_cash);
  refused := false;
  begin perform public.restaurant_set_order_status(org, o1, 'cancelled', 'x');
  exception when sqlstate 'LB403' then refused := true; end;
  assert refused, 'expired grant refused';

  -- A fresh grant works once.
  select out_grant into g from public.approval_grant(org, br, 'order.cancel', o1, null, m_owner, '4826');
  perform public.restaurant_set_order_status(org, o1, 'cancelled', 'العميل غيّر رأيه');
  perform auth.as_admin();
  assert (select consumed_at is not null from public.approval_grants where id = g), 'grant consumed';
  assert exists (select 1 from public.audit_logs where entity_id = o1::text and action = 'restaurant.order.cancel_approved'
                   and (after ->> 'approved_by')::uuid = u_owner), 'cancellation audited with the approver';
  assert (select failed_attempts from public.member_approval_pins where member_id = m_owner) = 0, 'success resets the counter';

  -- The main cashier cancels a confirmed order directly (approval.grant).
  perform auth.login_as(u_main);
  select out_order_id into o3 from public.restaurant_create_order(org, br, jsonb_build_array(jsonb_build_object('variant_id', v, 'quantity', 1)), tbl_b);
  perform public.restaurant_set_order_status(org, o3, 'confirmed');
  perform public.restaurant_set_order_status(org, o3, 'cancelled', 'إلغاء من الكاشير الرئيسي');

  -- ---- discounts ----------------------------------------------------------
  perform auth.login_as(u_cash);
  select out_order_id into o4 from public.restaurant_create_order(org, br, jsonb_build_array(jsonb_build_object('variant_id', v, 'quantity', 1)), tbl_a);
  refused := false;
  begin perform public.restaurant_pay_order(org, o4, 'cash', 20000, 1000);
  exception when sqlstate 'LB403' then refused := true; end;
  assert refused, 'a discount needs a manager';
  select out_grant into g from public.approval_grant(org, br, 'order.discount', o4, 500, m_owner, '4826');
  refused := false;
  begin perform public.restaurant_pay_order(org, o4, 'cash', 20000, 1000);
  exception when sqlstate 'LB403' then refused := true; end;
  assert refused, 'a grant for 500 does not cover 1000';
  select out_grant into g from public.approval_grant(org, br, 'order.discount', o4, 1000, m_owner, '4826');
  perform public.restaurant_pay_order(org, o4, 'cash', 20000, 1000);
  perform auth.as_admin();
  assert (select discount_cents from public.restaurant_orders where id = o4) = 1000, 'approved discount applied';

  -- A redeemed loyalty coupon is the guest's own reward: no approval for its value.
  perform auth.login_as(u_cash);
  select out_order_id into o5 from public.restaurant_create_order(org, br, jsonb_build_array(jsonb_build_object('variant_id', v, 'quantity', 1)), tbl_a);
  perform auth.as_admin();
  insert into public.restaurant_loyalty_coupons (organization_id, phone_key, code, points_cost, value_cents, expires_at, status, redeemed_order_id, redeemed_at)
  values (org, '012345678', 'LB-R36AAA', 100, 2000, now() + interval '30 days', 'redeemed', o5, now());
  perform auth.login_as(u_cash);
  perform public.restaurant_pay_order(org, o5, 'cash', 20000, 2000);
  perform auth.as_admin();
  assert (select discount_cents from public.restaurant_orders where id = o5) = 2000, 'coupon value needs no approval';

  -- ---- lockout ------------------------------------------------------------
  perform auth.login_as(u_cash);
  for i in 1..5 loop
    perform * from public.approval_grant(org, br, 'order.cancel', o4, null, m_owner, '9999');
  end loop;
  select out_grant, out_error into g, v_err from public.approval_grant(org, br, 'order.cancel', o4, null, m_owner, '4826');
  assert g is null and v_err like 'تم إيقاف الرمز%', 'five wrong PINs lock it, even for the right PIN';
  perform auth.as_admin();
  assert exists (select 1 from public.audit_logs where organization_id = org and action = 'approval.pin_failed'), 'failed PINs are audited';

  -- Self-approval is impossible: a manager's own PIN does not approve their own request.
  perform auth.login_as(u_mgr);
  perform public.approval_set_pin(org, '7351');
  select out_grant, out_error into g, v_err from public.approval_grant(org, br, 'order.cancel', o4, null, m_mgr, '7351');
  assert g is null and v_err like 'لا يمكنك%', 'no self-approval';

  -- ---- zones --------------------------------------------------------------
  perform auth.login_as(u_owner);
  perform public.restaurant_cashier_zone_save(org, m_cash, true, array[sec_a], false, false);
  assert (select out_restricted from public.restaurant_cashier_zones(org) where out_member_id = m_cash), 'zone saved';

  perform auth.login_as(u_cash);
  -- Sees only section A's orders; takeaway not allowed.
  select count(*) into n from public.restaurant_orders where organization_id = org and table_id = tbl_b;
  assert n = 0, 'a zoned cashier does not see other zones';
  select count(*) into n from public.restaurant_orders where organization_id = org and table_id = tbl_a;
  assert n > 0, 'a zoned cashier sees their own zone';
  refused := false;
  begin perform public.restaurant_create_order(org, br, jsonb_build_array(jsonb_build_object('variant_id', v, 'quantity', 1)), tbl_b);
  exception when insufficient_privilege then refused := true; end;
  assert refused, 'cannot open an order on another zone''s table';
  refused := false;
  begin perform public.restaurant_create_order(org, br, jsonb_build_array(jsonb_build_object('variant_id', v, 'quantity', 1)), null, 'takeaway');
  exception when insufficient_privilege then refused := true; end;
  assert refused, 'takeaway not allowed for this cashier';

  -- The main cashier and the kitchen are unaffected.
  perform auth.login_as(u_main);
  assert (select count(*) from public.restaurant_orders where organization_id = org and table_id = tbl_b) > 0, 'main cashier sees every zone';
  perform auth.login_as(u_chef);
  assert (select count(*) from public.restaurant_orders where organization_id = org) > 0, 'kitchen unaffected by zones';

  -- Only managers may set zones.
  perform auth.login_as(u_cash);
  refused := false;
  begin perform public.restaurant_cashier_zone_save(org, m_cash, false, null, true, true);
  exception when insufficient_privilege then refused := true; end;
  assert refused, 'a cashier cannot widen their own zone';

  -- Lifting the zone restores everything.
  perform auth.login_as(u_owner);
  perform public.restaurant_cashier_zone_save(org, m_cash, false, null, true, false);
  perform auth.login_as(u_cash);
  assert (select count(*) from public.restaurant_orders where organization_id = org and table_id = tbl_b) > 0, 'zone lifted';

  perform auth.as_admin();

  -- Role templates stay within their module (0104): cashier and storekeeper
  -- exist for retail AND restaurant, and must not borrow from each other.
  assert not exists (select 1 from public.roles r join public.role_permissions rp on rp.role_id = r.id
                      where r.organization_id is null and r.module_key = 'retail'
                        and (rp.permission_key like 'inventory.%' or rp.permission_key like 'restaurant.%'
                             or rp.permission_key = 'approval.grant')),
    'retail templates carry no restaurant or inventory keys';
  assert not exists (select 1 from public.roles r join public.role_permissions rp on rp.role_id = r.id
                      where r.module_key = 'restaurant' and r.key in ('main_cashier', 'storekeeper')
                        and rp.permission_key like 'retail.%'),
    'restaurant main_cashier / storekeeper carry no retail keys';
  perform auth.login_as(u_mgr);
  perform public.provision_workspace('R36 Shop', 'r36shop', 'retail');
  perform auth.as_admin();
  assert not exists (select 1 from public.roles r join public.organizations o on o.id = r.organization_id
                       join public.role_permissions rp on rp.role_id = r.id
                      where o.slug = 'r36shop' and r.key in ('cashier', 'storekeeper')
                        and (rp.permission_key like 'inventory.%' or rp.permission_key = 'approval.grant'
                             or rp.permission_key in ('restaurant.order.cancel', 'restaurant.pos.discount'))),
    'a new retail store''s cashier and storekeeper get no restaurant or inventory keys';

  raise notice 'cashier tiers and approvals OK';
end $$;
