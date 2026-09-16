-- =============================================================================
-- LOCAL BASIC — Customer accounts (D3) test suite
--
-- D3 introduces the first authenticated identity that is NOT a member of any
-- organization. The claims to prove are therefore:
--
--   1. A customer reaches their own data and nobody else's — not another
--      customer's, and not another restaurant's.
--   2. Forging an id in a request (customer, user, organization, order,
--      address, product) changes nothing, because none of them is trusted.
--   3. An authenticated customer gains no staff or platform capability.
--   4. Anonymous callers cannot reach the account surface at all.
--   5. A guest order cannot be claimed by anyone who does not hold its token.
--   6. Guest ordering and server-authoritative pricing are exactly as D1 and
--      D1.1 left them.
--
-- Run with:  psql -v ON_ERROR_STOP=1 -f supabase/tests/13_customer_accounts.sql
-- =============================================================================

\set ON_ERROR_STOP on

do $$
declare
  owner_a   uuid;  owner_b uuid;
  cust_1    uuid;  cust_2  uuid;   -- two customers of restaurant A
  cust_b    uuid;                  -- the same person as cust_1, at restaurant B
  org_a     uuid;  branch_a uuid;
  org_b     uuid;  branch_b uuid;
  cat_a     uuid;  prod_a uuid;  var_a uuid;
  prod_b    uuid;  var_b uuid;
  row_1     uuid;  row_2 uuid;     -- public.customers ids
  addr_1    uuid;  addr_2 uuid;
  token_g   text;  token_1 text;
  num_g     text;  num_1 text;  num_2 text;
  n         int;
  ok        boolean;
  msg       text;
  total     bigint;
  r         record;
