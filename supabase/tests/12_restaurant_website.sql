-- =============================================================================
-- LOCAL BASIC — Public restaurant website (D2) test suite
--
-- The website is anonymous and tenant-facing, so the claims to prove are:
--   1. It shows only what a restaurant chose to publish, and only its own data.
--   2. An unpublished or inactive restaurant does not exist publicly.
--   3. It advertises exactly the ordering options D1.1 would actually accept.
--   4. Nothing about it weakens the D1 ordering guarantees.
--
-- Run with:  psql -v ON_ERROR_STOP=1 -f supabase/tests/12_restaurant_website.sql
-- =============================================================================

\set ON_ERROR_STOP on

do $$
declare
  u_a     uuid;  u_b uuid;
  org_a   uuid;  branch_a uuid;  branch_a2 uuid;
  org_b   uuid;  branch_b uuid;
  cat_a   uuid;  prod_a uuid;  var_a uuid;  var_hidden uuid;
  prod_b  uuid;  var_b uuid;
  price   bigint := 6000;
  n       int;
  ok      boolean;
  msg     text;
  r       record;
begin
  -- ==========================================================================
  -- Fixture: two restaurants, each with a menu.
  -- ==========================================================================
  insert into auth.users (email) values ('d2a@test.local') returning id into u_a;
  insert into auth.users (email) values ('d2b@test.local') returning id into u_b;

  perform auth.login_as(u_a);
  select out_organization_id, out_branch_id into org_a, branch_a
    from public.provision_workspace('D2 Alpha', 'd2alpha', 'restaurant');
  perform auth.login_as(u_b);
  select out_organization_id, out_branch_id into org_b, branch_b
    from public.provision_workspace('D2 Beta', 'd2beta', 'restaurant');
  perform auth.as_admin();

  insert into public.branches (organization_id, slug, name, address, phone)
  values (org_a, 'downtown', 'فرع وسط البلد', 'شارع 26 يوليو', '0221111111')
  returning id into branch_a2;

  insert into public.restaurant_categories (organization_id, name, sort_order)
  values (org_a, 'المشويات', 1) returning id into cat_a;
  insert into public.restaurant_products (organization_id, category_id, name, description)
  values (org_a, cat_a, 'ريش ضاني', 'مشوية على الفحم') returning id into prod_a;
  insert into public.restaurant_variants (organization_id, product_id, name, price_cents)
  values (org_a, prod_a, 'default', price) returning id into var_a;
  insert into public.restaurant_variants (organization_id, product_id, name, price_cents)
  values (org_a, prod_a, 'نصف كيلو', 12000) returning id into var_hidden;

  insert into public.restaurant_products (organization_id, name) values (org_b, 'سر تجاري')
    returning id into prod_b;
  insert into public.restaurant_variants (organization_id, product_id, name, price_cents)
  values (org_b, prod_b, 'default', 4321) returning id into var_b;

  insert into public.branding_settings (organization_id, display_name, phone, whatsapp)
  values (org_a, 'مطعم ألفا', '0100000001', '0100000002')
  on conflict (organization_id) do update
    set display_name = excluded.display_name, phone = excluded.phone,
        whatsapp = excluded.whatsapp;

  -- ==========================================================================
  -- 1. An unpublished restaurant does not exist publicly
  -- ==========================================================================
  perform auth.logout();

  ok := false;
  begin perform public.restaurant_website('d2alpha'); exception when others then ok := true; end;
  assert ok, 'FAIL: a restaurant with no website setting was published';

  ok := false;
  begin perform public.restaurant_website_branches('d2alpha'); exception when others then ok := true; end;
  assert ok, 'FAIL: branches were exposed for an unpublished restaurant';

  ok := false;
  begin perform public.restaurant_website_menu('d2alpha', 'main'); exception when others then ok := true; end;
  assert ok, 'FAIL: the menu was exposed for an unpublished restaurant';

  raise notice 'D2: an unpublished restaurant is invisible from every entry point';

  -- ==========================================================================
  -- 2. Publishing makes it readable anonymously
  -- ==========================================================================
  perform auth.login_as(u_a);
  insert into public.settings (organization_id, branch_id, key, value) values
    (org_a, null, 'restaurant.website_enabled', 'true'::jsonb),
    (org_a, null, 'restaurant.website_tagline', '"أفضل مشويات في المدينة"'::jsonb),
    (org_a, null, 'restaurant.website_about',   '"نقدّم المشويات منذ 1995."'::jsonb);
  perform auth.logout();

  select * into r from public.restaurant_website('d2alpha');
  assert r.organization_name = 'مطعم ألفا', 'FAIL: display name is ' || r.organization_name;
  assert r.tagline = 'أفضل مشويات في المدينة', 'FAIL: tagline not published';
  assert r.about like 'نقدّم%', 'FAIL: about not published';
  assert r.phone = '0100000001', 'FAIL: public phone missing';
  assert r.currency = 'EGP', 'FAIL: currency is ' || r.currency;

  raise notice 'D2: a published restaurant reads anonymously';

  -- ==========================================================================
  -- 3. One restaurant never sees another's data
  -- ==========================================================================
  -- Beta is not published at all.
  ok := false;
  begin perform public.restaurant_website('d2beta'); exception when others then ok := true; end;
  assert ok, 'FAIL: an unpublished second restaurant was readable';

  -- Alpha's menu contains none of Beta's products, by name or by count.
  select count(*) into n from public.restaurant_website_menu('d2alpha', 'main');
  assert n = 2, 'FAIL: alpha menu should have 2 variants, got ' || n;

  select count(*) into n from public.restaurant_website_menu('d2alpha', 'main')
   where product_name = 'سر تجاري';
  assert n = 0, 'FAIL: another restaurant''s product appeared on this menu';

  -- Alpha's slug paired with Beta's branch resolves to nothing.
  ok := false;
  begin perform public.restaurant_website_menu('d2alpha', 'main2'); exception when others then ok := true; end;
  assert ok, 'FAIL: a foreign branch slug resolved against this restaurant';

  -- And anon still holds no direct table access at all.
  ok := false;
  begin perform 1 from public.restaurant_products limit 1; exception when others then ok := true; end;
  assert ok, 'FAIL: anon can read restaurant_products directly';
  ok := false;
  begin perform 1 from public.settings limit 1; exception when others then ok := true; end;
  assert ok, 'FAIL: anon can read settings directly';
  ok := false;
  begin perform 1 from public.branding_settings limit 1; exception when others then ok := true; end;
  assert ok, 'FAIL: anon can read branding_settings directly';

  raise notice 'D2: tenant isolation holds across every public function';

  -- ==========================================================================
  -- 4. Invalid input is refused safely
  -- ==========================================================================
  for msg in select unnest(array['', '   ', 'nope', 'd2alpha''; drop table public.settings; --',
                                 repeat('x', 300)]) loop
    ok := false;
    begin perform public.restaurant_website(msg); exception when others then ok := true; end;
    assert ok, 'FAIL: a bad slug (' || left(msg, 24) || ') resolved';
  end loop;

  -- The injection attempt above changed nothing.
  perform auth.as_admin();
  select count(*) into n from public.settings where organization_id = org_a;
  assert n > 0, 'FAIL: settings were damaged by a crafted slug';
  perform auth.logout();

  raise notice 'D2: malformed and hostile slugs are refused without side effects';

  -- ==========================================================================
  -- 5. The menu belongs to the branch, and honours availability
  -- ==========================================================================
  perform auth.as_admin();
  insert into public.restaurant_branch_availability
    (organization_id, branch_id, variant_id, is_available)
  values (org_a, branch_a, var_hidden, false);
  perform auth.logout();

  select count(*) into n from public.restaurant_website_menu('d2alpha', 'main');
  assert n = 1, 'FAIL: an item 86''d at this branch still appears, got ' || n;

  -- The other branch still sells it.
  select count(*) into n from public.restaurant_website_menu('d2alpha', 'downtown');
  assert n = 2, 'FAIL: a branch-level block leaked to another branch, got ' || n;

  raise notice 'D2: menus are per branch and respect availability';

  -- ==========================================================================
  -- 6. Ordering availability is advertised exactly as D1.1 would enforce it
  -- ==========================================================================
  -- Nothing configured yet: online ordering defaults off.
  select count(*) into n from public.restaurant_website_branches('d2alpha')
   where ordering_enabled;
  assert n = 0, 'FAIL: branches advertise ordering that is switched off';

  perform auth.login_as(u_a);
  insert into public.settings (organization_id, branch_id, key, value) values
    (org_a, null, 'restaurant.online_ordering_enabled', 'true'::jsonb),
    (org_a, null, 'restaurant.delivery_fee_cents', '3000'::jsonb);
  perform auth.logout();

  select count(*) into n from public.restaurant_website_branches('d2alpha')
   where ordering_enabled;
  assert n = 2, 'FAIL: both branches should now advertise ordering, got ' || n;

  select * into r from public.restaurant_website_branches('d2alpha')
   where branch_slug = 'main';
  assert r.pickup_enabled, 'FAIL: pickup should default on';
  assert r.delivery_enabled, 'FAIL: delivery should default on';
  assert r.delivery_fee_cents = 3000, 'FAIL: advertised fee is ' || r.delivery_fee_cents;

  -- Switch delivery off for one branch only.
  perform auth.login_as(u_a);
  insert into public.settings (organization_id, branch_id, key, value)
  values (org_a, branch_a2, 'restaurant.delivery_enabled', 'false'::jsonb);
  perform auth.logout();

  select * into r from public.restaurant_website_branches('d2alpha')
   where branch_slug = 'downtown';
  assert not r.delivery_enabled, 'FAIL: a branch-level delivery switch is not advertised';

  select * into r from public.restaurant_website_branches('d2alpha') where branch_slug = 'main';
  assert r.delivery_enabled, 'FAIL: a branch override leaked to the other branch';

  -- What the page advertises and what checkout accepts must agree.
  ok := false;
  begin
    perform public.restaurant_place_online_order(
      'd2alpha', 'downtown',
      jsonb_build_array(jsonb_build_object('variant_id', var_a, 'quantity', 1)),
      'delivery', 'عميل', '01000000001', 'd2-deliv-blocked-0001',
      jsonb_build_object('address', 'شارع'));
  exception when others then ok := true;
  end;
  assert ok, 'FAIL: checkout accepted a fulfilment the website says is unavailable';

  raise notice 'D2: the website advertises exactly what checkout will accept';

  -- ==========================================================================
  -- 7. The menu stays visible when ordering is switched off
  -- ==========================================================================
  perform auth.login_as(u_a);
  update public.settings set value = 'false'::jsonb
   where organization_id = org_a and branch_id is null
     and key = 'restaurant.online_ordering_enabled';
  perform auth.logout();

  select count(*) into n from public.restaurant_website_menu('d2alpha', 'main');
  assert n = 1, 'FAIL: the menu disappeared when ordering was switched off';

  select count(*) into n from public.restaurant_website_branches('d2alpha')
   where ordering_enabled;
  assert n = 0, 'FAIL: ordering is still advertised after being switched off';

  -- And the checkout itself refuses, which is the real boundary.
  ok := false;
  begin
    perform public.restaurant_place_online_order(
      'd2alpha', 'main',
      jsonb_build_array(jsonb_build_object('variant_id', var_a, 'quantity', 1)),
      'pickup', 'عميل', '01000000002', 'd2-off-0001');
  exception when others then ok := true;
  end;
  assert ok, 'FAIL: checkout worked while online ordering was disabled';

  raise notice 'D2: menu stays public while ordering is off; checkout still refuses';

  -- ==========================================================================
  -- 8. Website settings are validated
  -- ==========================================================================
  perform auth.login_as(u_a);

  for msg in select unnest(array['"yes"', '3', '[]']) loop
    ok := false;
    begin
      insert into public.settings (organization_id, branch_id, key, value)
      values (org_a, branch_a2, 'restaurant.website_enabled', msg::jsonb);
    exception when others then ok := true;
    end;
    assert ok, 'FAIL: a non-boolean website_enabled (' || msg || ') was stored';
  end loop;

  -- A hero image must be https. javascript: and data: are refused outright.
  for msg in select unnest(array['"javascript:alert(1)"', '"data:text/html,<script>"',
                                 '"http://insecure.example/x.png"', '"/relative.png"']) loop
    ok := false;
    begin
      insert into public.settings (organization_id, branch_id, key, value)
      values (org_a, branch_a2, 'restaurant.website_hero_url', msg::jsonb);
    exception when others then ok := true;
    end;
    assert ok, 'FAIL: an unsafe hero URL (' || msg || ') was stored';
  end loop;

  insert into public.settings (organization_id, branch_id, key, value)
  values (org_a, null, 'restaurant.website_hero_url', '"https://cdn.example/hero.jpg"'::jsonb);

  -- Opening hours must be seven well-formed days.
  for msg in select unnest(array['{}', '[]', '[{"closed":false}]']) loop
    ok := false;
    begin
      insert into public.settings (organization_id, branch_id, key, value)
      values (org_a, branch_a2, 'restaurant.opening_hours', msg::jsonb);
    exception when others then ok := true;
    end;
    assert ok, 'FAIL: malformed opening hours (' || msg || ') were stored';
  end loop;

  ok := false;
  begin
    insert into public.settings (organization_id, branch_id, key, value)
    values (org_a, branch_a2, 'restaurant.opening_hours',
      '[{"closed":false,"opens":"25:00","closes":"23:00"},{"closed":true},{"closed":true},
        {"closed":true},{"closed":true},{"closed":true},{"closed":true}]'::jsonb);
  exception when others then ok := true;
  end;
  assert ok, 'FAIL: an impossible opening time was stored';

  insert into public.settings (organization_id, branch_id, key, value)
  values (org_a, null, 'restaurant.opening_hours',
    '[{"closed":false,"opens":"12:00","closes":"23:59"},
      {"closed":false,"opens":"12:00","closes":"23:59"},
      {"closed":false,"opens":"12:00","closes":"23:59"},
      {"closed":false,"opens":"12:00","closes":"23:59"},
      {"closed":false,"opens":"12:00","closes":"23:59"},
      {"closed":false,"opens":"12:00","closes":"23:59"},
      {"closed":true}]'::jsonb);

  perform auth.logout();
  select * into r from public.restaurant_website('d2alpha');
  assert r.hero_url = 'https://cdn.example/hero.jpg', 'FAIL: hero not published';
  assert jsonb_array_length(r.opening_hours) = 7, 'FAIL: opening hours not published';

  raise notice 'D2: website settings are shape-checked, and hero URLs must be https';

  -- ==========================================================================
  -- 9. Only settings.manage may publish a website
  -- ==========================================================================
  perform auth.login_as(u_b);
  begin
    insert into public.settings (organization_id, branch_id, key, value)
    values (org_a, null, 'restaurant.website_tagline', '"اختراق"'::jsonb);
  exception when others then null;
  end;
  perform auth.as_admin();
  select s.value #>> '{}' into msg from public.settings s
   where s.organization_id = org_a and s.branch_id is null
     and s.key = 'restaurant.website_tagline';
  assert msg = 'أفضل مشويات في المدينة', 'FAIL: another tenant rewrote the tagline';

  raise notice 'D2: only the restaurant''s own authorized staff may publish it';

  -- ==========================================================================
  -- 10. D1 pricing is untouched by anything here
  -- ==========================================================================
  perform auth.login_as(u_a);
  update public.settings set value = 'true'::jsonb
   where organization_id = org_a and branch_id is null
     and key = 'restaurant.online_ordering_enabled';
  perform auth.logout();

  -- A client-sent price is still ignored, ordering from the website's branch.
  select out_total_cents into n
    from public.restaurant_place_online_order(
      'd2alpha', 'main',
      jsonb_build_array(jsonb_build_object(
        'variant_id', var_a, 'quantity', 2,
        'price_cents', 1, 'line_total_cents', 1)),
      'pickup', 'عميل الموقع', '01000000003', 'd2-price-0001');
  assert n = price * 2, 'FAIL: a client price altered the total: ' || n;

  -- An item hidden from this branch's website cannot be ordered from it either.
  ok := false;
  begin
    perform public.restaurant_place_online_order(
      'd2alpha', 'main',
      jsonb_build_array(jsonb_build_object('variant_id', var_hidden, 'quantity', 1)),
      'pickup', 'عميل', '01000000004', 'd2-hidden-0001');
  exception when others then ok := true;
  end;
  assert ok, 'FAIL: an item hidden from the branch menu was ordered from it';

  raise notice 'RESTAURANT WEBSITE (D2): all assertions passed';
end $$;
