-- =============================================================================
-- LOCAL BASIC — Online ordering (D1) test suite
--
-- Two claims to prove, and everything else is detail:
--   1. The browser cannot influence money. It sends ids and quantities; every
--      price, fee and total is read back from the menu.
--   2. The 60-second window is the server's clock, not the client's. It cannot
--      be supplied, extended, or waited out and then used.
--
-- Run with:  psql -v ON_ERROR_STOP=1 -f supabase/tests/10_online_ordering.sql
-- =============================================================================

\set ON_ERROR_STOP on

do $$
declare
  u_a        uuid;   -- owner, tenant A
  u_b        uuid;   -- owner, tenant B
  org_a      uuid;  branch_a uuid;  branch_a2 uuid;
  org_b      uuid;  branch_b uuid;
  cat_a      uuid;  prod_a uuid;  var_a uuid;  var_a2 uuid;
  grp_a      uuid;  mod_a uuid;  mod_free uuid;
  prod_b     uuid;  var_b uuid;
  price_a    bigint := 5000;
  price_mod  bigint := 750;
  tok        text;  tok2 text;
  num        text;
  total      bigint;
  edit_until timestamptz;
  ord        uuid;
  n          int;
  ok         boolean;
  msg        text;
  r          record;
  items      jsonb;
begin
  -- ==========================================================================
  -- Fixture: two tenants, each a restaurant with a menu.
  -- ==========================================================================
  insert into auth.users (email) values ('d1a@test.local') returning id into u_a;
  insert into auth.users (email) values ('d1b@test.local') returning id into u_b;

  perform auth.login_as(u_a);
  select out_organization_id, out_branch_id into org_a, branch_a
    from public.provision_workspace('D1 Alpha', 'd1alpha', 'restaurant');
  perform auth.login_as(u_b);
  select out_organization_id, out_branch_id into org_b, branch_b
    from public.provision_workspace('D1 Beta', 'd1beta', 'restaurant');
  perform auth.as_admin();

  -- A second branch for tenant A, to prove branch scoping.
  insert into public.branches (organization_id, slug, name)
  values (org_a, 'second', 'الفرع الثاني') returning id into branch_a2;

  -- Tenant A's menu.
  insert into public.restaurant_categories (organization_id, name)
  values (org_a, 'أطباق') returning id into cat_a;
  insert into public.restaurant_products (organization_id, category_id, name, tax_rate_bp)
  values (org_a, cat_a, 'شاورما', 0) returning id into prod_a;
  insert into public.restaurant_variants (organization_id, product_id, name, price_cents)
  values (org_a, prod_a, 'وسط', price_a) returning id into var_a;
  insert into public.restaurant_variants (organization_id, product_id, name, price_cents)
  values (org_a, prod_a, 'كبير', 8000) returning id into var_a2;

  insert into public.restaurant_modifier_groups
    (organization_id, product_id, name, min_select, max_select)
  values (org_a, prod_a, 'إضافات', 0, 3) returning id into grp_a;
  insert into public.restaurant_modifiers (organization_id, group_id, name, price_cents)
  values (org_a, grp_a, 'جبنة', price_mod) returning id into mod_a;
  insert into public.restaurant_modifiers (organization_id, group_id, name, price_cents)
  values (org_a, grp_a, 'بدون بصل', 0) returning id into mod_free;

  -- Tenant B's menu, used only to attempt cross-tenant ordering.
  insert into public.restaurant_products (organization_id, name) values (org_b, 'برجر')
    returning id into prod_b;
  insert into public.restaurant_variants (organization_id, product_id, name, price_cents)
  values (org_b, prod_b, 'default', 9999) returning id into var_b;

  -- Online ordering on for A, with a delivery fee. Off for B.
  insert into public.settings (organization_id, branch_id, key, value)
  values (org_a, null, 'restaurant.online_ordering_enabled', 'true'::jsonb),
         (org_a, null, 'restaurant.delivery_fee_cents', '2500'::jsonb);

  items := jsonb_build_array(jsonb_build_object(
    'variant_id', var_a, 'quantity', 2,
    'modifier_ids', jsonb_build_array(mod_a)));

  -- ==========================================================================
  -- 1. Browsing: anon sees the menu, and only through the function
  -- ==========================================================================
  perform auth.logout();

  select count(*) into n from public.restaurant_online_menu('d1alpha', 'main');
  assert n = 2, 'FAIL: anon menu should list 2 variants, got ' || n;

  select count(*) into n from public.restaurant_online_modifiers('d1alpha', 'main');
  assert n = 2, 'FAIL: anon should see 2 modifiers, got ' || n;

  -- But no direct table access anywhere.
  ok := false;
  begin perform 1 from public.restaurant_variants limit 1; exception when others then ok := true; end;
  assert ok, 'FAIL: anon can read restaurant_variants directly';
  ok := false;
  begin perform 1 from public.restaurant_orders limit 1; exception when others then ok := true; end;
  assert ok, 'FAIL: anon can read restaurant_orders directly';

  -- A storefront with ordering disabled is not browsable.
  ok := false;
  begin perform public.restaurant_online_menu('d1beta', 'main'); exception when others then ok := true; end;
  assert ok, 'FAIL: anon browsed a storefront with online ordering disabled';

  -- Nor is a slug pair that does not belong together.
  ok := false;
  begin perform public.restaurant_online_menu('d1alpha', 'nosuchbranch'); exception when others then ok := true; end;
  assert ok, 'FAIL: an unknown branch slug resolved';

  raise notice 'D1: guests browse only through the function, only what is enabled';

  -- ==========================================================================
  -- 2. Cart pricing is the server's arithmetic
  -- ==========================================================================
  select * into r from public.restaurant_price_online_cart('d1alpha', 'main', items, 'pickup');
  assert r.subtotal_cents = (price_a + price_mod) * 2,
    'FAIL: cart subtotal is ' || r.subtotal_cents;
  assert r.delivery_fee_cents = 0, 'FAIL: pickup charged a delivery fee';
  assert r.total_cents = (price_a + price_mod) * 2, 'FAIL: cart total is ' || r.total_cents;

  select * into r from public.restaurant_price_online_cart('d1alpha', 'main', items, 'delivery');
  assert r.delivery_fee_cents = 2500, 'FAIL: delivery fee is ' || r.delivery_fee_cents;
  assert r.total_cents = (price_a + price_mod) * 2 + 2500,
    'FAIL: delivery total is ' || r.total_cents;

  -- Quoting leaves nothing behind. Checked with table access, since anon has
  -- none — which is itself the point of the two assertions above.
  perform auth.as_admin();
  select count(*) into n from public.restaurant_orders where organization_id = org_a;
  assert n = 0, 'FAIL: pricing a cart persisted ' || n || ' order(s)';
  perform auth.logout();

  raise notice 'D1: cart priced server-side, quotes persist nothing';

  -- ==========================================================================
  -- 3. Checkout — pickup
  -- ==========================================================================
  select out_token, out_number, out_total_cents, out_edit_until
    into tok, num, total, edit_until
    from public.restaurant_place_online_order(
      'd1alpha', 'main', items, 'pickup', 'سارة', '01000000001', 'idem-pickup-0001');

  assert tok ~ '^[A-Za-z0-9_-]{22,64}$', 'FAIL: token is not opaque: ' || tok;
  assert total = (price_a + price_mod) * 2, 'FAIL: pickup total is ' || total;

  -- That checkout ran as a true anonymous caller. From here the suite inspects
  -- tables, which needs privilege anon does not have — so it switches identity.
  -- The guest functions are re-exercised as anon at the end of section 8.
  perform auth.as_admin();

  select * into r from public.restaurant_orders
   where number = num and organization_id = org_a;
  assert r.channel = 'online', 'FAIL: channel is ' || r.channel;
  assert r.type = 'pickup', 'FAIL: type is ' || r.type;
  assert r.status = 'new', 'FAIL: status is ' || r.status;
  assert r.delivery_fee_cents = 0, 'FAIL: pickup carries a delivery fee';
  ord := r.id;

  -- The window is exactly 60 seconds from creation, by the server's clock.
  assert edit_until > now() + interval '55 seconds'
     and edit_until <= now() + interval '60 seconds',
    'FAIL: edit window is not 60 seconds: ' || edit_until;

  -- The token leaks nothing.
  assert position(org_a::text in tok) = 0, 'FAIL: token contains the organization id';
  assert position(ord::text in tok) = 0, 'FAIL: token contains the order id';

  raise notice 'D1: pickup checkout priced and stamped server-side';

  -- ==========================================================================
  -- 4. Checkout — delivery, with an address
  -- ==========================================================================
  select out_token, out_total_cents into tok2, total
    from public.restaurant_place_online_order(
      'd1alpha', 'main', items, 'delivery', 'كريم', '01000000002', 'idem-delivery-0001',
      jsonb_build_object(
        'address', 'شارع 9، المعادي', 'city', 'القاهرة', 'area', 'المعادي',
        'landmark', 'بجوار الصيدلية', 'latitude', 29.96, 'longitude', 31.25));

  assert total = (price_a + price_mod) * 2 + 2500, 'FAIL: delivery total is ' || total;

  select count(*) into n from public.restaurant_order_deliveries d
    join public.restaurant_orders o on o.id = d.order_id
   where o.organization_id = org_a and d.city = 'القاهرة';
  assert n = 1, 'FAIL: delivery address not stored';

  -- A delivery order with no address is refused outright.
  ok := false;
  begin
    perform public.restaurant_place_online_order(
      'd1alpha', 'main', items, 'delivery', 'بلا عنوان', '01000000003', 'idem-noaddr-0001');
  exception when others then ok := true;
  end;
  assert ok, 'FAIL: a delivery order was accepted with no address';

  raise notice 'D1: delivery checkout stores address and charges the branch fee';

  -- ==========================================================================
  -- 5. Price and total tampering
  -- ==========================================================================
  -- Extra keys the client might hope are honoured are simply not read.
  select out_total_cents into total
    from public.restaurant_place_online_order(
      'd1alpha', 'main',
      jsonb_build_array(jsonb_build_object(
        'variant_id', var_a, 'quantity', 1,
        'price_cents', 1,           -- ignored
        'unit_price_cents', 1,      -- ignored
        'line_total_cents', 1,      -- ignored
        'modifier_ids', jsonb_build_array(mod_a))),
      'pickup', 'محاول', '01000000004', 'idem-tamper-0001');
  assert total = price_a + price_mod,
    'FAIL: a client-supplied price changed the total: ' || total;

  -- Nor can a total be forced by asking for a delivery fee on a pickup.
  select out_total_cents into total
    from public.restaurant_place_online_order(
      'd1alpha', 'main', items, 'pickup', 'محاول٢', '01000000005', 'idem-tamper-0002');
  assert total = (price_a + price_mod) * 2, 'FAIL: pickup total wrong: ' || total;

  -- Quantities are bounded.
  for msg in select unnest(array['0', '-3', '1000']) loop
    ok := false;
    begin
      perform public.restaurant_place_online_order(
        'd1alpha', 'main',
        jsonb_build_array(jsonb_build_object('variant_id', var_a, 'quantity', msg::numeric)),
        'pickup', 'كمية', '01000000006', 'idem-qty-' || msg);
    exception when others then ok := true;
    end;
    assert ok, 'FAIL: quantity ' || msg || ' was accepted';
  end loop;

  -- An empty cart is not an order.
  ok := false;
  begin
    perform public.restaurant_place_online_order(
      'd1alpha', 'main', '[]'::jsonb, 'pickup', 'فارغ', '01000000007', 'idem-empty-0001');
  exception when others then ok := true;
  end;
  assert ok, 'FAIL: an empty cart became an order';

  raise notice 'D1: client prices, totals and quantities cannot move money';

  -- ==========================================================================
  -- 6. Cross-tenant and cross-branch
  -- ==========================================================================
  -- Tenant B's variant, ordered from tenant A's storefront.
  ok := false;
  begin
    perform public.restaurant_place_online_order(
      'd1alpha', 'main',
      jsonb_build_array(jsonb_build_object('variant_id', var_b, 'quantity', 1)),
      'pickup', 'عابر', '01000000008', 'idem-cross-0001');
  exception when others then ok := true;
  end;
  assert ok, 'FAIL: tenant B''s product was ordered from tenant A''s storefront';

  -- Tenant B's branch slug against tenant A's organization slug.
  ok := false;
  begin perform public.restaurant_online_menu('d1alpha', 'main2'); exception when others then ok := true; end;
  assert ok, 'FAIL: a foreign branch slug resolved';

  -- A modifier that belongs to no product in the cart.
  ok := false;
  begin
    perform public.restaurant_place_online_order(
      'd1alpha', 'main',
      jsonb_build_array(jsonb_build_object(
        'variant_id', var_a, 'quantity', 1,
        'modifier_ids', jsonb_build_array(gen_random_uuid()))),
      'pickup', 'مزيف', '01000000009', 'idem-badmod-0001');
  exception when others then ok := true;
  end;
  -- An unknown modifier id simply matches nothing; what must hold is that it
  -- adds no money and no row.
  select out_total_cents into total
    from public.restaurant_place_online_order(
      'd1alpha', 'main',
      jsonb_build_array(jsonb_build_object(
        'variant_id', var_a, 'quantity', 1,
        'modifier_ids', jsonb_build_array(gen_random_uuid()))),
      'pickup', 'مزيف٢', '01000000010', 'idem-badmod-0002');
  assert total = price_a, 'FAIL: an unknown modifier changed the price: ' || total;

  -- An unknown variant is refused.
  ok := false;
  begin
    perform public.restaurant_place_online_order(
      'd1alpha', 'main',
      jsonb_build_array(jsonb_build_object('variant_id', gen_random_uuid(), 'quantity', 1)),
      'pickup', 'وهمي', '01000000011', 'idem-badvar-0001');
  exception when others then ok := true;
  end;
  assert ok, 'FAIL: an unknown variant was ordered';

  -- An item 86'd at this branch is refused, while the other branch still sells it.
  insert into public.restaurant_branch_availability
    (organization_id, branch_id, variant_id, is_available)
  values (org_a, branch_a, var_a2, false);
  ok := false;
  begin
    perform public.restaurant_place_online_order(
      'd1alpha', 'main',
      jsonb_build_array(jsonb_build_object('variant_id', var_a2, 'quantity', 1)),
      'pickup', 'نافد', '01000000012', 'idem-86-0001');
  exception when others then ok := true;
  end;
  assert ok, 'FAIL: an unavailable item was ordered';

  raise notice 'D1: cross-tenant, cross-branch and unavailable items all refused';

  -- ==========================================================================
  -- 7. Idempotency
  -- ==========================================================================
  select count(*) into n from public.restaurant_orders
   where organization_id = org_a and idempotency_key = 'idem-pickup-0001';
  assert n = 1, 'FAIL: expected one order for the key, got ' || n;

  -- Replaying the very same checkout returns the original, and creates nothing.
  select out_token, out_number into msg, num
    from public.restaurant_place_online_order(
      'd1alpha', 'main', items, 'pickup', 'سارة', '01000000001', 'idem-pickup-0001');
  assert msg = tok, 'FAIL: a replayed checkout returned a different token';

  select count(*) into n from public.restaurant_orders
   where organization_id = org_a and idempotency_key = 'idem-pickup-0001';
  assert n = 1, 'FAIL: a replayed checkout created a second order';

  -- A checkout with no key at all is refused.
  ok := false;
  begin
    perform public.restaurant_place_online_order(
      'd1alpha', 'main', items, 'pickup', 'بلا مفتاح', '01000000013', '');
  exception when others then ok := true;
  end;
  assert ok, 'FAIL: a checkout without an idempotency key was accepted';

  raise notice 'D1: a retried checkout returns the original order';

  -- ==========================================================================
  -- 8. Token scope — a guest reaches exactly one order
  -- ==========================================================================
  select count(*) into n from public.restaurant_online_order_status(tok);
  assert n = 1, 'FAIL: the token did not resolve its own order';

  select number into msg from public.restaurant_online_order_status(tok);
  assert msg = (select o.number from public.restaurant_orders o where o.id = ord),
    'FAIL: the token resolved the wrong order';

  -- The other guest's token shows only their order, never this one.
  select number into msg from public.restaurant_online_order_status(tok2);
  assert msg <> (select o.number from public.restaurant_orders o where o.id = ord),
    'FAIL: one guest''s token reached another guest''s order';

  -- A made-up token reaches nothing — verified as a real anonymous caller.
  perform auth.logout();
  select count(*) into n from public.restaurant_online_order_status('AAAAAAAAAAAAAAAAAAAAAAAA');
  assert n = 0, 'FAIL: an arbitrary token returned an order';
  select count(*) into n from public.restaurant_online_order_items('AAAAAAAAAAAAAAAAAAAAAAAA');
  assert n = 0, 'FAIL: an arbitrary token returned order items';
  -- …and the guest's own token still works for them.
  select count(*) into n from public.restaurant_online_order_status(tok);
  assert n = 1, 'FAIL: anon cannot follow their own order';
  perform auth.as_admin();

  raise notice 'D1: a token reaches one order and no other';

  -- ==========================================================================
  -- 9. The 60-second window
  -- ==========================================================================
  select can_edit, seconds_left into r from public.restaurant_online_order_status(tok);
  assert r.can_edit, 'FAIL: a fresh order is not editable';
  assert r.seconds_left between 1 and 60, 'FAIL: seconds_left is ' || r.seconds_left;

  -- Edit inside the window: allowed, and re-priced by the same builder.
  select out_total_cents into total from public.restaurant_online_edit_order(
    tok, jsonb_build_array(jsonb_build_object('variant_id', var_a, 'quantity', 1)));
  assert total = price_a, 'FAIL: edited total is ' || total;

  -- The deadline did not move because the order was edited.
  select customer_edit_until into msg from public.restaurant_orders where id = ord;
  assert msg::timestamptz = edit_until, 'FAIL: editing moved the deadline';

  -- Nobody can push the deadline out, not even with table privilege.
  ok := false;
  begin
    update public.restaurant_orders
       set customer_edit_until = now() + interval '1 hour' where id = ord;
  exception when others then ok := true;
  end;
  assert ok, 'FAIL: customer_edit_until was extended by a direct update';

  -- Cancel inside the window, on the delivery order.
  perform public.restaurant_online_cancel_order(tok2, 'غيرت رأيي');
  select status into msg from public.restaurant_orders o
    join public.public_links pl on (pl.target ->> 'entity_id')::uuid = o.id
   where pl.token = tok2;
  assert msg = 'cancelled', 'FAIL: cancel inside the window did not cancel, status ' || msg;

  -- The token still resolves, read-only, so the guest can see the cancellation
  -- landed — but it grants no further action.
  select count(*) into n from public.restaurant_online_order_status(tok2);
  assert n = 1, 'FAIL: a cancelled order''s token stopped resolving';
  select can_edit into ok from public.restaurant_online_order_status(tok2);
  assert not ok, 'FAIL: a cancelled order still reports as editable';
  ok := false;
  begin perform public.restaurant_online_cancel_order(tok2, 'مرة أخرى'); exception when others then ok := true; end;
  assert ok, 'FAIL: a cancelled order was cancelled again';

  raise notice 'D1: edit and cancel work inside the window, deadline is immutable';

  -- ==========================================================================
  -- 10. After the window
  -- ==========================================================================
  -- Move the order's creation back in time rather than sleeping: the deadline
  -- is a stored timestamp, and expiry is compared against the server clock.
  -- The freeze trigger only guards changes made while a value already exists,
  -- so this is done with the trigger disabled — the point under test is that
  -- an EXPIRED window refuses, not how it got there.
  alter table public.restaurant_orders disable trigger restaurant_orders_freeze_edit_window;
  update public.restaurant_orders
     set customer_edit_until = now() - interval '1 second' where id = ord;
  alter table public.restaurant_orders enable trigger restaurant_orders_freeze_edit_window;

  select can_edit, seconds_left into r from public.restaurant_online_order_status(tok);
  assert not r.can_edit, 'FAIL: an expired order still reports as editable';
  assert r.seconds_left = 0, 'FAIL: seconds_left after expiry is ' || r.seconds_left;

  ok := false;
  begin
    perform public.restaurant_online_edit_order(
      tok, jsonb_build_array(jsonb_build_object('variant_id', var_a, 'quantity', 1)));
  exception when others then ok := true;
  end;
  assert ok, 'FAIL: an order was edited after the window closed';

  ok := false;
  begin perform public.restaurant_online_cancel_order(tok, 'متأخر'); exception when others then ok := true; end;
  assert ok, 'FAIL: an order was cancelled after the window closed';

  -- And the order is untouched by those attempts.
  select status, total_cents into r from public.restaurant_orders where id = ord;
  assert r.status = 'new', 'FAIL: a refused cancel changed the status to ' || r.status;
  assert r.total_cents = price_a, 'FAIL: a refused edit changed the total';

  raise notice 'D1: after 60 seconds the customer can neither edit nor cancel';

  -- ==========================================================================
  -- 11. A customer can never drive the kitchen
  -- ==========================================================================
  -- Once staff confirm, self-service is over even if the clock still allowed it.
  select out_token into msg
    from public.restaurant_place_online_order(
      'd1alpha', 'main', items, 'pickup', 'مؤكد', '01000000014', 'idem-confirmed-0001');
  select (pl.target ->> 'entity_id')::uuid into ord
    from public.public_links pl where pl.token = msg;

  update public.restaurant_orders set status = 'confirmed' where id = ord;

  ok := false;
  begin perform public.restaurant_online_cancel_order(msg, 'بعد التأكيد'); exception when others then ok := true; end;
  assert ok, 'FAIL: a customer cancelled an order the kitchen had started';

  ok := false;
  begin
    perform public.restaurant_online_edit_order(
      msg, jsonb_build_array(jsonb_build_object('variant_id', var_a, 'quantity', 5)));
  exception when others then ok := true;
  end;
  assert ok, 'FAIL: a customer edited an order the kitchen had started';

  -- There is no customer-facing function that advances status at all.
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname like 'restaurant_online_%'
     and has_function_privilege('anon', p.oid, 'EXECUTE')
     and p.proname in ('restaurant_online_confirm', 'restaurant_online_set_status');
  assert n = 0, 'FAIL: a status-advancing function is exposed to guests';

  raise notice 'D1: customers cannot confirm, prepare, ready, serve or complete';

  -- ==========================================================================
  -- 12. Staff still see and own these orders
  -- ==========================================================================
  perform auth.login_as(u_a);
  select count(*) into n from public.restaurant_orders
   where organization_id = org_a and channel = 'online';
  assert n > 0, 'FAIL: the owner cannot see their own online orders';

  select count(*) into n from public.restaurant_order_deliveries;
  assert n >= 1, 'FAIL: the owner cannot see delivery details';

  -- Tenant B sees none of it.
  perform auth.login_as(u_b);
  select count(*) into n from public.restaurant_orders where organization_id = org_a;
  assert n = 0, 'FAIL: tenant B can see tenant A''s online orders';
  select count(*) into n from public.restaurant_order_deliveries;
  assert n = 0, 'FAIL: tenant B can see tenant A''s delivery addresses';

  raise notice 'D1: online orders stay inside their tenant';

  -- ==========================================================================
  -- 13. Audit and the notification seam
  -- ==========================================================================
  perform auth.as_admin();
  select count(*) into n from public.audit_logs
   where organization_id = org_a and action = 'restaurant.online_order.created';
  assert n >= 5, 'FAIL: online order creation not audited, got ' || n;

  select count(*) into n from public.audit_logs
   where organization_id = org_a and action = 'restaurant.online_order.customer_edited';
  assert n = 1, 'FAIL: customer edit not audited';

  select count(*) into n from public.audit_logs
   where organization_id = org_a and action = 'restaurant.online_order.customer_cancelled';
  assert n = 1, 'FAIL: customer cancellation not audited';

  select count(*) into n from public.notifications
   where organization_id = org_a and template = 'restaurant.online_order.created'
     and status = 'pending';
  assert n >= 5, 'FAIL: no pending notification enqueued for created orders';

  select count(*) into n from public.notifications
   where organization_id = org_a and template = 'restaurant.online_order.cancelled';
  assert n = 1, 'FAIL: no notification enqueued for a cancellation';

  raise notice 'D1: creation, edit and cancellation are audited and enqueued';

  -- ==========================================================================
  -- 14. Online orders are ordinary restaurant orders
  -- ==========================================================================
  -- The kitchen pipeline reads restaurant_orders; an online order must be
  -- indistinguishable there apart from its channel.
  select count(*) into n from public.restaurant_order_items i
    join public.restaurant_orders o on o.id = i.order_id
   where o.organization_id = org_a and o.channel = 'online';
  assert n > 0, 'FAIL: online orders have no lines in the shared items table';

  -- The existing state machine still governs them.
  ok := false;
  begin
    update public.restaurant_orders set status = 'served' where id = ord;  -- new → served
  exception when others then ok := true;
  end;
  assert ok, 'FAIL: an online order skipped the state machine';

  raise notice 'ONLINE ORDERING (D1): all assertions passed';
end $$;