begin
  -- ==========================================================================
  -- Fixture: two restaurants, both published, both taking online orders.
  -- ==========================================================================
  insert into auth.users (email) values ('d3owner-a@test.local') returning id into owner_a;
  insert into auth.users (email) values ('d3owner-b@test.local') returning id into owner_b;
  insert into auth.users (email) values ('d3cust1@test.local')   returning id into cust_1;
  insert into auth.users (email) values ('d3cust2@test.local')   returning id into cust_2;

  perform auth.login_as(owner_a);
  select out_organization_id, out_branch_id into org_a, branch_a
    from public.provision_workspace('D3 Alpha', 'd3alpha', 'restaurant');
  perform auth.login_as(owner_b);
  select out_organization_id, out_branch_id into org_b, branch_b
    from public.provision_workspace('D3 Beta', 'd3beta', 'restaurant');
  perform auth.as_admin();

  insert into public.restaurant_categories (organization_id, name) values (org_a, 'الأطباق')
    returning id into cat_a;
  insert into public.restaurant_products (organization_id, category_id, name)
  values (org_a, cat_a, 'كشري') returning id into prod_a;
  insert into public.restaurant_variants (organization_id, product_id, name, price_cents)
  values (org_a, prod_a, 'default', 5000) returning id into var_a;

  insert into public.restaurant_products (organization_id, name) values (org_b, 'ملوخية')
    returning id into prod_b;
  insert into public.restaurant_variants (organization_id, product_id, name, price_cents)
  values (org_b, prod_b, 'default', 7000) returning id into var_b;

  insert into public.settings (organization_id, branch_id, key, value) values
    (org_a, null, 'restaurant.website_enabled', 'true'::jsonb),
    (org_a, null, 'restaurant.online_ordering_enabled', 'true'::jsonb),
    (org_a, null, 'restaurant.delivery_enabled', 'true'::jsonb),
    (org_a, null, 'restaurant.delivery_fee_cents', '1500'::jsonb),
    (org_b, null, 'restaurant.website_enabled', 'true'::jsonb),
    (org_b, null, 'restaurant.online_ordering_enabled', 'true'::jsonb);

  -- ==========================================================================
  -- 1. Anonymous callers cannot reach the account surface
  --
  -- Not "get an empty answer from" — cannot EXECUTE. anon holds no grant on
  -- any of these functions, so the failure is at the privilege layer, before
  -- any logic runs.
  -- ==========================================================================
  perform auth.logout();

  ok := false;
  begin perform public.customer_account_profile('d3alpha');
  exception when insufficient_privilege then ok := true; end;
  assert ok, 'FAIL: anon could execute customer_account_profile';

  ok := false;
  begin perform public.customer_orders('d3alpha');
  exception when insufficient_privilege then ok := true; end;
  assert ok, 'FAIL: anon could execute customer_orders';

  ok := false;
  begin perform public.customer_addresses_list('d3alpha');
  exception when insufficient_privilege then ok := true; end;
  assert ok, 'FAIL: anon could execute customer_addresses_list';

  ok := false;
  begin perform public.customer_favorites('d3alpha');
  exception when insufficient_privilege then ok := true; end;
  assert ok, 'FAIL: anon could execute customer_favorites';

  ok := false;
  begin perform public.customer_claim_order('aaaaaaaaaaaaaaaaaaaaaaaa');
  exception when insufficient_privilege then ok := true; end;
  assert ok, 'FAIL: anon could execute customer_claim_order';

  -- The tables themselves are equally out of reach.
  ok := false;
  begin perform 1 from public.customer_addresses;
  exception when insufficient_privilege then ok := true; end;
  assert ok, 'FAIL: anon holds a privilege on customer_addresses';

  ok := false;
  begin perform 1 from public.restaurant_customer_favorites;
  exception when insufficient_privilege then ok := true; end;
  assert ok, 'FAIL: anon holds a privilege on restaurant_customer_favorites';

  raise notice 'D3: the account surface does not exist for an anonymous caller';

  -- ==========================================================================
  -- 2. Signing up creates an identity, not a membership
  --
  -- The single most important boundary in D3: a customer is authenticated, and
  -- that is all. They are in no organization, hold no role, and have no
  -- permission anywhere.
  -- ==========================================================================
  perform auth.login_as(cust_1);

  select count(*) into n from public.organization_members where user_id = cust_1;
  assert n = 0, 'FAIL: a customer account created an organization membership';

  select count(*) into n from public.user_roles ur
    join public.organization_members m on m.id = ur.member_id
   where m.user_id = cust_1;
  assert n = 0, 'FAIL: a customer account was granted a role';

  assert not app.has_permission(org_a, 'order.read'),
    'FAIL: a customer holds a tenant permission';
  assert not app.has_permission(org_a, 'settings.manage'),
    'FAIL: a customer can manage settings';
  assert not app.is_platform_admin(),
    'FAIL: a customer is a platform admin';

  -- Staff tables stay invisible. A customer selecting from them sees nothing,
  -- which is what RLS with no matching policy means.
  select count(*) into n from public.restaurant_orders;
  assert n = 0, 'FAIL: a customer can read the orders table directly';
  select count(*) into n from public.customers;
  assert n = 0, 'FAIL: a customer can read the customers table directly';
  select count(*) into n from public.audit_logs;
  assert n = 0, 'FAIL: a customer can read audit logs';
  select count(*) into n from public.settings;
  assert n = 0, 'FAIL: a customer can read tenant settings';

  raise notice 'D3: an authenticated customer is not a member, not staff, not an admin';

  -- ==========================================================================
  -- 3. The customer row is created on first use, scoped to one restaurant
  -- ==========================================================================
  perform public.customer_account_save_profile('d3alpha', 'ندى حسن', '01111111111');

  perform auth.as_admin();
  select id into row_1 from public.customers
   where organization_id = org_a and user_id = cust_1;
  assert row_1 is not null, 'FAIL: no customer row was created';

  select count(*) into n from public.customers where user_id = cust_1;
  assert n = 1, 'FAIL: saving a profile at one restaurant created rows at others';
  perform auth.login_as(cust_1);

  select p.full_name, p.phone into r from public.customer_account_profile('d3alpha') p;
  assert r.full_name = 'ندى حسن', 'FAIL: the profile did not save';
  assert r.phone = '01111111111', 'FAIL: the phone did not save';

  -- The email is Auth's, surfaced read-only. There is no function that writes
  -- it, so a customer cannot make the restaurant's record disagree with the
  -- identity they sign in with.
  select p.email into msg from public.customer_account_profile('d3alpha') p;
  assert msg = 'd3cust1@test.local', 'FAIL: the profile did not report the auth email';

  raise notice 'D3: the customer row is per-restaurant and created on first use';

  -- ==========================================================================
  -- 4. Addresses: mine, and only through my own customer row
  -- ==========================================================================
  select public.customer_address_save(
    'd3alpha', 'البيت', 'شارع الهرم ١٢', null, 'ندى', '01111111111',
    'الجيزة', 'الهرم', 'بجوار الصيدلية', true) into addr_1;
  assert addr_1 is not null, 'FAIL: the address did not save';

  select count(*) into n from public.customer_addresses_list('d3alpha');
  assert n = 1, 'FAIL: the saved address is not listed';

  -- The same person at a DIFFERENT restaurant: a separate customer row, and
  -- therefore an empty address book. This is the scope decision, asserted.
  select count(*) into n from public.customer_addresses_list('d3beta');
  assert n = 0, 'FAIL: an address saved at one restaurant leaked to another';

  -- Customer 2 saves their own.
  perform auth.login_as(cust_2);
  perform public.customer_account_save_profile('d3alpha', 'مي سعيد', '01222222222');
  select public.customer_address_save('d3alpha', 'الشغل', 'شارع التحرير ٧') into addr_2;

  perform auth.as_admin();
  select id into row_2 from public.customers where organization_id = org_a and user_id = cust_2;

  -- ==========================================================================
  -- 5. ATTACK: customer 2 goes after customer 1's data
  -- ==========================================================================
  perform auth.login_as(cust_2);

  -- Their own list holds one address, and it is theirs.
  select count(*) into n from public.customer_addresses_list('d3alpha');
  assert n = 1, 'FAIL: customer 2 sees the wrong number of addresses';
  select count(*) into n from public.customer_addresses_list('d3alpha') a where a.id = addr_1;
  assert n = 0, 'FAIL: customer 2 can read customer 1''s address';

  -- Forging the address id in an UPDATE. The id is a filter against their own
  -- customer row, so it matches nothing and the statement is refused.
  ok := false;
  begin
    perform public.customer_address_save(
      'd3alpha', 'مسروق', 'عنوان مزيف', addr_1);
  exception when others then ok := true; end;
  assert ok, 'FAIL: customer 2 edited customer 1''s address';

  perform auth.as_admin();
  select label into msg from public.customer_addresses where id = addr_1;
  assert msg = 'البيت', 'FAIL: customer 1''s address was modified';
  perform auth.login_as(cust_2);

  -- Forging it in a DELETE. A silent no-op, not an error to probe with.
  perform public.customer_address_delete('d3alpha', addr_1);
  perform auth.as_admin();
  select count(*) into n from public.customer_addresses where id = addr_1;
  assert n = 1, 'FAIL: customer 2 deleted customer 1''s address';
  perform auth.login_as(cust_2);

  -- Straight at the table, past every function. RLS answers.
  select count(*) into n from public.customer_addresses where id = addr_1;
  assert n = 0, 'FAIL: RLS let customer 2 read customer 1''s address row';

  ok := false;
  begin
    update public.customer_addresses set address = 'مخترق' where id = addr_1;
    get diagnostics n = row_count;
    ok := n = 0;
  exception when others then ok := true; end;
  assert ok, 'FAIL: RLS let customer 2 update customer 1''s address row';

  ok := false;
  begin
    delete from public.customer_addresses where id = addr_1;
    get diagnostics n = row_count;
    ok := n = 0;
  exception when others then ok := true; end;
  assert ok, 'FAIL: RLS let customer 2 delete customer 1''s address row';

  -- Forging a customer_id on INSERT: claiming to be customer 1's row.
  ok := false;
  begin
    insert into public.customer_addresses (organization_id, customer_id, label, address)
    values (org_a, row_1, 'مزروع', 'عنوان مزروع');
  exception when others then ok := true; end;
  assert ok, 'FAIL: customer 2 inserted an address under customer 1''s row';

  raise notice 'D3: addresses are unreachable across customers, by function and by table';

  -- ==========================================================================
  -- 6. Favourites: tenant-fenced by a foreign key, not by a check
  -- ==========================================================================
  perform public.customer_favorite_add('d3alpha', prod_a);
  select count(*) into n from public.customer_favorites('d3alpha');
  assert n = 1, 'FAIL: the favourite was not saved';

  -- ATTACK: a product id belonging to restaurant B, sent to restaurant A.
  ok := false;
  begin perform public.customer_favorite_add('d3alpha', prod_b);
  exception when others then ok := true; end;
  assert ok, 'FAIL: a product from another restaurant was favourited';

  -- And the same id sent to restaurant B, where the customer has no row yet:
  -- allowed, but it lands in a DIFFERENT customer row and never appears at A.
  perform public.customer_favorite_add('d3beta', prod_b);
  select count(*) into n from public.customer_favorites('d3alpha');
  assert n = 1, 'FAIL: a favourite from restaurant B appeared at restaurant A';
  select count(*) into n from public.customer_favorites('d3beta');
  assert n = 1, 'FAIL: the favourite at restaurant B was not saved';

  -- The composite foreign key refuses the mismatch even with the function
  -- bypassed entirely.
  perform auth.as_admin();
  select id into cust_b from public.customers where organization_id = org_b and user_id = cust_2;
  ok := false;
  begin
    insert into public.restaurant_customer_favorites (organization_id, customer_id, product_id)
    values (org_a, row_2, prod_b);
  exception when foreign_key_violation then ok := true; end;
  assert ok, 'FAIL: the database accepted a favourite pointing at another restaurant''s product';
  perform auth.login_as(cust_2);

  -- A withdrawn product disappears from the list rather than being exposed.
  perform auth.as_admin();
  update public.restaurant_products set is_active = false where id = prod_a;
  perform auth.login_as(cust_2);
  select count(*) into n from public.customer_favorites('d3alpha');
  assert n = 0, 'FAIL: a deactivated product is still shown in favourites';
  perform auth.as_admin();
  update public.restaurant_products set is_active = true where id = prod_a;
  perform auth.login_as(cust_2);

  -- Customer 1 does not see customer 2's favourites.
  perform auth.login_as(cust_1);
  select count(*) into n from public.customer_favorites('d3alpha');
  assert n = 0, 'FAIL: customer 1 sees customer 2''s favourites';

  raise notice 'D3: favourites are fenced to one customer and one restaurant';

  -- ==========================================================================
  -- 7. Guest ordering still works, untouched
  -- ==========================================================================
  perform auth.logout();

  select out_token, out_number, out_total_cents into token_g, num_g, total
    from public.restaurant_place_online_order(
      'd3alpha', 'main',
      jsonb_build_array(jsonb_build_object('variant_id', var_a, 'quantity', 2)),
      'pickup', 'زائر', '01000000000', 'd3-guest-key-0001');
  assert num_g is not null, 'FAIL: guest checkout stopped working';
  assert total = 10000, 'FAIL: guest pricing changed';

  perform auth.as_admin();
  -- Qualified by organization: order numbers are unique per branch, not
  -- globally, and other fixtures in this database use the same ones.
  select customer_id into r from public.restaurant_orders
   where organization_id = org_a and number = num_g;
  assert r.customer_id is null, 'FAIL: a guest order was attached to an account';
  perform auth.logout();

  -- Server-authoritative pricing, still. The cart carries no price, and a
  -- fabricated one is ignored rather than honoured.
  select out_total_cents into total
    from public.restaurant_place_online_order(
      'd3alpha', 'main',
      jsonb_build_array(jsonb_build_object(
        'variant_id', var_a, 'quantity', 1,
        'price_cents', 1, 'unit_price_cents', 1, 'line_total_cents', 1)),
      'pickup', 'زائر', '01000000000', 'd3-guest-key-0002');
  assert total = 5000, 'FAIL: the client dictated a price';

  raise notice 'D3: guest ordering and server-side pricing are exactly as D1 left them';

  -- ==========================================================================
  -- 8. An authenticated order is linked to the account
  -- ==========================================================================
  perform auth.login_as(cust_1);

  select out_number into num_1
    from public.restaurant_place_online_order(
      'd3alpha', 'main',
      jsonb_build_array(jsonb_build_object('variant_id', var_a, 'quantity', 1)),
      'pickup', 'ندى حسن', '01111111111', 'd3-acct-key-0001');

  select count(*) into n from public.customer_orders('d3alpha') o where o.number = num_1;
  assert n = 1, 'FAIL: an authenticated order did not appear in the account';

  perform auth.as_admin();
  select customer_id into r from public.restaurant_orders
   where organization_id = org_a and number = num_1;
  assert r.customer_id = row_1, 'FAIL: the order was linked to the wrong customer row';
  perform auth.login_as(cust_1);

  -- The detail view is reachable for their own order, with the items.
  select count(*) into n from public.customer_order_detail('d3alpha', num_1);
  assert n = 1, 'FAIL: the customer cannot read their own order';
  select count(*) into n from public.customer_order_items('d3alpha', num_1);
  assert n = 1, 'FAIL: the customer cannot read their own order items';

  raise notice 'D3: an authenticated order is linked and readable by its owner';

  -- ==========================================================================
  -- 9. ATTACK: reading someone else's order
  -- ==========================================================================
  perform auth.login_as(cust_2);

  select out_number into num_2
    from public.restaurant_place_online_order(
      'd3alpha', 'main',
      jsonb_build_array(jsonb_build_object('variant_id', var_a, 'quantity', 1)),
      'pickup', 'مي سعيد', '01222222222', 'd3-acct-key-0002');

  -- Customer 2 knows customer 1's order number — it is printed on a receipt,
  -- it is not a secret. It buys them nothing.
  select count(*) into n from public.customer_order_detail('d3alpha', num_1);
  assert n = 0, 'FAIL: a customer read another customer''s order by number';
  select count(*) into n from public.customer_order_items('d3alpha', num_1);
  assert n = 0, 'FAIL: a customer read another customer''s order items by number';

  select count(*) into n from public.customer_orders('d3alpha');
  assert n = 1, 'FAIL: the order list is not scoped to one customer';
  select count(*) into n from public.customer_orders('d3alpha') o where o.number = num_1;
  assert n = 0, 'FAIL: another customer''s order appeared in the list';

  -- The guest order, which belongs to nobody, is not theirs either.
  select count(*) into n from public.customer_order_detail('d3alpha', num_g);
  assert n = 0, 'FAIL: a customer read an unclaimed guest order by number';

  -- Cross-restaurant: the same number asked of restaurant B.
  select count(*) into n from public.customer_order_detail('d3beta', num_2);
  assert n = 0, 'FAIL: an order was readable through another restaurant''s slug';
  select count(*) into n from public.customer_orders('d3beta');
  assert n = 0, 'FAIL: restaurant A orders appeared under restaurant B';

  raise notice 'D3: orders are scoped to one customer and one restaurant';

  -- ==========================================================================
  -- 10. ATTACK: forging a saved address at checkout
  --
  -- The delivery address the kitchen receives must be the one the database
  -- held, not the one the form claimed alongside the id.
  -- ==========================================================================
  ok := false;
  begin
    perform public.restaurant_place_online_order(
      'd3alpha', 'main',
      jsonb_build_array(jsonb_build_object('variant_id', var_a, 'quantity', 1)),
      'delivery', 'مي سعيد', '01222222222', 'd3-attack-key-0001',
      null, null, addr_1);
  exception when others then ok := true; end;
  assert ok, 'FAIL: a customer used another customer''s saved address';

  -- Their own, with a lie attached: the posted address block is ignored.
  perform public.restaurant_place_online_order(
    'd3alpha', 'main',
    jsonb_build_array(jsonb_build_object('variant_id', var_a, 'quantity', 1)),
    'delivery', 'مي سعيد', '01222222222', 'd3-saved-key-0001',
    jsonb_build_object('address', 'عنوان مزيف تمامًا', 'city', 'مدينة مزيفة'),
    null, addr_2);

  perform auth.as_admin();
  select d.address into msg
    from public.restaurant_order_deliveries d
    join public.restaurant_orders o on o.id = d.order_id
   where o.idempotency_key = 'd3-saved-key-0001';
  assert msg = 'شارع التحرير ٧',
    'FAIL: the posted address overrode the saved one';
  perform auth.login_as(cust_2);

  -- A guest naming a saved address at all is refused: there is no session to
  -- resolve it under.
  perform auth.logout();
  ok := false;
  begin
    perform public.restaurant_place_online_order(
      'd3alpha', 'main',
      jsonb_build_array(jsonb_build_object('variant_id', var_a, 'quantity', 1)),
      'delivery', 'زائر', '01000000000', 'd3-attack-key-0002',
      null, null, addr_2);
  exception when others then ok := true; end;
  assert ok, 'FAIL: a guest used a saved address';

  raise notice 'D3: a saved address is read from the database, under its owner only';

  -- ==========================================================================
  -- 11. ATTACK: claiming a guest order
  --
  -- The token is the only proof accepted. Not the number, not the phone.
  -- ==========================================================================
  perform auth.login_as(cust_2);

  -- A token that does not exist.
  ok := false;
  begin perform public.customer_claim_order('ZZZZZZZZZZZZZZZZZZZZZZZZ');
  exception when others then ok := true; end;
  assert ok, 'FAIL: an unknown token claimed an order';

  -- The guest order is still unclaimed, and knowing its NUMBER does not help:
  -- there is no function that takes one.
  perform auth.as_admin();
  select customer_id into r from public.restaurant_orders
   where organization_id = org_a and number = num_g;
  assert r.customer_id is null, 'FAIL: the guest order was claimed without its token';
  perform auth.login_as(cust_2);

  -- With the token, it works exactly once.
  select out_number into msg from public.customer_claim_order(token_g);
  assert msg = num_g, 'FAIL: the token did not claim its own order';

  perform auth.as_admin();
  select customer_id into r from public.restaurant_orders
   where organization_id = org_a and number = num_g;
  assert r.customer_id = row_2, 'FAIL: the claimed order went to the wrong customer';

  -- Audited, with the actor recorded.
  select count(*) into n from public.audit_logs
   where action = 'restaurant.online_order.claimed' and actor_id = cust_2;
  assert n = 1, 'FAIL: the claim was not audited';
  perform auth.login_as(cust_2);

  -- Consumed: the same token cannot move it again, to anyone.
  ok := false;
  begin perform public.customer_claim_order(token_g);
  exception when others then ok := true; end;
  assert ok, 'FAIL: a claimed order was claimed a second time';

  perform auth.login_as(cust_1);
  ok := false;
  begin perform public.customer_claim_order(token_g);
  exception when others then ok := true; end;
  assert ok, 'FAIL: another customer re-claimed an already-claimed order';

  -- Expired: a tracking link older than the claim window is not a claim.
  perform auth.logout();
  select out_token into token_1
    from public.restaurant_place_online_order(
      'd3alpha', 'main',
      jsonb_build_array(jsonb_build_object('variant_id', var_a, 'quantity', 1)),
      'pickup', 'زائر قديم', '01000000009', 'd3-old-key-0001');

  perform auth.as_admin();
  update public.restaurant_orders
     set placed_at = now() - interval '2 days'
   where idempotency_key = 'd3-old-key-0001';
  perform auth.login_as(cust_1);

  ok := false;
  begin perform public.customer_claim_order(token_1);
  exception when others then ok := true; end;
  assert ok, 'FAIL: an order outside the claim window was claimed';

  raise notice 'D3: a guest order is claimable only by its token, once, and in time';

  -- ==========================================================================
  -- 12. ATTACK: a hostile organization slug
  --
  -- Every account function takes a slug from the URL. It is a text argument
  -- to a parameterised call, never concatenated into SQL.
  -- ==========================================================================
  select count(*) into n from public.customer_orders(
    'd3alpha''; drop table public.customer_addresses; --');
  assert n = 0, 'FAIL: a hostile slug returned rows';

  perform auth.as_admin();
  assert to_regclass('public.customer_addresses') is not null,
    'FAIL: a hostile slug reached the schema';
  perform auth.login_as(cust_1);

  -- A slug for a restaurant that has not published a website has no account
  -- area, because it has no public presence at all.
  perform auth.as_admin();
  delete from public.settings
   where organization_id = org_b and key = 'restaurant.website_enabled';
  perform auth.login_as(cust_2);

  select count(*) into n from public.customer_favorites('d3beta');
  assert n = 0, 'FAIL: the account surface outlived the published website';
  ok := false;
  begin perform public.customer_favorite_add('d3beta', prod_b);
  exception when others then ok := true; end;
  assert ok, 'FAIL: a favourite was saved at an unpublished restaurant';

  perform auth.as_admin();
  insert into public.settings (organization_id, branch_id, key, value)
  values (org_b, null, 'restaurant.website_enabled', 'true'::jsonb);
  perform auth.login_as(cust_2);

  raise notice 'D3: slugs are data, and the account area follows the published website';

  -- ==========================================================================
  -- 13. The customer-facing projection stops short of the operational record
  -- ==========================================================================
  perform auth.login_as(cust_1);

  -- Assert on the declared OUT columns — what a caller actually receives —
  -- rather than on the page that renders them. A field absent from the
  -- projection cannot be leaked by a careless template later.
  --
  -- RETURNS TABLE columns live in proargnames/proargmodes ('t'), not in a
  -- composite return type: prorettype is plain `record` and has no attributes.
  for r in
    select p.proname, arg.name as attname
      from pg_proc p,
           lateral unnest(p.proargnames, p.proargmodes) as arg(name, mode)
     where p.pronamespace = 'public'::regnamespace
       and p.proname in ('customer_orders', 'customer_order_detail', 'customer_order_items')
       and arg.mode = 't'
  loop
    assert r.attname not in (
      'id', 'order_id', 'organization_id', 'branch_id', 'customer_id',
      'table_id', 'invoice_id', 'variant_id', 'created_by', 'updated_at',
      'idempotency_key', 'cancel_reason', 'customer_edit_until',
      'confirmed_at', 'ready_at', 'served_at', 'completed_at', 'cancelled_at'
    ), format('FAIL: %s exposes the internal column %s', r.proname, r.attname);
  end loop;

  -- The projections are not empty — otherwise the loop above proves nothing.
  select count(*) into n
    from pg_proc p,
         lateral unnest(p.proargnames, p.proargmodes) as arg(name, mode)
   where p.pronamespace = 'public'::regnamespace
     and p.proname = 'customer_order_detail'
     and arg.mode = 't';
  assert n >= 10, 'FAIL: the order detail projection was not inspected';

  -- The one id a customer does receive is a product id, on favourites, and it
  -- is a public menu identifier they need in order to unsave the item.
  select count(*) into n
    from pg_proc p,
         lateral unnest(p.proargnames, p.proargmodes) as arg(name, mode)
   where p.pronamespace = 'public'::regnamespace
     and p.proname = 'customer_favorites'
     and arg.mode = 't'
     and arg.name like '%\_id';
  assert n = 1, 'FAIL: the favourites projection exposes more than the product id';

  raise notice 'D3: the customer projection carries no ids, staff or accounting fields';

  -- ==========================================================================
  -- 14. Settings record a preference and promise nothing
  -- ==========================================================================
  perform public.customer_account_save_settings('d3alpha', true, false);
  select p.marketing_opt_in, p.order_updates_opt_in into r
    from public.customer_account_profile('d3alpha') p;
  assert r.marketing_opt_in, 'FAIL: the marketing preference did not save';
  assert not r.order_updates_opt_in, 'FAIL: the order-updates preference did not save';

  -- The preference lives on the customer row, so it is per-restaurant too.
  select p.marketing_opt_in into ok from public.customer_account_profile('d3beta') p;
  assert not ok, 'FAIL: a preference set at one restaurant applied at another';

  raise notice 'D3: preferences are stored per restaurant and are only preferences';

  -- ==========================================================================
  -- 15. D1.1 still governs: ordering off means off, for accounts too
  -- ==========================================================================
  perform auth.as_admin();
  update public.settings set value = 'false'::jsonb
   where organization_id = org_a and key = 'restaurant.online_ordering_enabled';
  perform auth.login_as(cust_1);

  ok := false;
  begin
    perform public.restaurant_place_online_order(
      'd3alpha', 'main',
      jsonb_build_array(jsonb_build_object('variant_id', var_a, 'quantity', 1)),
      'pickup', 'ندى حسن', '01111111111', 'd3-disabled-key-0001');
  exception when others then ok := true; end;
  assert ok, 'FAIL: an account bypassed disabled online ordering';

  perform auth.as_admin();
  update public.settings set value = 'true'::jsonb
   where organization_id = org_a and key = 'restaurant.online_ordering_enabled';

  raise notice 'D3: an account is not a way around D1.1 settings';

  raise notice 'CUSTOMER ACCOUNTS (D3): all assertions passed';
end $$;
