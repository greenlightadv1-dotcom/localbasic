-- =============================================================================
-- LOCAL BASIC — Retail shipping suite (migration 0049)
--
-- Shipping is a boundary, not an integration: no courier is named in the
-- schema and none is called from the database. The claims to prove are about
-- keeping that boundary honest, and about not letting a parcel rewrite money:
--
--   1. Only a delivery order can be shipped, and only while it is open.
--   2. The address is COPIED from the order, not supplied by the caller.
--   3. A tracking code is accepted, never invented.
--   4. One parcel in flight per order; a retry is a new row, not an edit.
--   5. The state machine is enumerated, a failure must say why, and delivered,
--      failed and cancelled are final.
--   6. What the shop pays the carrier is a treasury cost with its own
--      category, settled once, and separate from what the customer paid.
--   7. Managing shipments needs retail.order.manage; paying also needs
--      treasury.create.
--   8. One tenant cannot see or move another's parcels.
--
-- Run with:  psql -v ON_ERROR_STOP=1 -f supabase/tests/21_retail_shipping.sql
-- =============================================================================

\set ON_ERROR_STOP on

do $$
declare
  u_a      uuid;  u_b uuid;  u_clerk uuid;
  org_a    uuid;  org_b uuid;
  br_a     uuid;  br_b uuid;
  prod_a   uuid;  var_a uuid;
  prov_a   uuid;  prov_b uuid;
  ord_del  uuid;  ord_pick uuid;  ord_b uuid;
  ship     uuid;  ship2 uuid;
  role_c   uuid;  member_c uuid;
  n        int;
  ok       boolean;
  amt      bigint;
  st       text;
  r        record;
