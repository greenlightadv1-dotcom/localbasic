-- =============================================================================
-- LOCAL BASIC — loyalty rewards, promotions engine, house accounts (0107)
-- =============================================================================
\set ON_ERROR_STOP on

do $$
declare
  u_owner uuid; u_cash uuid; u_acct uuid; u_other uuid;
  org uuid; br uuid; org_b uuid; br_b uuid; m uuid; m_owner uuid; role_acct uuid;
  cat_b uuid; cat_d uuid; p_burger uuid; p_juice uuid; v_burger uuid; v_juice uuid;
  pr_hh uuid; pr_bogo uuid; pr_code uuid; rw_disc uuid; rw_free uuid;
  cust uuid; o1 uuid; o2 uuid; o3 uuid; o4 uuid; g uuid; j jsonb; refused boolean; n bigint; r record;
begin
  insert into auth.users (email) values ('r39-owner@test.local') returning id into u_owner;
  insert into auth.users (email) values ('r39-cash@test.local')  returning id into u_cash;
  insert into auth.users (email) values ('r39-acct@test.local')  returning id into u_acct;
  insert into auth.users (email) values ('r39-other@test.local') returning id into u_other;
  perform auth.login_as(u_owner);
  select out_organization_id, out_branch_id into org, br from public.provision_workspace('R39 Diner', 'r39diner', 'restaurant');
  perform public.approval_set_pin(org, '4826');
  perform public.restaurant_loyalty_settings_save(org, true, 1000, 100, 2000, 90);
  perform auth.login_as(u_other);
  select out_organization_id, out_branch_id into org_b, br_b from public.provision_workspace('R39 Other', 'r39other', 'restaurant');
  perform auth.as_admin();
  select id into m_owner from public.organization_members where organization_id = org and user_id = u_owner;
  insert into public.organization_members (organization_id, user_id, status, all_branches, joined_at)
  values (org, u_cash, 'active', true, now()) returning id into m;
  insert into public.user_roles (member_id, role_id) select m, id from public.roles where organization_id = org and key = 'cashier';
  -- An accountant without approval rights, to see the PIN gates.
  insert into public.roles (organization_id, key, name_ar, name_en, is_system, is_owner, module_key)
  values (org, 'r39_acct', 'حسابات', 'Accounts', false, false, 'restaurant') returning id into role_acct;
  insert into public.role_permissions (role_id, permission_key)
  values (role_acct, 'restaurant.account.manage'), (role_acct, 'restaurant.loyalty.manage'), (role_acct, 'restaurant.account.charge');
  insert into public.organization_members (organization_id, user_id, status, all_branches, joined_at)
  values (org, u_acct, 'active', true, now()) returning id into m;
  insert into public.user_roles (member_id, role_id) values (m, role_acct);

  insert into public.restaurant_categories (organization_id, name) values (org, 'برجر') returning id into cat_b;
  insert into public.restaurant_categories (organization_id, name) values (org, 'مشروبات') returning id into cat_d;
  insert into public.restaurant_products (organization_id, category_id, name) values (org, cat_b, 'برجر') returning id into p_burger;
  insert into public.restaurant_variants (organization_id, product_id, name, price_cents) values (org, p_burger, 'default', 10000) returning id into v_burger;
  insert into public.restaurant_products (organization_id, category_id, name) values (org, cat_d, 'عصير') returning id into p_juice;
  insert into public.restaurant_variants (organization_id, product_id, name, price_cents) values (org, p_juice, 'default', 4000) returning id into v_juice;

  -- ---- promotions ------------------------------------------------------------
  perform auth.login_as(u_cash);
  refused := false;
  begin perform public.restaurant_promotion_save(org, null, '{"name":"x","kind":"code","code":"X10","percent_bp":1000}'::jsonb);
  exception when insufficient_privilege then refused := true; end;
  assert refused, 'a cashier does not create promotions';
  perform auth.login_as(u_owner);
  refused := false;
  begin perform public.restaurant_promotion_save(org, null, '{"name":"ناقص","kind":"bogo"}'::jsonb);
  exception when sqlstate '22023' then refused := true; end;
  assert refused, 'an incomplete promotion is refused';
  -- Happy hour: 20% off drinks, all day every day (so the test is time-proof).
  pr_hh := public.restaurant_promotion_save(org, null, jsonb_build_object('name', 'ساعة سعيدة', 'kind', 'happy_hour',
             'percent_bp', 2000, 'start_time', '00:00', 'end_time', '23:59:59', 'category_ids', jsonb_build_array(cat_d)));
  -- Buy 2 burgers get 1 free.
  pr_bogo := public.restaurant_promotion_save(org, null, jsonb_build_object('name', '2+1 برجر', 'kind', 'bogo',
             'buy_qty', 2, 'get_qty', 1, 'get_percent_bp', 10000, 'product_ids', jsonb_build_array(p_burger)));
  pr_code := public.restaurant_promotion_save(org, null, jsonb_build_object('name', 'ترحيب', 'kind', 'code', 'code', 'welcome10',
             'percent_bp', 1000, 'min_order_cents', 20000, 'max_uses', 1));
  refused := false;
  begin perform public.restaurant_promotion_save(org, null, jsonb_build_object('name', 'تكرار', 'kind', 'code', 'code', 'WELCOME10', 'amount_cents', 500));
  exception when unique_violation then refused := true; end;
  assert refused, 'promo codes are unique, case-insensitively';
  -- A promotion that is over does not apply.
  perform public.restaurant_promotion_save(org, null, jsonb_build_object('name', 'منتهي', 'kind', 'happy_hour', 'percent_bp', 5000,
             'start_time', '00:00', 'end_time', '23:59:59', 'ends_at', (now() - interval '1 day')::text));

  perform auth.login_as(u_cash);
  -- 3 burgers (one free) + 2 juices (20% off): 10000 + 1600 promotions.
  select out_order_id into o1 from public.restaurant_create_order(org, br, jsonb_build_array(
    jsonb_build_object('variant_id', v_burger, 'quantity', 3), jsonb_build_object('variant_id', v_juice, 'quantity', 2)));
  perform public.restaurant_set_order_status(org, o1, 'confirmed');
  j := public.restaurant_promotions_apply(org, o1);
  assert (j ->> 'promotions_cents')::bigint = 11600, format('bogo 10000 + happy hour 1600, got %s', j);
  assert jsonb_array_length(j -> 'applied') = 2, 'two promotions applied, the expired one not';
  perform auth.as_admin();
  assert (select discount_cents from public.restaurant_orders where id = o1) = 11600, 'order discount set';
  assert (select total_cents from public.restaurant_orders where id = o1) = 38000 - 11600, 'total after promotions';

  -- Paying with exactly the promotions needs no PIN; more does.
  perform auth.login_as(u_cash);
  refused := false;
  begin perform public.restaurant_pay_order(org, o1, 'cash', 50000, 12600);
  exception when sqlstate 'LB403' then refused := true; end;
  assert refused, 'a discount beyond the promotions needs a manager';
  perform public.restaurant_pay_order(org, o1, 'cash', 50000, 11600);
  perform auth.as_admin();
  assert (select i.total_cents from public.invoices i join public.restaurant_orders o on o.invoice_id = i.id where o.id = o1) = 26400,
    'invoiced at the promoted price';

  -- Codes: minimum order, a use limit, and a code that does not exist.
  perform auth.login_as(u_cash);
  select out_order_id into o2 from public.restaurant_create_order(org, br, jsonb_build_array(jsonb_build_object('variant_id', v_juice, 'quantity', 1)));
  refused := false;
  begin perform public.restaurant_promotions_apply(org, o2, 'WELCOME10');
  exception when check_violation then refused := true; end;
  assert refused, 'below the minimum order';
  refused := false;
  begin perform public.restaurant_promotions_apply(org, o2, 'NOPE');
  exception when check_violation then refused := true; end;
  assert refused, 'unknown code';
  select out_order_id into o3 from public.restaurant_create_order(org, br, jsonb_build_array(jsonb_build_object('variant_id', v_burger, 'quantity', 2)));
  j := public.restaurant_promotions_apply(org, o3, 'welcome10');
  assert (j ->> 'promotions_cents')::bigint = 2000, '10% of 20000 (two burgers: no free one yet)';
  select out_order_id into o4 from public.restaurant_create_order(org, br, jsonb_build_array(jsonb_build_object('variant_id', v_burger, 'quantity', 2)));
  refused := false;
  begin perform public.restaurant_promotions_apply(org, o4, 'welcome10');
  exception when check_violation then refused := true; end;
  assert refused, 'the code''s single use is spent';

  -- ---- loyalty -------------------------------------------------------------
  perform auth.as_admin();
  update public.restaurant_orders set guest_phone = '01055555555' where id = o1;
  perform auth.login_as(u_owner);
  perform public.restaurant_set_order_status(org, o1, 'ready');
  perform public.restaurant_set_order_status(org, o1, 'served');
  perform public.restaurant_set_order_status(org, o1, 'completed');
  perform auth.as_admin();
  assert (select out_balance from app.loyalty_points(org, app.phone_key('01055555555'))) = 26, '26400 / 1000 = 26 points';

  perform auth.login_as(u_owner);
  rw_disc := public.restaurant_loyalty_reward_save(org, null, 'خصم 50', 20, 'discount', 5000, null);
  rw_free := public.restaurant_loyalty_reward_save(org, null, 'عصير مجاني', 30, 'free_item', null, v_juice);
  perform auth.login_as(u_acct);
  refused := false;
  begin perform public.restaurant_loyalty_adjust(org, '01055555555', 10, 'تعويض تأخير');
  exception when sqlstate 'LB403' then refused := true; end;
  assert refused, 'a point adjustment needs a manager';
  select out_grant into g from public.approval_grant(org, br, 'loyalty.adjust', org, 10, m_owner, '4826');
  assert public.restaurant_loyalty_adjust(org, '01055555555', 10, 'تعويض تأخير') = 36, 'adjusted balance';
  perform auth.login_as(u_cash);
  j := public.restaurant_loyalty_staff_redeem(org, br, '+20 105 555 5555', rw_free);
  assert (j ->> 'value_cents')::bigint = 4000 and (j ->> 'balance')::int = 6, 'free juice = its price, 30 points spent';
  refused := false;
  begin perform public.restaurant_loyalty_staff_redeem(org, br, '01055555555', rw_disc);
  exception when check_violation then refused := true; end;
  assert refused, 'not enough points left';

  -- ---- house accounts --------------------------------------------------------
  perform auth.as_admin();
  insert into public.customers (organization_id, name, phone) values (org, 'شركة النيل', '0223456789') returning id into cust;
  perform auth.login_as(u_cash);
  refused := false;
  begin perform public.restaurant_account_save(org, cust, 30000, 30, true);
  exception when insufficient_privilege then refused := true; end;
  assert refused, 'a cashier does not open accounts';
  perform auth.login_as(u_acct);
  perform public.restaurant_account_save(org, cust, 30000, 30, true, 'أ. سامي');

  perform auth.login_as(u_cash);
  perform public.restaurant_set_order_status(org, o3, 'confirmed');
  j := public.restaurant_account_charge(org, o3, cust);
  assert (j ->> 'amount_cents')::bigint = 18000 and (j ->> 'balance_cents')::bigint = 18000, 'charged after the code discount';
  refused := false;
  begin perform public.restaurant_account_charge(org, o3, cust);
  exception when check_violation then refused := true; end;
  assert refused, 'an order is charged once';
  perform public.restaurant_set_order_status(org, o4, 'confirmed');
  refused := false;
  begin perform public.restaurant_account_charge(org, o4, cust);
  exception when sqlstate 'LB403' then refused := true; end;
  assert refused, 'over the limit needs a manager';
  select out_grant into g from public.approval_grant(org, br, 'account.overlimit', cust, 8000, m_owner, '4826');
  perform public.restaurant_account_charge(org, o4, cust);
  perform auth.as_admin();
  assert app.account_balance(cust) = 38000, 'two charges';
  assert (select i.customer_id from public.invoices i join public.restaurant_orders o on o.invoice_id = i.id where o.id = o4) = cust,
    'invoiced to the account';

  perform auth.login_as(u_acct);
  j := public.restaurant_account_payment(org, br, cust, 25000, 'transfer', 'تحويل 1');
  assert (j ->> 'balance_cents')::bigint = 13000 and (j ->> 'unallocated_cents')::bigint = 0, 'paid down';
  perform auth.as_admin();
  assert (select i.status from public.invoices i join public.restaurant_orders o on o.invoice_id = i.id where o.id = o3) = 'paid', 'oldest invoice paid first';
  assert (select i.paid_cents from public.invoices i join public.restaurant_orders o on o.invoice_id = i.id where o.id = o4) = 7000, 'remainder on the next';

  perform auth.login_as(u_acct);
  refused := false;
  begin perform public.restaurant_account_adjust(org, br, cust, -3000, 'خصم تعاقد');
  exception when sqlstate 'LB403' then refused := true; end;
  assert refused, 'an account adjustment needs a manager';
  select out_grant into g from public.approval_grant(org, br, 'account.adjust', cust, 3000, m_owner, '4826');
  assert public.restaurant_account_adjust(org, br, cust, -3000, 'خصم تعاقد') = 10000, 'credit note applied';

  j := public.restaurant_account_statement(org, cust, (now() - interval '1 day')::date, (now() + interval '1 day')::date);
  assert (j ->> 'opening_cents')::bigint = 0 and (j ->> 'closing_cents')::bigint = 10000, 'statement balances';
  assert jsonb_array_length(j -> 'entries') = 4
     and (j -> 'entries' -> 3 ->> 'balance_cents')::bigint = 10000, 'four entries with a running balance';
  perform auth.as_admin();
  refused := false;
  begin update public.restaurant_account_entries set amount_cents = 1 where customer_id = cust;
  exception when check_violation then refused := true; end;
  assert refused, 'the account ledger is append-only';
  assert exists (select 1 from public.audit_logs where action = 'restaurant.account.adjusted' and (after ->> 'approved_by')::uuid = u_owner),
    'adjustment audited with its approver';

  -- ---- isolation -----------------------------------------------------------
  perform auth.login_as(u_other);
  assert (select count(*) from public.restaurant_house_accounts where organization_id = org) = 0, 'accounts private';
  assert (select count(*) from public.restaurant_account_entries where organization_id = org) = 0, 'ledger private';
  assert (select count(*) from public.restaurant_promotions where organization_id = org) = 0, 'promotions private';
  refused := false;
  begin perform public.restaurant_account_statement(org, cust, now()::date, now()::date);
  exception when insufficient_privilege then refused := true; end;
  assert refused, 'another store cannot read a statement';
  perform auth.login_as(u_cash);
  assert (select count(*) from public.restaurant_account_entries where organization_id = org) = 0, 'cashiers see limits, not the ledger';
  assert (select count(*) from public.restaurant_accounts_list(org)) = 1, 'but can pick the account at the till';

  perform auth.as_admin();
  raise notice 'crm, promotions and accounts OK';
end $$;
