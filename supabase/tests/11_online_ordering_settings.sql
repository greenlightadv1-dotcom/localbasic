-- =============================================================================
-- LOCAL BASIC — Online ordering settings (D1.1) test suite
--
-- The settings decide whether a restaurant is open for online business and
-- what delivery costs. Two things must hold:
--   1. Only a member holding settings.manage may change them, and only within
--      their own organization.
--   2. The guest-facing functions obey them. A page that hides a button is not
--      a control; calling the checkout function directly must fail the same way.
--
-- Run with:  psql -v ON_ERROR_STOP=1 -f supabase/tests/11_online_ordering_settings.sql
-- =============================================================================

\set ON_ERROR_STOP on

do $$
declare
  u_owner   uuid;  u_kitchen uuid;  u_other uuid;
  org       uuid;  branch    uuid;  branch2 uuid;
  org_b     uuid;
  prod      uuid;  var       uuid;
  member    uuid;  role_kitchen uuid;
  price     bigint := 4000;
  items     jsonb;
  n         int;
  ok        boolean;
  msg       text;
  r         record;
  v_setting uuid;
begin
  -- ==========================================================================
  -- Fixture
  -- ==========================================================================
  insert into auth.users (email) values ('d11owner@test.local')   returning id into u_owner;
  insert into auth.users (email) values ('d11kitchen@test.local') returning id into u_kitchen;
  insert into auth.users (email) values ('d11other@test.local')   returning id into u_other;

  perform auth.login_as(u_owner);
  select out_organization_id, out_branch_id into org, branch
    from public.provision_workspace('D11 Diner', 'd11diner', 'restaurant');
  perform auth.login_as(u_other);
  select out_organization_id into org_b
    from public.provision_workspace('D11 Other', 'd11other', 'restaurant');
  perform auth.as_admin();

  insert into public.branches (organization_id, slug, name)
  values (org, 'second', 'الفرع الثاني') returning id into branch2;

  insert into public.restaurant_products (organization_id, name, tax_rate_bp)
  values (org, 'فطير', 0) returning id into prod;
  insert into public.restaurant_variants (organization_id, product_id, name, price_cents)
  values (org, prod, 'default', price) returning id into var;

  items := jsonb_build_array(jsonb_build_object('variant_id', var, 'quantity', 1));

  -- A kitchen user: a real member of the org, with no settings.manage.
  insert into public.organization_members (organization_id, user_id, status, all_branches, joined_at)
  values (org, u_kitchen, 'active', true, now()) returning id into member;
  select id into role_kitchen from public.roles
   where organization_id = org and key = 'kitchen' limit 1;
  if role_kitchen is null then
    select id into role_kitchen from public.roles
     where organization_id = org and not is_owner limit 1;
  end if;
  insert into public.user_roles (member_id, role_id, branch_id, granted_by)
  values (member, role_kitchen, null, u_owner);

  -- ==========================================================================
  -- 1. The owner can write the four settings
  -- ==========================================================================
  perform auth.login_as(u_owner);

  insert into public.settings (organization_id, branch_id, key, value) values
    (org, null, 'restaurant.online_ordering_enabled', 'true'::jsonb),
    (org, null, 'restaurant.pickup_enabled',          'true'::jsonb),
    (org, null, 'restaurant.delivery_enabled',        'true'::jsonb),
    (org, null, 'restaurant.delivery_fee_cents',      '1500'::jsonb);

  select count(*) into n from public.settings
   where organization_id = org and key like 'restaurant.%';
  assert n >= 4, 'FAIL: the owner could not write the settings, got ' || n;

  raise notice 'D11: an authorized owner can write the settings';

  -- ==========================================================================
  -- 2. Values are validated server-side
  -- ==========================================================================
  for msg in select unnest(array['"yes"', '1', 'null', '[]']) loop
    ok := false;
    begin
      insert into public.settings (organization_id, branch_id, key, value)
      values (org, branch2, 'restaurant.online_ordering_enabled', msg::jsonb);
    exception when others then ok := true;
    end;
    assert ok, 'FAIL: a non-boolean (' || msg || ') was stored as a switch';
  end loop;

  for msg in select unnest(array['-1', '1000001', '12.5', '"1500"']) loop
    ok := false;
    begin
      insert into public.settings (organization_id, branch_id, key, value)
      values (org, branch2, 'restaurant.delivery_fee_cents', msg::jsonb);
    exception when others then ok := true;
    end;
    assert ok, 'FAIL: an invalid delivery fee (' || msg || ') was stored';
  end loop;

  -- A legitimate boundary value is accepted.
  insert into public.settings (organization_id, branch_id, key, value)
  values (org, branch2, 'restaurant.delivery_fee_cents', '0'::jsonb);

  raise notice 'D11: settings values are shape- and range-checked in the database';

  -- ==========================================================================
  -- 3. An unauthorized member cannot change them
  -- ==========================================================================
  perform auth.login_as(u_kitchen);

  assert not app.has_permission(org, 'settings.manage'),
    'FAIL: the kitchen role holds settings.manage — fixture is wrong';

  -- RLS refuses the write. An UPDATE blocked by policy affects zero rows rather
  -- than raising, so the stored value is what is actually checked.
  begin
    update public.settings set value = 'false'::jsonb
     where organization_id = org and branch_id is null
       and key = 'restaurant.online_ordering_enabled';
  exception when others then null;
  end;

  begin
    insert into public.settings (organization_id, branch_id, key, value)
    values (org, branch, 'restaurant.delivery_fee_cents', '99999'::jsonb);
  exception when others then null;
  end;

  perform auth.as_admin();
  select (value #>> '{}')::boolean into ok from public.settings
   where organization_id = org and branch_id is null
     and key = 'restaurant.online_ordering_enabled';
  assert ok, 'FAIL: an unauthorized member switched online ordering off';

  select count(*) into n from public.settings
   where organization_id = org and branch_id = branch
     and key = 'restaurant.delivery_fee_cents';
  assert n = 0, 'FAIL: an unauthorized member set a delivery fee';

  raise notice 'D11: a member without settings.manage cannot change them';

  -- ==========================================================================
  -- 4. Anonymous callers cannot read or write settings
  -- ==========================================================================
  perform auth.logout();

  ok := false;
  begin perform 1 from public.settings limit 1; exception when others then ok := true; end;
  assert ok, 'FAIL: anon can read settings';

  ok := false;
  begin
    insert into public.settings (organization_id, branch_id, key, value)
    values (org, null, 'restaurant.delivery_fee_cents', '0'::jsonb);
  exception when others then ok := true;
  end;
  assert ok, 'FAIL: anon wrote a setting';

  raise notice 'D11: anonymous callers reach no setting at all';

  -- ==========================================================================
  -- 5. Cross-tenant settings are invisible and unwritable
  -- ==========================================================================
  perform auth.login_as(u_other);

  select count(*) into n from public.settings where organization_id = org;
  assert n = 0, 'FAIL: another tenant can read these settings';

  begin
    insert into public.settings (organization_id, branch_id, key, value)
    values (org, null, 'restaurant.delivery_fee_cents', '99999'::jsonb);
  exception when others then null;
  end;

  perform auth.as_admin();
  select (value #>> '{}')::bigint into n from public.settings
   where organization_id = org and branch_id is null
     and key = 'restaurant.delivery_fee_cents';
  assert n = 1500, 'FAIL: another tenant changed the delivery fee to ' || n;

  raise notice 'D11: settings are sealed inside their tenant';

  -- ==========================================================================
  -- 6. Online ordering disabled blocks the checkout function itself
  -- ==========================================================================
  perform auth.login_as(u_owner);
  update public.settings set value = 'false'::jsonb
   where organization_id = org and branch_id is null
     and key = 'restaurant.online_ordering_enabled';
  perform auth.logout();

  -- The storefront page is unreachable...
  ok := false;
  begin perform public.restaurant_online_menu('d11diner', 'main'); exception when others then ok := true; end;
  assert ok, 'FAIL: the menu was served while ordering was disabled';

  -- ...and so is calling the checkout directly, which is the control that counts.
  ok := false;
  begin
    perform public.restaurant_place_online_order(
      'd11diner', 'main', items, 'pickup', 'متسلل', '01000000001', 'd11-disabled-0001');
  exception when others then ok := true;
  end;
  assert ok, 'FAIL: a guest checked out while online ordering was disabled';

  ok := false;
  begin
    perform public.restaurant_price_online_cart('d11diner', 'main', items, 'pickup');
  exception when others then ok := true;
  end;
  assert ok, 'FAIL: a cart was priced while online ordering was disabled';

  perform auth.as_admin();
  select count(*) into n from public.restaurant_orders
   where organization_id = org and channel = 'online';
  assert n = 0, 'FAIL: an order exists despite ordering being disabled';

  raise notice 'D11: disabled online ordering blocks the function, not just the page';

  -- ==========================================================================
  -- 7. Pickup disabled blocks pickup, delivery still works
  -- ==========================================================================
  perform auth.login_as(u_owner);
  update public.settings set value = 'true'::jsonb
   where organization_id = org and branch_id is null
     and key = 'restaurant.online_ordering_enabled';
  update public.settings set value = 'false'::jsonb
   where organization_id = org and branch_id is null and key = 'restaurant.pickup_enabled';
  perform auth.logout();

  ok := false;
  begin
    perform public.restaurant_place_online_order(
      'd11diner', 'main', items, 'pickup', 'استلام', '01000000002', 'd11-nopickup-0001');
  exception when others then ok := true;
  end;
  assert ok, 'FAIL: a pickup order was placed while pickup was disabled';

  -- Delivery is unaffected.
  select out_total_cents into n
    from public.restaurant_place_online_order(
      'd11diner', 'main', items, 'delivery', 'توصيل', '01000000003', 'd11-deliv-0001',
      jsonb_build_object('address', 'شارع 1'));
  assert n = price + 1500, 'FAIL: delivery total is ' || n;

  raise notice 'D11: pickup can be switched off without affecting delivery';

  -- ==========================================================================
  -- 8. Delivery disabled blocks delivery, pickup restored works
  -- ==========================================================================
  perform auth.login_as(u_owner);
  update public.settings set value = 'true'::jsonb
   where organization_id = org and branch_id is null and key = 'restaurant.pickup_enabled';
  update public.settings set value = 'false'::jsonb
   where organization_id = org and branch_id is null and key = 'restaurant.delivery_enabled';
  perform auth.logout();

  ok := false;
  begin
    perform public.restaurant_place_online_order(
      'd11diner', 'main', items, 'delivery', 'توصيل٢', '01000000004', 'd11-nodeliv-0001',
      jsonb_build_object('address', 'شارع 2'));
  exception when others then ok := true;
  end;
  assert ok, 'FAIL: a delivery order was placed while delivery was disabled';

  select out_total_cents into n
    from public.restaurant_place_online_order(
      'd11diner', 'main', items, 'pickup', 'استلام٢', '01000000005', 'd11-pickup-0002');
  assert n = price, 'FAIL: pickup total is ' || n;

  raise notice 'D11: delivery can be switched off without affecting pickup';

  -- ==========================================================================
  -- 9. The configured fee is authoritative; a client fee is not
  -- ==========================================================================
  perform auth.login_as(u_owner);
  update public.settings set value = 'true'::jsonb
   where organization_id = org and branch_id is null and key = 'restaurant.delivery_enabled';
  update public.settings set value = '2750'::jsonb
   where organization_id = org and branch_id is null and key = 'restaurant.delivery_fee_cents';
  perform auth.logout();

  select out_total_cents into n
    from public.restaurant_place_online_order(
      'd11diner', 'main', items, 'delivery', 'رسوم', '01000000006', 'd11-fee-0001',
      jsonb_build_object('address', 'شارع 3', 'delivery_fee_cents', 0));
  assert n = price + 2750,
    'FAIL: a client-supplied delivery fee changed the total: ' || n;

  -- The same attempt through the quote path.
  select delivery_fee_cents into n
    from public.restaurant_price_online_cart('d11diner', 'main', items, 'delivery');
  assert n = 2750, 'FAIL: quoted fee is ' || n;

  -- Pickup is never charged a delivery fee, whatever is configured.
  select out_total_cents into n
    from public.restaurant_place_online_order(
      'd11diner', 'main', items, 'pickup', 'بدون رسوم', '01000000007', 'd11-fee-0002');
  assert n = price, 'FAIL: pickup was charged a delivery fee: ' || n;

  raise notice 'D11: the configured fee is the only fee that counts';

  -- ==========================================================================
  -- 10. Branch scope: a branch value overrides the organization default
  -- ==========================================================================
  perform auth.login_as(u_owner);
  -- The second branch charges more and does not deliver.
  insert into public.settings (organization_id, branch_id, key, value) values
    (org, branch2, 'restaurant.delivery_enabled', 'false'::jsonb);
  update public.settings set value = '5000'::jsonb
   where organization_id = org and branch_id = branch2
     and key = 'restaurant.delivery_fee_cents';
  perform auth.logout();

  -- Main branch is unchanged.
  select delivery_fee_cents into n
    from public.restaurant_price_online_cart('d11diner', 'main', items, 'delivery');
  assert n = 2750, 'FAIL: a branch override leaked to another branch: ' || n;

  -- The second branch refuses delivery even though the organization allows it.
  ok := false;
  begin
    perform public.restaurant_price_online_cart('d11diner', 'second', items, 'delivery');
  exception when others then ok := true;
  end;
  assert ok, 'FAIL: a branch-level delivery switch was ignored';

  -- Pickup there still works, at that branch's own settings.
  select total_cents into n
    from public.restaurant_price_online_cart('d11diner', 'second', items, 'pickup');
  assert n = price, 'FAIL: the second branch mispriced pickup: ' || n;

  raise notice 'D11: a branch setting overrides the organization default';

  -- ==========================================================================
  -- 11. The storefront advertises exactly what the checkout will accept
  -- ==========================================================================
  select * into r from public.restaurant_online_storefront('d11diner', 'main');
  assert r.pickup_enabled, 'FAIL: storefront hides pickup while it is enabled';
  assert r.delivery_enabled, 'FAIL: storefront hides delivery while it is enabled';
  assert r.delivery_fee_cents = 2750, 'FAIL: storefront fee is ' || r.delivery_fee_cents;

  select * into r from public.restaurant_online_storefront('d11diner', 'second');
  assert not r.delivery_enabled, 'FAIL: storefront offers delivery at a branch that refuses it';

  raise notice 'D11: the storefront advertises only what checkout accepts';

  -- ==========================================================================
  -- 12. Settings changes are audited
  -- ==========================================================================
  perform auth.as_admin();
  select count(*) into n from public.audit_logs
   where organization_id = org and action = 'restaurant.setting_changed';
  assert n >= 8, 'FAIL: settings changes not audited, got ' || n;

  -- The trail records both sides of a change.
  select count(*) into n from public.audit_logs
   where organization_id = org and action = 'restaurant.setting_changed'
     and entity_id = 'restaurant.delivery_fee_cents'
     and before is not null and after is not null;
  assert n >= 1, 'FAIL: a fee change did not record its previous value';

  -- And which scope it applied to.
  select count(*) into n from public.audit_logs
   where organization_id = org and action = 'restaurant.setting_changed'
     and after ->> 'scope' = 'branch';
  assert n >= 1, 'FAIL: a branch-scoped change was not recorded as such';

  raise notice 'ONLINE ORDERING SETTINGS (D1.1): all assertions passed';
end $$;
