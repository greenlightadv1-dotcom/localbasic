-- =============================================================================
-- LOCAL BASIC — cashier risk scoring, print tracking, daily limits, refunds (0108)
-- =============================================================================
\set ON_ERROR_STOP on

do $$
declare
  u_owner uuid; u_cash uuid; u_ref uuid; u_mgr uuid; u_other uuid;
  org uuid; br uuid; org_b uuid; br_b uuid; m uuid; m_owner uuid; role_ref uuid;
  cat uuid; p uuid; v uuid; o1 uuid; o2 uuid; o3 uuid; inv uuid; g uuid;
  refused boolean; n bigint; h text; msg text; r record; pts int; acct uuid; bal_before bigint;
begin
  insert into auth.users (email) values ('r40-owner@test.local') returning id into u_owner;
  insert into auth.users (email) values ('r40-cash@test.local')  returning id into u_cash;
  insert into auth.users (email) values ('r40-ref@test.local')   returning id into u_ref;
  insert into auth.users (email) values ('r40-mgr@test.local')   returning id into u_mgr;
  insert into auth.users (email) values ('r40-other@test.local') returning id into u_other;
  perform auth.login_as(u_owner);
  select out_organization_id, out_branch_id into org, br from public.provision_workspace('R40 Grill', 'r40grill', 'restaurant');
  perform public.approval_set_pin(org, '4826');
  perform auth.login_as(u_other);
  select out_organization_id, out_branch_id into org_b, br_b from public.provision_workspace('R40 Other', 'r40other', 'restaurant');
  perform auth.as_admin();
  select id into m_owner from public.organization_members where organization_id = org and user_id = u_owner;

  -- ---- permissions -----------------------------------------------------------
  assert exists (select 1 from public.role_permissions rp join public.roles ro on ro.id = rp.role_id
                  where ro.organization_id is null and ro.key = 'manager' and ro.module_key is null
                    and rp.permission_key = 'restaurant.audit.risk_view'), 'the manager template views risk';
  assert exists (select 1 from public.role_permissions rp join public.roles ro on ro.id = rp.role_id
                  where ro.organization_id = org and ro.key = 'admin' and rp.permission_key = 'restaurant.audit.risk_reset'),
         'new organizations copy risk_reset to admin';
  assert not exists (select 1 from public.role_permissions rp join public.roles ro on ro.id = rp.role_id
                      where ro.organization_id = org and ro.key = 'cashier' and rp.permission_key like 'restaurant.audit.risk%'),
         'cashiers do not see risk';

  for r in select * from (values (u_cash, 'cashier'), (u_mgr, 'manager')) as x(u, k) loop
    insert into public.organization_members (organization_id, user_id, status, all_branches, joined_at)
    values (org, r.u, 'active', true, now()) returning id into m;
    insert into public.user_roles (member_id, role_id) select m, id from public.roles where organization_id = org and key = r.k;
  end loop;
  -- Someone who may refund but not approve, to see the daily refund cap.
  insert into public.roles (organization_id, key, name_ar, name_en, is_system, is_owner, module_key)
  values (org, 'r40_refund', 'مرتجعات', 'Refunds', false, false, 'restaurant') returning id into role_ref;
  insert into public.role_permissions (role_id, permission_key)
  values (role_ref, 'payment.refund'), (role_ref, 'restaurant.pos.use'), (role_ref, 'payment.create');
  insert into public.organization_members (organization_id, user_id, status, all_branches, joined_at)
  values (org, u_ref, 'active', true, now()) returning id into m;
  insert into public.user_roles (member_id, role_id) values (m, role_ref);

  insert into public.restaurant_categories (organization_id, name) values (org, 'مشويات') returning id into cat;
  insert into public.restaurant_products (organization_id, category_id, name) values (org, cat, 'كفتة') returning id into p;
  insert into public.restaurant_variants (organization_id, product_id, name, price_cents) values (org, p, 'default', 10000) returning id into v;

  -- ---- print tracking ----------------------------------------------------------
  perform auth.login_as(u_cash);
  select out_order_id into o1 from public.restaurant_create_order(org, br, jsonb_build_array(jsonb_build_object('variant_id', v, 'quantity', 1)));
  assert (select print_count from public.restaurant_orders where id = o1) = 0, 'a new order is unprinted';
  refused := false;
  begin update public.restaurant_orders set print_count = 0, bill_printed_at = null where id = o1;
        update public.restaurant_orders set print_count = 5 where id = o1;
  exception when insufficient_privilege then refused := true; end;
  assert refused, 'the print counter cannot be written directly';

  assert public.restaurant_order_print_track(org, o1, null, 'bill') = 1, 'first bill print';
  assert not exists (select 1 from public.restaurant_cashier_risk_logs where order_id = o1), 'a first print is not a risk';
  assert public.restaurant_order_print_track(org, o1, null, 'bill') = 2, 'second bill print';
  assert (select count(*) from public.restaurant_cashier_risk_logs where order_id = o1 and event_type = 'reprint_receipt' and user_id = u_cash) = 1,
         'the bill reprint is logged against the cashier';

  -- A printed bill that is cancelled.
  perform public.restaurant_set_order_status(org, o1, 'cancelled', 'العميل مشي');
  assert (select is_voided_after_print from public.restaurant_orders where id = o1), 'marked voided after print';
  assert (select count(*) from public.restaurant_cashier_risk_logs where order_id = o1 and event_type = 'void_after_print') = 1, 'void after print logged';
  select accumulated_risk_points into pts from public.restaurant_cashier_risk_profiles where organization_id = org and user_id = u_cash;
  assert pts = 1 + 4, format('points add up (got %s)', pts);

  -- An unprinted order cancelled is not a risk.
  select out_order_id into o2 from public.restaurant_create_order(org, br, jsonb_build_array(jsonb_build_object('variant_id', v, 'quantity', 1)));
  perform public.restaurant_set_order_status(org, o2, 'cancelled', 'خطأ');
  assert not (select is_voided_after_print from public.restaurant_orders where id = o2), 'unprinted cancel is not flagged';

  -- Bill, then the paid receipt: not a reprint.
  select out_order_id into o3 from public.restaurant_create_order(org, br, jsonb_build_array(jsonb_build_object('variant_id', v, 'quantity', 2)));
  perform public.restaurant_set_order_status(org, o3, 'confirmed');
  perform public.restaurant_order_print_track(org, o3, null, 'bill');
  perform public.restaurant_pay_order(org, o3, 'cash', 20000, 0);
  select invoice_id into inv from public.restaurant_orders where id = o3;
  assert public.restaurant_order_print_track(org, null, inv, 'receipt') = 2, 'receipt print found by invoice';
  assert not exists (select 1 from public.restaurant_cashier_risk_logs where order_id = o3), 'bill then receipt is not a reprint';

  -- ---- drawer, flagging ------------------------------------------------------------
  refused := false;
  begin perform public.restaurant_drawer_open(org, br, '  ');
  exception when sqlstate '22023' then refused := true; end;
  assert refused, 'opening the drawer needs a reason';
  perform public.restaurant_drawer_open(org, br, 'فكة');
  perform public.restaurant_drawer_open(org, br, 'فكة');
  select accumulated_risk_points, is_flagged into r from public.restaurant_cashier_risk_profiles where organization_id = org and user_id = u_cash;
  assert r.accumulated_risk_points = 9 and not r.is_flagged, 'under the threshold';
  perform public.restaurant_order_print_track(org, null, inv, 'receipt');   -- receipt reprint: +1 → 10
  select accumulated_risk_points, is_flagged into r from public.restaurant_cashier_risk_profiles where organization_id = org and user_id = u_cash;
  assert r.accumulated_risk_points = 10 and r.is_flagged, 'flagged at 10 points';
  perform auth.as_admin();
  assert exists (select 1 from public.audit_logs where organization_id = org and action = 'restaurant.cashier.flagged' and entity_id = u_cash::text),
         'flagging is audited';
  perform auth.login_as(u_cash);

  -- ---- RLS ---------------------------------------------------------------------
  assert (select count(*) from public.restaurant_cashier_risk_profiles) = 1, 'a cashier sees only their own profile';
  refused := false;
  begin perform * from public.restaurant_risk_dashboard(org, now() - interval '1 day', now() + interval '1 minute');
  exception when insufficient_privilege then refused := true; end;
  assert refused, 'a cashier has no risk dashboard';
  refused := false;
  begin perform public.restaurant_risk_set_limits(org, u_cash, null, null);
  exception when insufficient_privilege then refused := true; end;
  assert refused, 'a cashier does not set limits';
  perform auth.login_as(u_other);
  assert (select count(*) from public.restaurant_cashier_risk_logs where organization_id = org) = 0, 'another organization sees no logs';
  assert (select count(*) from public.restaurant_cashier_risk_profiles where organization_id = org) = 0, 'nor profiles';
  perform auth.login_as(u_mgr);
  assert (select count(*) from public.restaurant_cashier_risk_logs where organization_id = org and user_id = u_cash) = 5, 'the manager sees the log';
  select * into r from public.restaurant_risk_dashboard(org, now() - interval '1 day', now() + interval '1 minute') where out_user_id = u_cash;
  assert r.out_flagged and r.out_points = 10 and r.out_void_after_print = 1 and r.out_drawer_no_sale = 2 and r.out_reprints = 2,
         format('dashboard breakdown %s', row_to_json(r));
  refused := false;
  begin update public.restaurant_cashier_risk_logs set points = 0 where user_id = u_cash;
        if not found then raise insufficient_privilege; end if;
  exception when insufficient_privilege or check_violation then refused := true; end;
  assert refused, 'the log cannot be edited';
  perform auth.as_admin();
  refused := false;
  begin delete from public.restaurant_cashier_risk_logs where user_id = u_cash;
  exception when check_violation then refused := true; end;
  assert refused, 'the log is append-only even for the service';

  -- ---- daily discount cap ------------------------------------------------------------
  perform auth.login_as(u_mgr);
  perform public.restaurant_risk_set_limits(org, u_cash, 5000, 1000);
  perform auth.login_as(u_cash);
  select out_order_id into o2 from public.restaurant_create_order(org, br, jsonb_build_array(jsonb_build_object('variant_id', v, 'quantity', 1)));
  perform public.restaurant_set_order_status(org, o2, 'confirmed');
  -- 1,500 off: the per-order discount PIN first, then the daily cap (over by 500).
  h := null;
  begin perform public.restaurant_pay_order(org, o2, 'cash', 10000, 1500);
  exception when sqlstate 'LB403' then get stacked diagnostics h = pg_exception_hint; end;
  assert h = 'order.discount:1500', format('the first gate names itself (%s)', h);
  select out_grant into g from public.approval_grant(org, br, 'order.discount', o2, 1500, m_owner, '4826');
  h := null;
  begin perform public.restaurant_pay_order(org, o2, 'cash', 10000, 1500);
  exception when sqlstate 'LB403' then get stacked diagnostics h = pg_exception_hint; end;
  assert h = 'discount.daily_limit:500', format('then the daily cap with the excess (%s)', h);
  perform auth.as_admin();
  assert exists (select 1 from public.approval_grants where id = g and consumed_at is null), 'a refused save keeps the first grant';
  perform auth.login_as(u_cash);
  select out_grant into g from public.approval_grant(org, br, 'discount.daily_limit', o2, 500, m_owner, '4826');
  perform public.restaurant_pay_order(org, o2, 'cash', 10000, 1500);
  assert (select count(*) from public.restaurant_cashier_risk_logs where order_id = o2 and event_type = 'discount_over_limit'
            and amount_cents = 1500 and approved_by = u_owner) = 1, 'over-limit discount logged with its approver';
  assert (select discount_today_cents from public.restaurant_cashier_risk_profiles where organization_id = org and user_id = u_cash) = 1500,
         'today''s discounts tallied';

  -- ---- refunds and the daily refund cap ------------------------------------------------
  perform auth.login_as(u_cash);
  refused := false;
  begin perform public.restaurant_refund_payment(org, inv, 1000, 'cash', 'x');
  exception when insufficient_privilege then refused := true; end;
  assert refused, 'a cashier without payment.refund cannot refund';
  perform auth.login_as(u_mgr);
  perform public.restaurant_risk_set_limits(org, u_ref, 5000, null);
  perform auth.login_as(u_ref);
  refused := false;
  begin perform public.restaurant_refund_payment(org, inv, 999999, 'cash', 'كثير');
  exception when check_violation then refused := true; end;
  assert refused, 'cannot refund more than was paid';
  perform auth.as_admin();
  select id into acct from public.treasury_accounts where branch_id = br and is_default;
  select coalesce(sum(case direction when 'in' then amount_cents else -amount_cents end), 0) into bal_before
    from public.treasury_transactions where account_id = acct;
  perform auth.login_as(u_ref);
  perform public.restaurant_refund_payment(org, inv, 3000, 'cash', 'صنف بارد');
  perform auth.as_admin();
  assert (select paid_cents from public.invoices where id = inv) = (select total_cents from public.invoices where id = inv) - 3000,
         'the invoice paid amount drops';
  assert (select coalesce(sum(case direction when 'in' then amount_cents else -amount_cents end), 0) from public.treasury_transactions
           where account_id = acct) = bal_before - 3000, 'the refund leaves the drawer';
  perform auth.login_as(u_ref);
  h := null;
  begin perform public.restaurant_refund_payment(org, inv, 3000, 'cash', 'تاني');
  exception when sqlstate 'LB403' then get stacked diagnostics h = pg_exception_hint; end;
  assert h = 'refund.daily_limit:1000', format('past the daily refund cap (%s)', h);
  select out_grant into g from public.approval_grant(org, br, 'refund.daily_limit', inv, 1000, m_owner, '4826');
  perform public.restaurant_refund_payment(org, inv, 3000, 'cash', 'تاني');
  assert (select count(*) from public.restaurant_cashier_risk_logs where user_id = u_ref and event_type = 'refund_processed') = 2, 'each refund logged';
  assert (select refund_today_cents from public.restaurant_cashier_risk_profiles where organization_id = org and user_id = u_ref) = 6000, 'refunds tallied';

  -- ---- reset ---------------------------------------------------------------------------
  perform auth.login_as(u_cash);
  refused := false;
  begin perform public.restaurant_risk_reset(org, u_cash, '4826', 'x');
  exception when insufficient_privilege then refused := true; end;
  assert refused, 'a cashier cannot reset';
  perform auth.login_as(u_owner);
  msg := public.restaurant_risk_reset(org, u_cash, '0000', 'مراجعة');
  assert msg = 'الرمز غير صحيح', 'a wrong PIN is refused';
  perform auth.as_admin();
  assert (select failed_attempts from public.member_approval_pins where member_id = m_owner) = 1, 'and counted';
  perform auth.login_as(u_owner);
  assert (select is_flagged from public.restaurant_cashier_risk_profiles where organization_id = org and user_id = u_cash), 'still flagged';
  refused := false;
  begin perform public.restaurant_risk_reset(org, u_owner, '4826', 'نفسي');
  exception when insufficient_privilege then refused := true; end;
  assert refused, 'nobody resets their own score';
  msg := public.restaurant_risk_reset(org, u_cash, '4826', 'تمت المراجعة مع الكاشير');
  assert msg is null, 'reset with the right PIN';
  select * into r from public.restaurant_cashier_risk_profiles where organization_id = org and user_id = u_cash;
  assert r.accumulated_risk_points = 0 and not r.is_flagged and r.last_reset_by = u_owner, 'score cleared';
  assert r.daily_discount_limit_cents = 1000, 'limits survive a reset';
  assert (select count(*) from public.restaurant_cashier_risk_logs where user_id = u_cash) = 6, 'the history survives a reset';
  perform auth.as_admin();
  assert exists (select 1 from public.audit_logs where organization_id = org and action = 'restaurant.cashier.risk_reset'), 'reset audited';

  raise notice 'test 40 ok';
end $$;
