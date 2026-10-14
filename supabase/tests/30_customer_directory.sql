-- =============================================================================
-- LOCAL BASIC — customer directory + reset (0097)
-- =============================================================================
\set ON_ERROR_STOP on

do $$
declare
  u_a uuid; org_a uuid; br_a uuid;
  u_b uuid; org_b uuid; br_b uuid;
  r record; n int; rows_n int;
begin
  insert into auth.users (email) values ('d30a@test.local') returning id into u_a;
  insert into auth.users (email) values ('d30b@test.local') returning id into u_b;
  perform auth.login_as(u_a);
  select out_organization_id, out_branch_id into org_a, br_a from public.provision_workspace('D30 Alpha', 'd30alpha', 'restaurant');
  perform auth.login_as(u_b);
  select out_organization_id, out_branch_id into org_b, br_b from public.provision_workspace('D30 Beta', 'd30beta', 'restaurant');
  perform auth.as_admin();

  -- Mona orders under three spellings of one number: two completed, one cancelled, one open.
  insert into public.restaurant_orders (organization_id, branch_id, number, currency, channel, type, status, subtotal_cents, total_cents, guest_name, guest_phone, placed_at) values
    (org_a, br_a, 'D-1', 'EGP', 'online', 'pickup', 'completed', 25000, 25000, 'منى', '01012345678', now() - interval '10 days'),
    (org_a, br_a, 'D-2', 'EGP', 'online', 'pickup', 'completed', 15000, 15000, 'منى أحمد', '+20 101 234 5678', now() - interval '2 days'),
    (org_a, br_a, 'D-3', 'EGP', 'online', 'pickup', 'cancelled', 9999, 9999, 'منى', '201012345678', now() - interval '1 day'),
    (org_a, br_a, 'D-4', 'EGP', 'online', 'pickup', 'preparing', 7000, 7000, 'منى أحمد', '01012345678', now() - interval '1 hour'),
  -- Sami: one completed order. Noor: only ever stuck at verification (must not be listed).
    (org_a, br_a, 'D-5', 'EGP', 'online', 'pickup', 'completed', 50000, 50000, 'سامي', '01199998888', now() - interval '40 days'),
    (org_a, br_a, 'D-6', 'EGP', 'online', 'pickup', 'pending_verification', 5000, 5000, 'نور', '01234567890', now() - interval '3 days');
  -- Another store's guest with a number that is also Mona's: must never leak.
  insert into public.restaurant_orders (organization_id, branch_id, number, currency, channel, type, status, subtotal_cents, total_cents, guest_name, guest_phone)
  values (org_b, br_b, 'B-1', 'EGP', 'online', 'pickup', 'completed', 99000, 99000, 'غريب', '01012345678');
  -- A staff-created customer with no orders at all.
  insert into public.customers (organization_id, name, phone) values (org_a, 'خالد', '01555555555');
  -- Two verified devices for Mona (different spellings), one unverified.
  insert into public.restaurant_guest_devices (organization_id, device_id, phone, verified_at) values
    (org_a, 'device-mona-0001', '01012345678', now()),
    (org_a, 'device-mona-0002', '+201012345678', now());
  insert into public.restaurant_guest_devices (organization_id, device_id, phone) values (org_a, 'device-stranger-1', '01012345678');
  -- Loyalty on: 1 point per 10 EGP; Mona spent 40,000 → 40 points; used 30 on a coupon.
  insert into public.restaurant_loyalty_settings (organization_id, enabled, cents_per_point, reward_points, reward_value_cents)
  values (org_a, true, 1000, 30, 2000);
  insert into public.restaurant_loyalty_coupons (organization_id, phone_key, code, points_cost, value_cents, expires_at)
  values (org_a, '012345678', 'LB-D30AAA', 30, 2000, now() + interval '30 days');

  -- ---- the directory -------------------------------------------------------
  perform auth.login_as(u_a);
  select count(*) into rows_n from public.restaurant_customer_directory(org_a);
  assert rows_n = 3, format('Mona, Sami and Khaled expected, got %s', rows_n);

  select * into r from public.restaurant_customer_directory(org_a) where out_name like 'منى%';
  assert r.out_orders = 3, format('Mona: 3 live orders expected (cancelled excluded), got %s', r.out_orders);
  assert r.out_spent_cents = 40000, format('Mona spent 40000, got %s', r.out_spent_cents);
  assert r.out_points = 10, format('Mona: 40 earned - 30 used = 10, got %s', r.out_points);
  assert r.out_devices = 2, format('two verified devices, got %s', r.out_devices);
  assert r.out_name = 'منى أحمد', format('latest name wins, got %s', r.out_name);
  assert r.out_loyalty_enabled, 'loyalty flag';
  assert r.out_last_order_at > now() - interval '2 hours', 'last order is the open one';

  select * into r from public.restaurant_customer_directory(org_a) where out_name = 'سامي';
  assert r.out_orders = 1 and r.out_spent_cents = 50000 and r.out_points = 50 and r.out_devices = 0, 'Sami row';

  select * into r from public.restaurant_customer_directory(org_a) where out_name = 'خالد';
  assert r.out_orders = 0 and r.out_customer_id is not null and r.out_last_order_at is null, 'staff-created customer with no orders';

  assert not exists (select 1 from public.restaurant_customer_directory(org_a) where out_name in ('نور', 'غريب')),
    'a guest stuck at verification, or another store''s guest, must not be listed';
  raise notice 'D30: directory aggregates guests by phone, across spellings and stores';

  -- ---- permissions ---------------------------------------------------------
  perform auth.login_as(u_b);
  begin
    perform 1 from public.restaurant_customer_directory(org_a);
    assert false, 'another store''s owner must not read this directory';
  exception when insufficient_privilege then null; end;
  begin
    perform 1 from public.restaurant_customer_reset(org_a, '01012345678');
    assert false, 'another store''s owner must not reset';
  exception when insufficient_privilege then null; end;
  perform auth.logout();
  begin
    perform 1 from public.restaurant_customer_directory(org_a);
    assert false, 'anon must not read the directory';
  exception when others then null; end;
  begin
    perform 1 from public.restaurant_customer_reset(org_a, '01012345678');
    assert false, 'anon must not reset';
  exception when others then null; end;

  -- ---- reset ---------------------------------------------------------------
  -- Before: Mona's verified device opens the profile.
  assert (public.customer_profile('d30alpha', 'device-mona-0001', '01012345678') ->> 'verified')::boolean, 'recognised before reset';

  perform auth.login_as(u_a);
  begin
    perform 1 from public.restaurant_customer_reset(org_a, '123');
    assert false, 'a too-short number is refused';
  exception when check_violation then null; end;
  select * into r from public.restaurant_customer_reset(org_a, '+20 101 234 5678', true);
  assert r.out_devices_removed = 3, format('all three bindings removed (verified or not), got %s', r.out_devices_removed);
  perform auth.as_admin();

  assert (select count(*) from public.restaurant_guest_devices where organization_id = org_a and app.phone_key(phone) = '012345678') = 0, 'no binding left';
  assert (select count(*) from public.restaurant_orders where organization_id = org_a and app.phone_key(guest_phone) = '012345678') = 4, 'order history is kept';
  assert exists (select 1 from public.restaurant_guest_devices where organization_id = org_a) = false, 'only Mona had devices';

  perform auth.logout();
  assert not (public.customer_profile('d30alpha', 'device-mona-0001', '01012345678') ->> 'verified')::boolean,
    'after reset the same device must verify again';
  perform auth.login_as(u_a);
  select * into r from public.restaurant_customer_directory(org_a) where out_name like 'منى%';
  assert r.out_devices = 0 and r.out_orders = 3 and r.out_spent_cents = 40000, 'still listed, with no devices and the same history';

  -- Removing the staff-created customer record too.
  select * into r from public.restaurant_customer_reset(org_a, '01555555555', true);
  assert r.out_customers_removed = 1 and r.out_devices_removed = 0, 'customer record soft-deleted';
  assert not exists (select 1 from public.restaurant_customer_directory(org_a) where out_name = 'خالد'), 'Khaled is gone from the directory';
  perform auth.as_admin();
  assert exists (select 1 from public.customers where name = 'خالد' and deleted_at is not null), 'soft delete, not a real delete';
  assert exists (select 1 from public.audit_logs where action = 'restaurant.customer.reset' and organization_id = org_a), 'audited';
  assert not exists (select 1 from public.audit_logs where action = 'restaurant.customer.reset' and (after::text like '%01012345678%')), 'the full number is never logged';
  raise notice 'D30: reset removes bindings, keeps history, audits without the number';
end $$;