begin
  -- ==========================================================================
  -- Fixture: two shops with open stores, one delivery order each.
  -- ==========================================================================
  insert into auth.users (email) values ('shipa@test.local')     returning id into u_a;
  insert into auth.users (email) values ('shipb@test.local')     returning id into u_b;
  insert into auth.users (email) values ('shipclerk@test.local') returning id into u_clerk;

  perform auth.login_as(u_a);
  select out_organization_id, out_branch_id into org_a, br_a
    from public.provision_workspace('متجر الشحن', 'shipalpha', 'retail');
  perform auth.login_as(u_b);
  select out_organization_id, out_branch_id into org_b, br_b
    from public.provision_workspace('متجر آخر', 'shipbeta', 'retail');

  perform auth.as_admin();
  insert into public.retail_products (organization_id, name, is_online)
    values (org_a, 'حقيبة', true) returning id into prod_a;
  insert into public.retail_variants (organization_id, product_id, price_cents)
    values (org_a, prod_a, 30000) returning id into var_a;
  insert into public.retail_stock_movements
    (organization_id, branch_id, variant_id, quantity_delta, reason)
  values (org_a, br_a, var_a, 20, 'initial');

  insert into public.settings (organization_id, branch_id, key, value)
    values (org_a, null, 'retail.store_enabled', 'true'::jsonb);
  insert into public.settings (organization_id, branch_id, key, value)
    values (org_b, null, 'retail.store_enabled', 'true'::jsonb);

  insert into public.retail_shipping_providers
    (organization_id, provider_key, name, default_cost_cents)
  values (org_a, 'manual', 'مندوب المتجر', 4000) returning id into prov_a;
  insert into public.retail_shipping_providers
    (organization_id, provider_key, name)
  values (org_b, 'manual', 'مندوب آخر') returning id into prov_b;

  perform auth.logout();
  select out_order_id into ord_del from public.retail_place_order(
    'shipalpha', 'main',
    jsonb_build_array(jsonb_build_object('variant_id', var_a, 'quantity', 1)),
    'delivery', 'زائر التوصيل', '01000000000', 'cash_on_delivery', null, null,
    'المستلم', '01000000000', 'القاهرة', 'المعادي', 'شارع 9، عمارة 3', 'بجوار الصيدلية');

  select out_order_id into ord_pick from public.retail_place_order(
    'shipalpha', 'main',
    jsonb_build_array(jsonb_build_object('variant_id', var_a, 'quantity', 1)),
    'pickup', 'زائر الاستلام', '01000000001');

  -- ==========================================================================
  -- 1. Only a delivery order, and only while it is open
  -- ==========================================================================
  perform auth.login_as(u_a);

  ok := false;
  begin perform public.retail_shipment_create(org_a, br_a, ord_pick);
  exception when others then ok := true; end;
  assert ok, 'FAIL: a pickup order was shipped';

  select out_id, out_provider_key into r
    from public.retail_shipment_create(org_a, br_a, ord_del, prov_a);
  ship := r.out_id;
  assert ship is not null, 'FAIL: no shipment was created';
  assert r.out_provider_key = 'manual',
    format('FAIL: the provider key is %s', r.out_provider_key);

  raise notice 'SHIPPING: only a delivery order can be shipped';

  -- ==========================================================================
  -- 2. The address is copied from the order, not supplied
  -- ==========================================================================
  select recipient_name, city, address_line, cost_cents, currency, status into r
    from public.retail_shipments where id = ship;
  assert r.recipient_name = 'المستلم',
    format('FAIL: the recipient is %s', r.recipient_name);
  assert r.city = 'القاهرة', format('FAIL: the city is %s', r.city);
  assert r.address_line like 'شارع 9، عمارة 3%',
    format('FAIL: the address is %s', r.address_line);
  -- The provider's own default cost was applied.
  assert r.cost_cents = 4000, format('FAIL: the cost is %s, expected 4000', r.cost_cents);
  assert r.status = 'pending', format('FAIL: a new shipment is %s', r.status);

  -- No function argument exists through which a caller could name an address.
  select count(*) into n
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace,
    lateral unnest(coalesce(p.proargnames, array[]::text[])) as a(name)
   where ns.nspname = 'public' and p.proname = 'retail_shipment_create'
     and (a.name ilike '%address%' or a.name ilike '%city%' or a.name ilike '%recipient%');
  assert n = 0, 'FAIL: the shipment function accepts an address from its caller';

  raise notice 'SHIPPING: the parcel goes where the customer asked, not where the caller says';

  -- ==========================================================================
  -- 3. Tracking is accepted, never invented
  -- ==========================================================================
  select tracking_code into st from public.retail_shipments where id = ship;
  assert st is null, format('FAIL: a tracking code was invented (%s)', st);

  perform public.retail_shipment_set_tracking(org_a, br_a, ship, 'TRK-123', 'https://t.test/1');
  select tracking_code, tracking_url into r from public.retail_shipments where id = ship;
  assert r.tracking_code = 'TRK-123', format('FAIL: the tracking code is %s', r.tracking_code);

  -- A tracking URL must be https: a link the shop shows a customer is not a
  -- place to downgrade their connection.
  perform auth.as_admin();
  ok := false;
  begin
    update public.retail_shipments set tracking_url = 'http://t.test/1' where id = ship;
  exception when others then ok := true; end;
  assert ok, 'FAIL: an insecure tracking URL was stored';
  perform auth.login_as(u_a);

  raise notice 'SHIPPING: tracking is recorded, not generated';

  -- ==========================================================================
  -- 4. One parcel in flight per order
  -- ==========================================================================
  ok := false;
  begin perform public.retail_shipment_create(org_a, br_a, ord_del, prov_a);
  exception when others then ok := true; end;
  assert ok, 'FAIL: a second parcel was sent for the same order';

  -- ==========================================================================
  -- 5. The state machine
  -- ==========================================================================
  ok := false;
  begin perform public.retail_shipment_set_status(org_a, br_a, ship, 'delivered');
  exception when others then ok := true; end;
  assert ok, 'FAIL: a pending shipment jumped straight to delivered';

  perform public.retail_shipment_set_status(org_a, br_a, ship, 'dispatched');
  select status, dispatched_at is not null into r from public.retail_shipments where id = ship;
  assert r.status = 'dispatched', format('FAIL: status is %s after dispatch', r.status);

  ok := false;
  begin perform public.retail_shipment_set_status(org_a, br_a, ship, 'cancelled');
  exception when others then ok := true; end;
  assert ok, 'FAIL: a dispatched parcel was cancelled';

  -- A failure has to say why.
  ok := false;
  begin perform public.retail_shipment_set_status(org_a, br_a, ship, 'failed', null);
  exception when others then ok := true; end;
  assert ok, 'FAIL: a shipment failed with no reason';

  perform public.retail_shipment_set_status(org_a, br_a, ship, 'failed', 'العميل لم يرد');
  select status, failure_reason into r from public.retail_shipments where id = ship;
  assert r.status = 'failed', format('FAIL: status is %s', r.status);
  assert r.failure_reason = 'العميل لم يرد', 'FAIL: the reason was not kept';

  ok := false;
  begin perform public.retail_shipment_set_status(org_a, br_a, ship, 'dispatched');
  exception when others then ok := true; end;
  assert ok, 'FAIL: a failed shipment was revived';

  -- A retry is a NEW row, and the failed attempt survives.
  select out_id into ship2 from public.retail_shipment_create(org_a, br_a, ord_del, prov_a);
  assert ship2 <> ship, 'FAIL: the retry reused the failed shipment';

  select count(*) into n from public.retail_shipments where order_id = ord_del;
  assert n = 2, format('FAIL: %s shipments for one order, expected 2', n);

  raise notice 'SHIPPING: the state machine holds and a retry is a new attempt';

  -- ==========================================================================
  -- 6. What the shop pays the carrier
  -- ==========================================================================
  perform public.retail_shipment_set_status(org_a, br_a, ship2, 'dispatched');
  perform public.retail_shipment_set_status(org_a, br_a, ship2, 'delivered');

  amt := public.retail_shipment_pay(org_a, br_a, ship2);
  assert amt = 4000, format('FAIL: the settled cost is %s', amt);

  select count(*) into n from public.treasury_transactions
   where ref_type = 'retail_shipment' and ref_id = ship2
     and direction = 'out' and amount_cents = 4000 and category = 'shipping';
  assert n = 1, 'FAIL: the carrier was not paid out of the treasury';

  ok := false;
  begin perform public.retail_shipment_pay(org_a, br_a, ship2);
  exception when others then ok := true; end;
  assert ok, 'FAIL: the same shipment was settled twice';

  -- The customer's delivery fee is a different number in a different place.
  select delivery_fee_cents into amt from public.retail_orders where id = ord_del;
  assert amt <> 4000 or amt = 0,
    'FAIL: the carrier cost and the customer fee are being conflated';

  raise notice 'SHIPPING: the carrier cost is treasury money, settled once';

  -- ==========================================================================
  -- 7. Permission separation
  -- ==========================================================================
  perform auth.as_admin();
  insert into public.organization_members (organization_id, user_id, status)
    values (org_a, u_clerk, 'active') returning id into member_c;
  insert into public.member_branches (member_id, branch_id) values (member_c, br_a);
  insert into public.roles (organization_id, key, name_ar, name_en)
    values (org_a, 'shipclerk', 'موظف شحن', 'Shipping clerk') returning id into role_c;
  -- May read orders, and may move parcels — but holds no treasury right.
  insert into public.role_permissions (role_id, permission_key)
    values (role_c, 'retail.order.read'), (role_c, 'retail.order.manage');
  insert into public.user_roles (member_id, role_id) values (member_c, role_c);

  perform auth.login_as(u_clerk);
  select count(*) into n from public.retail_shipments where order_id = ord_del;
  assert n = 2, 'FAIL: a shipping clerk could not read the parcels';

  select out_id into ship from public.retail_shipment_create(org_a, br_a, ord_del, prov_a);
  assert ship is not null, 'FAIL: a shipping clerk could not create a parcel';

  ok := false;
  begin perform public.retail_shipment_pay(org_a, br_a, ship);
  exception when others then ok := true; end;
  assert ok, 'FAIL: a clerk with no treasury right paid the carrier';

  raise notice 'SHIPPING: moving a parcel and paying for it are separate rights';

  -- ==========================================================================
  -- 8. Tenant isolation
  -- ==========================================================================
  perform auth.login_as(u_b);
  select count(*) into n from public.retail_shipments where order_id = ord_del;
  assert n = 0, 'FAIL: tenant B read tenant A''s parcels';

  select count(*) into n from public.retail_shipping_providers where id = prov_a;
  assert n = 0, 'FAIL: tenant B read tenant A''s carriers';

  for st in select unnest(array['create','status','tracking','pay']) loop
    ok := false;
    begin
      if st = 'create' then
        perform public.retail_shipment_create(org_b, br_b, ord_del);
      elsif st = 'status' then
        perform public.retail_shipment_set_status(org_b, br_b, ship, 'dispatched');
      elsif st = 'tracking' then
        perform public.retail_shipment_set_tracking(org_b, br_b, ship, 'X');
      else
        perform public.retail_shipment_pay(org_b, br_b, ship);
      end if;
    exception when others then ok := true; end;
    assert ok, format('FAIL: tenant B ran %s on tenant A''s shipment', st);

    ok := false;
    begin
      if st = 'create' then
        perform public.retail_shipment_create(org_a, br_a, ord_del);
      elsif st = 'status' then
        perform public.retail_shipment_set_status(org_a, br_a, ship, 'dispatched');
      elsif st = 'tracking' then
        perform public.retail_shipment_set_tracking(org_a, br_a, ship, 'X');
      else
        perform public.retail_shipment_pay(org_a, br_a, ship);
      end if;
    exception when others then ok := true; end;
    assert ok, format('FAIL: tenant B ran %s by naming tenant A', st);
  end loop;

  -- Nor can a shop attach another shop's carrier.
  perform auth.login_as(u_a);
  ok := false;
  begin perform public.retail_shipment_create(org_a, br_a, ord_del, prov_b);
  exception when others then ok := true; end;
  assert ok, 'FAIL: another organization''s carrier was attached';

  raise notice 'SHIPPING: one shop cannot see or move another''s parcels';

  -- ==========================================================================
  -- 9. Audit
  -- ==========================================================================
  perform auth.as_admin();
  select count(distinct action) into n from public.audit_logs
   where organization_id = org_a and entity_type = 'retail_shipment';
  assert n >= 4,
    format('FAIL: %s distinct shipping actions audited, expected at least 4', n);

  raise notice 'SHIPPING: every shipping action is audited';

  raise notice 'RETAIL SHIPPING: all assertions passed';
end $$;
