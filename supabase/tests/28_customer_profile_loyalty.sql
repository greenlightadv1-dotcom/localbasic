-- =============================================================================
-- LOCAL BASIC — guest profile + loyalty (0095)
--
-- Claims: (1) a profile opens only for a device VERIFIED for that phone;
-- (2) points are derived from COMPLETED orders and cannot be double-spent;
-- (3) a reward coupon redeems once, only for its own customer, only by staff,
--     and releases cleanly; (4) nothing is readable through the tables.
-- =============================================================================
\set ON_ERROR_STOP on

do $$
declare
  u_a uuid; org_a uuid; branch_a uuid;
  u_b uuid; org_b uuid; branch_b uuid;
  o1 uuid; o2 uuid; o_other uuid; o_open uuid; o_small uuid;
  prof jsonb; claim jsonb; cpn text; v bigint; n int; ok boolean;
begin
  insert into auth.users (email) values ('l28a@test.local') returning id into u_a;
  insert into auth.users (email) values ('l28b@test.local') returning id into u_b;
  perform auth.login_as(u_a);
  select out_organization_id, out_branch_id into org_a, branch_a
    from public.provision_workspace('L28 Alpha', 'l28alpha', 'restaurant');
  perform auth.login_as(u_b);
  select out_organization_id, out_branch_id into org_b, branch_b
    from public.provision_workspace('L28 Beta', 'l28beta', 'restaurant');
  perform auth.as_admin();

  -- Customer 01012345678: two completed orders (40,000 cents), one open order.
  insert into public.restaurant_orders (organization_id, branch_id, number, currency, channel, type, status, subtotal_cents, total_cents, guest_name, guest_phone)
  values (org_a, branch_a, 'L-1', 'EGP', 'online', 'delivery', 'completed', 25000, 25000, 'منى', '01012345678') returning id into o1;
  insert into public.restaurant_orders (organization_id, branch_id, number, currency, channel, type, status, subtotal_cents, total_cents, guest_name, guest_phone)
  values (org_a, branch_a, 'L-2', 'EGP', 'online', 'pickup', 'completed', 15000, 15000, 'منى', '+20 101 234 5678') returning id into o2;
  insert into public.restaurant_orders (organization_id, branch_id, number, currency, channel, type, status, subtotal_cents, total_cents, guest_name, guest_phone)
  values (org_a, branch_a, 'L-3', 'EGP', 'online', 'pickup', 'preparing', 9000, 9000, 'منى', '01012345678') returning id into o_open;
  -- A different customer, same store.
  insert into public.restaurant_orders (organization_id, branch_id, number, currency, channel, type, status, subtotal_cents, total_cents, guest_name, guest_phone)
  values (org_a, branch_a, 'L-4', 'EGP', 'online', 'pickup', 'completed', 50000, 50000, 'سامي', '01199998888') returning id into o_other;
  insert into public.restaurant_order_deliveries (order_id, organization_id, branch_id, recipient_name, phone, city, address)
  values (o1, org_a, branch_a, 'منى', '01012345678', 'القاهرة', '12 شارع التحرير');

  -- Verified device for Mona; an UNVERIFIED row for another device.
  insert into public.restaurant_guest_devices (organization_id, device_id, phone, verified_at)
  values (org_a, 'device-mona-0001', '01012345678', now());
  insert into public.restaurant_guest_devices (organization_id, device_id, phone)
  values (org_a, 'device-stranger-1', '01012345678');

  -- ---- 1. recognition -----------------------------------------------------
  perform auth.logout();
  prof := public.customer_profile('l28alpha', 'device-stranger-1', '01012345678');
  assert (prof ->> 'verified')::boolean = false and not (prof ? 'orders'), 'unverified device must get nothing';
  prof := public.customer_profile('l28alpha', 'device-mona-0001', '01199998888');
  assert (prof ->> 'verified')::boolean = false, 'a verified device must not open another phone';
  prof := public.customer_profile('l28beta', 'device-mona-0001', '01012345678');
  assert (prof ->> 'verified')::boolean = false, 'verification does not carry across stores';
  prof := public.customer_profile('l28alpha', 'device-mona-0001', '+201012345678');
  assert (prof ->> 'verified')::boolean, 'phone format differences must still match';
  assert jsonb_array_length(prof -> 'orders') = 3, format('expected 3 orders, got %s', jsonb_array_length(prof -> 'orders'));
  assert jsonb_array_length(prof -> 'addresses') = 1, 'one saved address from past deliveries';
  assert not (prof::text like '%سامي%'), 'another customer''s data leaked';
  raise notice 'L28: profile opens only for a verified device + phone';

  -- ---- 2. points ----------------------------------------------------------
  assert (prof #>> '{loyalty,enabled}')::boolean = false, 'loyalty is off until the owner enables it';
  assert (prof #>> '{loyalty,earned}')::int = 40, format('40 points expected, got %s', prof #>> '{loyalty,earned}');
  begin
    perform public.customer_claim_reward('l28alpha', 'device-mona-0001', '01012345678');
    assert false, 'claim must fail while loyalty is disabled';
  exception when check_violation then null; end;

  -- The rules are public only once the owner switches the program on (0096).
  select count(*) into n from public.loyalty_public_info('l28alpha');
  assert n = 0, 'rules must not be exposed while the program is off';

  perform auth.login_as(u_a);
  perform public.restaurant_loyalty_settings_save(org_a, true, 1000, 30, 2000, 90);
  perform auth.logout();

  select count(*) into n from public.loyalty_public_info('l28alpha') where out_reward_points = 30 and out_cents_per_point = 1000;
  assert n = 1, 'anon reads the rules once the program is on';
  select count(*) into n from public.loyalty_public_info('l28beta');
  assert n = 0, 'another store''s program stays private';

  begin
    perform public.customer_claim_reward('l28alpha', 'device-stranger-1', '01012345678');
    assert false, 'claim from an unverified device must fail';
  exception when insufficient_privilege then null; end;

  claim := public.customer_claim_reward('l28alpha', 'device-mona-0001', '01012345678');
  cpn := claim ->> 'code';
  assert cpn ~ '^LB-[A-Z2-9]{6}$', 'coupon code shape';
  prof := public.customer_profile('l28alpha', 'device-mona-0001', '01012345678');
  assert (prof #>> '{loyalty,balance}')::int = 10, 'balance drops by the reward cost';
  begin
    perform public.customer_claim_reward('l28alpha', 'device-mona-0001', '01012345678');
    assert false, 'second claim must fail: 10 points left';
  exception when check_violation then null; end;
  assert jsonb_array_length(prof -> 'coupons') = 1, 'the coupon is listed';
  raise notice 'L28: points derive from completed orders and cannot be double-spent';

  -- ---- 3. staff redemption ------------------------------------------------
  begin
    perform public.restaurant_coupon_check(org_a, o1, cpn);
    assert false, 'anon must not reach staff functions';
  exception when others then null; end;

  perform auth.login_as(u_b);
  begin
    perform public.restaurant_coupon_check(org_a, o1, cpn);
    assert false, 'another store''s staff must be refused';
  exception when insufficient_privilege then null; end;

  perform auth.login_as(u_a);
  select out_value_cents into v from public.restaurant_coupon_check(org_a, o_open, cpn);
  assert v = 2000, 'check returns the coupon value';
  begin
    perform public.restaurant_coupon_check(org_a, o_other, cpn);
    assert false, 'a coupon belongs to its own customer only';
  exception when check_violation then null; end;
  begin
    perform public.restaurant_coupon_check(org_a, o_open, 'LB-NOPE00');
    assert false, 'unknown code';
  exception when check_violation then null; end;

  v := public.restaurant_coupon_redeem(org_a, o_open, cpn);
  assert v = 2000, 'redeem returns the discount';
  begin
    perform public.restaurant_coupon_redeem(org_a, o_open, cpn);
    assert false, 'a coupon redeems once';
  exception when check_violation then null; end;

  perform public.restaurant_coupon_release(org_a, o_open, cpn);
  v := public.restaurant_coupon_redeem(org_a, o_open, lower(cpn));
  assert v = 2000, 'release makes it usable again; codes are case-insensitive';

  -- value is capped at the order total
  perform auth.as_admin();
  update public.restaurant_loyalty_coupons set status = 'active', redeemed_order_id = null where code = cpn;
  insert into public.restaurant_orders (organization_id, branch_id, number, currency, channel, type, status, subtotal_cents, total_cents, guest_name, guest_phone)
  values (org_a, branch_a, 'L-5', 'EGP', 'online', 'pickup', 'new', 1500, 1500, 'منى', '01012345678') returning id into o_small;
  perform auth.login_as(u_a);
  select out_value_cents into v from public.restaurant_coupon_check(org_a, o_small, cpn);
  assert v = 1500, format('discount capped at the order total, got %s', v);

  -- expired
  perform auth.as_admin();
  update public.restaurant_loyalty_coupons set expires_at = now() - interval '1 day' where code = cpn;
  perform auth.login_as(u_a);
  begin
    perform public.restaurant_coupon_check(org_a, o_small, cpn);
    assert false, 'expired coupon';
  exception when check_violation then null; end;
  raise notice 'L28: coupons redeem once, for their own customer, via staff only';

  -- ---- 4. tables are closed ----------------------------------------------
  perform auth.logout();
  begin
    perform 1 from public.restaurant_loyalty_coupons limit 1;
    assert false, 'anon must not read coupons';
  exception when insufficient_privilege then null; end;
  perform auth.login_as(u_a);
  begin
    perform 1 from public.restaurant_loyalty_coupons limit 1;
    assert false, 'tenant users read through functions only';
  exception when insufficient_privilege then null; end;
  perform auth.as_admin();
  raise notice 'L28: loyalty tables are closed to every client role';
end $$;
