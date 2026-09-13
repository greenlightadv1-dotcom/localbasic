-- =============================================================================
-- LOCAL BASIC — demo data for local development
--
-- A plausible Damascene grill house in Cairo, mid-service: a full menu, a busy
-- floor, orders at every stage, takings in the till and a few expenses paid
-- out. Enough that every screen shows real shapes rather than empty states.
--
-- Applied by scripts/dev-db.sh to the LOCAL database only. Never shipped.
-- =============================================================================

\set ON_ERROR_STOP on

do $$
declare
  u_owner uuid; u_cash uuid; u_kitchen uuid; u_waiter uuid; u_manager uuid;
  org uuid; branch uuid; branch2 uuid;
  sec_hall uuid; sec_terrace uuid; sec_family uuid;
  cat_starters uuid; cat_grills uuid; cat_shawarma uuid; cat_drinks uuid; cat_sweets uuid;
  p_hummus uuid; p_tabbouleh uuid; p_fattoush uuid; p_mutabbal uuid;
  p_mixed uuid; p_kebab uuid; p_shish uuid; p_riyash uuid;
  p_shawarma uuid; p_shawarma_plate uuid;
  p_lemon uuid; p_tea uuid; p_ayran uuid; p_water uuid;
  p_knafeh uuid; p_baklava uuid;
  v uuid; g uuid;
  m_id uuid; r_id uuid;
  tbl uuid; ord uuid;
  acct uuid;
  i int;
begin
  -- ---------------------------------------------------------------------------
  -- People
  -- ---------------------------------------------------------------------------
  insert into auth.users (email, raw_user_meta_data) values
    ('owner@demo.local',   '{"full_name":"أبو محمود الحلبي"}'),
    ('manager@demo.local', '{"full_name":"سامي الخوري"}'),
    ('cashier@demo.local', '{"full_name":"ندى عبد الرحمن"}'),
    ('kitchen@demo.local', '{"full_name":"الشيف عمّار"}'),
    ('waiter@demo.local',  '{"full_name":"كريم السيد"}')
  on conflict (email) do nothing;

  select id into u_owner   from auth.users where email = 'owner@demo.local';
  select id into u_manager from auth.users where email = 'manager@demo.local';
  select id into u_cash    from auth.users where email = 'cashier@demo.local';
  select id into u_kitchen from auth.users where email = 'kitchen@demo.local';
  select id into u_waiter  from auth.users where email = 'waiter@demo.local';

  -- ---------------------------------------------------------------------------
  -- Workspace
  -- ---------------------------------------------------------------------------
  perform auth.login_as(u_owner);
  select out_organization_id, out_branch_id into org, branch
    from public.provision_workspace(
      'مطعم الحارة الشامية', 'alhara', 'restaurant', 'فرع المهندسين');
  perform auth.as_admin();

  perform auth.login_as(u_owner);

  update public.branding_settings
     set phone = '01001234567', whatsapp = '01001234567',
         email = 'hello@alhara.example', display_name = 'مطعم الحارة الشامية'
   where organization_id = org;

  insert into public.branches (organization_id, slug, name, address, phone)
  values (org, 'maadi', 'فرع المعادي', 'شارع ٩، المعادي، القاهرة', '01009876543')
  returning id into branch2;

  -- Staff
  insert into public.organization_members (organization_id, user_id, status, all_branches, joined_at)
  values (org, u_manager, 'active', true, now()) returning id into m_id;
  select id into r_id from public.roles where organization_id = org and key = 'manager';
  insert into public.user_roles (member_id, role_id) values (m_id, r_id);

  insert into public.organization_members (organization_id, user_id, status, all_branches, joined_at)
  values (org, u_cash, 'active', true, now()) returning id into m_id;
  select id into r_id from public.roles where organization_id = org and key = 'cashier';
  insert into public.user_roles (member_id, role_id) values (m_id, r_id);

  insert into public.organization_members (organization_id, user_id, status, all_branches, joined_at)
  values (org, u_kitchen, 'active', true, now()) returning id into m_id;
  select id into r_id from public.roles where organization_id = org and key = 'kitchen';
  insert into public.user_roles (member_id, role_id) values (m_id, r_id);

  insert into public.organization_members (organization_id, user_id, status, all_branches, joined_at)
  values (org, u_waiter, 'active', true, now()) returning id into m_id;
  select id into r_id from public.roles where organization_id = org and key = 'waiter';
  insert into public.user_roles (member_id, role_id) values (m_id, r_id);

  -- ---------------------------------------------------------------------------
  -- Floor: the bootstrap created 6 plain tables; give them areas and more room.
  -- ---------------------------------------------------------------------------
  select id into sec_hall from public.restaurant_sections where branch_id = branch limit 1;
  update public.restaurant_sections set name = 'الصالة الداخلية' where id = sec_hall;

  insert into public.restaurant_sections (organization_id, branch_id, name, sort_order)
  values (org, branch, 'الشرفة', 1) returning id into sec_terrace;
  insert into public.restaurant_sections (organization_id, branch_id, name, sort_order)
  values (org, branch, 'قسم العائلات', 2) returning id into sec_family;

  for i in 7..10 loop
    insert into public.restaurant_tables
      (organization_id, branch_id, section_id, name, seats)
    values (org, branch, sec_terrace, i::text, case when i % 2 = 0 then 6 else 2 end)
    returning id into tbl;

    insert into public.public_links (organization_id, branch_id, kind, token, target, label)
    values (org, branch, 'menu', app.new_public_token(),
            jsonb_build_object('entity_type', 'restaurant_table', 'entity_id', tbl),
            'طاولة ' || i::text)
    returning id into v;
    insert into public.qr_codes (organization_id, branch_id, public_link_id, label, entity_type, entity_id)
    values (org, branch, v, 'طاولة ' || i::text, 'restaurant_table', tbl);
    update public.restaurant_tables set public_link_id = v where id = tbl;
  end loop;

  for i in 11..14 loop
    insert into public.restaurant_tables
      (organization_id, branch_id, section_id, name, seats)
    values (org, branch, sec_family, 'ع' || (i - 10)::text, 8)
    returning id into tbl;

    insert into public.public_links (organization_id, branch_id, kind, token, target, label)
    values (org, branch, 'menu', app.new_public_token(),
            jsonb_build_object('entity_type', 'restaurant_table', 'entity_id', tbl),
            'طاولة ع' || (i - 10)::text)
    returning id into v;
    insert into public.qr_codes (organization_id, branch_id, public_link_id, label, entity_type, entity_id)
    values (org, branch, v, 'طاولة ع' || (i - 10)::text, 'restaurant_table', tbl);
    update public.restaurant_tables set public_link_id = v where id = tbl;
  end loop;

  update public.restaurant_tables set section_id = sec_hall
   where branch_id = branch and section_id is null;

  -- ---------------------------------------------------------------------------
  -- Menu
  -- ---------------------------------------------------------------------------
  insert into public.restaurant_categories (organization_id, name, description, sort_order) values
    (org, 'المقبلات', 'مقبلات شامية تُقدَّم مع الخبز الساخن', 0) returning id into cat_starters;
  insert into public.restaurant_categories (organization_id, name, description, sort_order) values
    (org, 'المشاوي', 'على الفحم، تُقدَّم مع الأرز والسلطة', 1) returning id into cat_grills;
  insert into public.restaurant_categories (organization_id, name, description, sort_order) values
    (org, 'الشاورما', 'شاورما سورية أصلية', 2) returning id into cat_shawarma;
  insert into public.restaurant_categories (organization_id, name, description, sort_order) values
    (org, 'المشروبات', '', 3) returning id into cat_drinks;
  insert into public.restaurant_categories (organization_id, name, description, sort_order) values
    (org, 'الحلويات', 'تُحضَّر يوميًا', 4) returning id into cat_sweets;

  -- Starters ------------------------------------------------------------------
  insert into public.restaurant_products (organization_id, category_id, name, description, tax_rate_bp, prep_minutes, sort_order)
  values (org, cat_starters, 'حمّص بالطحينة', 'حمّص مخلوط بالطحينة وزيت الزيتون', 1400, 5, 0)
  returning id into p_hummus;
  insert into public.restaurant_variants (organization_id, product_id, name, price_cents, sort_order)
  values (org, p_hummus, 'وسط', 6500, 0), (org, p_hummus, 'كبير', 9500, 1);

  insert into public.restaurant_modifier_groups (organization_id, product_id, name, min_select, max_select, sort_order)
  values (org, p_hummus, 'إضافات', 0, 3, 0) returning id into g;
  insert into public.restaurant_modifiers (organization_id, group_id, name, price_cents, sort_order) values
    (org, g, 'لحمة مفرومة', 4500, 0),
    (org, g, 'صنوبر', 2500, 1),
    (org, g, 'زيت زيتون إضافي', 0, 2);

  insert into public.restaurant_products (organization_id, category_id, name, description, tax_rate_bp, prep_minutes, sort_order)
  values (org, cat_starters, 'تبّولة', 'بقدونس وبرغل وطماطم وليمون', 1400, 7, 1)
  returning id into p_tabbouleh;
  insert into public.restaurant_variants (organization_id, product_id, price_cents)
  values (org, p_tabbouleh, 7000);

  insert into public.restaurant_products (organization_id, category_id, name, description, tax_rate_bp, prep_minutes, sort_order)
  values (org, cat_starters, 'فتّوش', 'خضار موسمية مع خبز محمّص ودبس رمان', 1400, 7, 2)
  returning id into p_fattoush;
  insert into public.restaurant_variants (organization_id, product_id, price_cents)
  values (org, p_fattoush, 7500);

  insert into public.restaurant_products (organization_id, category_id, name, description, tax_rate_bp, prep_minutes, sort_order)
  values (org, cat_starters, 'متبّل باذنجان', 'باذنجان مشوي على الفحم مع طحينة', 1400, 6, 3)
  returning id into p_mutabbal;
  insert into public.restaurant_variants (organization_id, product_id, price_cents)
  values (org, p_mutabbal, 7000);

  -- Grills --------------------------------------------------------------------
  insert into public.restaurant_products (organization_id, category_id, name, description, tax_rate_bp, prep_minutes, sort_order)
  values (org, cat_grills, 'مشاوي مشكّلة', 'كباب وشيش طاووق وريش، مع أرز وسلطة', 1400, 25, 0)
  returning id into p_mixed;
  insert into public.restaurant_variants (organization_id, product_id, name, price_cents, sort_order)
  values (org, p_mixed, 'لشخص', 32500, 0), (org, p_mixed, 'لشخصين', 59000, 1);

  insert into public.restaurant_modifier_groups (organization_id, product_id, name, min_select, max_select, sort_order)
  values (org, p_mixed, 'درجة الاستواء', 1, 1, 0) returning id into g;
  insert into public.restaurant_modifiers (organization_id, group_id, name, price_cents, sort_order) values
    (org, g, 'وسط', 0, 0), (org, g, 'مستوي جيدًا', 0, 1);

  insert into public.restaurant_modifier_groups (organization_id, product_id, name, min_select, max_select, sort_order)
  values (org, p_mixed, 'الإضافات الجانبية', 0, 3, 1) returning id into g;
  insert into public.restaurant_modifiers (organization_id, group_id, name, price_cents, sort_order) values
    (org, g, 'أرز إضافي', 3500, 0),
    (org, g, 'بطاطس مقلية', 4000, 1),
    (org, g, 'خبز إضافي', 1000, 2);

  insert into public.restaurant_products (organization_id, category_id, name, description, tax_rate_bp, prep_minutes, sort_order)
  values (org, cat_grills, 'كباب حلبي', 'لحم مفروم مع البقدونس والفلفل', 1400, 20, 1)
  returning id into p_kebab;
  insert into public.restaurant_variants (organization_id, product_id, price_cents)
  values (org, p_kebab, 24500);

  insert into public.restaurant_products (organization_id, category_id, name, description, tax_rate_bp, prep_minutes, sort_order)
  values (org, cat_grills, 'شيش طاووق', 'صدور دجاج متبّلة باللبن والثوم', 1400, 18, 2)
  returning id into p_shish;
  insert into public.restaurant_variants (organization_id, product_id, price_cents)
  values (org, p_shish, 22000);

  insert into public.restaurant_products (organization_id, category_id, name, description, tax_rate_bp, prep_minutes, sort_order)
  values (org, cat_grills, 'ريش غنم', 'ريش بلدي على الفحم', 1400, 25, 3)
  returning id into p_riyash;
  insert into public.restaurant_variants (organization_id, product_id, price_cents)
  values (org, p_riyash, 38000);

  -- Shawarma ------------------------------------------------------------------
  insert into public.restaurant_products (organization_id, category_id, name, description, tax_rate_bp, prep_minutes, sort_order)
  values (org, cat_shawarma, 'ساندويتش شاورما', 'خبز صاج مع ثوم ومخلل', 1400, 8, 0)
  returning id into p_shawarma;
  insert into public.restaurant_variants (organization_id, product_id, name, price_cents, sort_order)
  values (org, p_shawarma, 'دجاج', 9000, 0), (org, p_shawarma, 'لحم', 11000, 1);

  insert into public.restaurant_modifier_groups (organization_id, product_id, name, min_select, max_select, sort_order)
  values (org, p_shawarma, 'تعديلات', 0, 4, 0) returning id into g;
  insert into public.restaurant_modifiers (organization_id, group_id, name, price_cents, sort_order) values
    (org, g, 'بدون ثوم', 0, 0),
    (org, g, 'بدون مخلل', 0, 1),
    (org, g, 'جبنة', 2000, 2),
    (org, g, 'بطاطس داخل الساندويتش', 1500, 3);

  insert into public.restaurant_products (organization_id, category_id, name, description, tax_rate_bp, prep_minutes, sort_order)
  values (org, cat_shawarma, 'صحن شاورما', 'مع أرز وسلطة وطحينة', 1400, 12, 1)
  returning id into p_shawarma_plate;
  insert into public.restaurant_variants (organization_id, product_id, name, price_cents, sort_order)
  values (org, p_shawarma_plate, 'دجاج', 19500, 0), (org, p_shawarma_plate, 'لحم', 23500, 1);

  -- Drinks --------------------------------------------------------------------
  insert into public.restaurant_products (organization_id, category_id, name, description, tax_rate_bp, prep_minutes, sort_order)
  values (org, cat_drinks, 'ليمون بالنعناع', 'طازج', 1400, 4, 0) returning id into p_lemon;
  insert into public.restaurant_variants (organization_id, product_id, price_cents)
  values (org, p_lemon, 5500);

  insert into public.restaurant_products (organization_id, category_id, name, description, tax_rate_bp, prep_minutes, sort_order)
  values (org, cat_drinks, 'شاي', 'شاي أسود أو بالنعناع', 1400, 3, 1) returning id into p_tea;
  insert into public.restaurant_variants (organization_id, product_id, price_cents)
  values (org, p_tea, 2500);

  insert into public.restaurant_products (organization_id, category_id, name, description, tax_rate_bp, prep_minutes, sort_order)
  values (org, cat_drinks, 'عيران', 'لبن مخفوق بالملح', 1400, 2, 2) returning id into p_ayran;
  insert into public.restaurant_variants (organization_id, product_id, price_cents)
  values (org, p_ayran, 3000);

  insert into public.restaurant_products (organization_id, category_id, name, description, tax_rate_bp, prep_minutes, sort_order)
  values (org, cat_drinks, 'مياه معدنية', '', 1400, 1, 3) returning id into p_water;
  insert into public.restaurant_variants (organization_id, product_id, price_cents)
  values (org, p_water, 1500);

  -- Sweets --------------------------------------------------------------------
  insert into public.restaurant_products (organization_id, category_id, name, description, tax_rate_bp, prep_minutes, sort_order)
  values (org, cat_sweets, 'كنافة نابلسية', 'تُحضَّر عند الطلب', 1400, 15, 0) returning id into p_knafeh;
  insert into public.restaurant_variants (organization_id, product_id, name, price_cents, sort_order)
  values (org, p_knafeh, 'قطعة', 8500, 0), (org, p_knafeh, 'صينية صغيرة', 26000, 1);

  insert into public.restaurant_products (organization_id, category_id, name, description, tax_rate_bp, prep_minutes, sort_order)
  values (org, cat_sweets, 'بقلاوة', 'تشكيلة بالفستق والجوز', 1400, 3, 1) returning id into p_baklava;
  insert into public.restaurant_variants (organization_id, product_id, price_cents)
  values (org, p_baklava, 12000);

  -- One item is off tonight, so the "86" state is visible on the screens.
  select id into v from public.restaurant_variants where product_id = p_riyash limit 1;
  insert into public.restaurant_branch_availability
    (organization_id, branch_id, variant_id, is_available, unavailable_note, updated_by)
  values (org, branch, v, false, 'خلصت الكمية', u_owner);

  -- ---------------------------------------------------------------------------
  -- Customers
  -- ---------------------------------------------------------------------------
  insert into public.customers (organization_id, branch_id, name, phone, created_by) values
    (org, branch, 'عائلة الشربيني', '01111111111', u_owner),
    (org, branch, 'أحمد فتحي',      '01222222222', u_owner),
    (org, branch, 'شركة النيل للمقاولات', '01033334444', u_owner),
    (org, branch, 'منى سعيد',       '01555556666', u_owner);

  perform auth.as_admin();
end $$;

-- =============================================================================
-- Mid-service: orders at every stage, money in the till, expenses paid out.
-- Uses the real functions, so the demo data is produced exactly the way the
-- application produces it — nothing is inserted behind the system's back.
-- =============================================================================
do $$
declare
  u_owner uuid; u_cash uuid; u_kitchen uuid; u_waiter uuid;
  org uuid; branch uuid;
  t1 uuid; t2 uuid; t3 uuid; t4 uuid; t5 uuid; t6 uuid; t7 uuid;
  token text;
  v_hummus_l uuid; v_mixed_1 uuid; v_mixed_2 uuid; v_shish uuid; v_kebab uuid;
  v_shawarma_c uuid; v_shawarma_m uuid; v_plate_c uuid;
  v_tea uuid; v_lemon uuid; v_ayran uuid; v_water uuid; v_knafeh uuid; v_fattoush uuid;
  mod_meat uuid; mod_pine uuid; mod_medium uuid; mod_welldone uuid;
  mod_rice uuid; mod_nogarlic uuid; mod_cheese uuid;
  ord uuid; num text; acct uuid; cust uuid;
begin
  select id into u_owner   from auth.users where email = 'owner@demo.local';
  select id into u_cash    from auth.users where email = 'cashier@demo.local';
  select id into u_kitchen from auth.users where email = 'kitchen@demo.local';
  select id into u_waiter  from auth.users where email = 'waiter@demo.local';
  select id into org from public.organizations where slug = 'alhara';
  select id into branch from public.branches where organization_id = org and slug = 'main';

  select id into t1 from public.restaurant_tables where branch_id = branch and name = '1';
  select id into t2 from public.restaurant_tables where branch_id = branch and name = '2';
  select id into t3 from public.restaurant_tables where branch_id = branch and name = '3';
  select id into t4 from public.restaurant_tables where branch_id = branch and name = '4';
  select id into t5 from public.restaurant_tables where branch_id = branch and name = '5';
  select id into t6 from public.restaurant_tables where branch_id = branch and name = '7';
  select id into t7 from public.restaurant_tables where branch_id = branch and name = 'ع1';

  select v.id into v_hummus_l from public.restaurant_variants v
    join public.restaurant_products p on p.id = v.product_id
    where p.name = 'حمّص بالطحينة' and v.name = 'كبير';
  select v.id into v_mixed_1 from public.restaurant_variants v
    join public.restaurant_products p on p.id = v.product_id
    where p.name = 'مشاوي مشكّلة' and v.name = 'لشخص';
  select v.id into v_mixed_2 from public.restaurant_variants v
    join public.restaurant_products p on p.id = v.product_id
    where p.name = 'مشاوي مشكّلة' and v.name = 'لشخصين';
  select v.id into v_shish from public.restaurant_variants v
    join public.restaurant_products p on p.id = v.product_id where p.name = 'شيش طاووق';
  select v.id into v_kebab from public.restaurant_variants v
    join public.restaurant_products p on p.id = v.product_id where p.name = 'كباب حلبي';
  select v.id into v_shawarma_c from public.restaurant_variants v
    join public.restaurant_products p on p.id = v.product_id
    where p.name = 'ساندويتش شاورما' and v.name = 'دجاج';
  select v.id into v_shawarma_m from public.restaurant_variants v
    join public.restaurant_products p on p.id = v.product_id
    where p.name = 'ساندويتش شاورما' and v.name = 'لحم';
  select v.id into v_plate_c from public.restaurant_variants v
    join public.restaurant_products p on p.id = v.product_id
    where p.name = 'صحن شاورما' and v.name = 'دجاج';
  select v.id into v_tea from public.restaurant_variants v
    join public.restaurant_products p on p.id = v.product_id where p.name = 'شاي';
  select v.id into v_lemon from public.restaurant_variants v
    join public.restaurant_products p on p.id = v.product_id where p.name = 'ليمون بالنعناع';
  select v.id into v_ayran from public.restaurant_variants v
    join public.restaurant_products p on p.id = v.product_id where p.name = 'عيران';
  select v.id into v_water from public.restaurant_variants v
    join public.restaurant_products p on p.id = v.product_id where p.name = 'مياه معدنية';
  select v.id into v_knafeh from public.restaurant_variants v
    join public.restaurant_products p on p.id = v.product_id
    where p.name = 'كنافة نابلسية' and v.name = 'قطعة';
  select v.id into v_fattoush from public.restaurant_variants v
    join public.restaurant_products p on p.id = v.product_id where p.name = 'فتّوش';

  select m.id into mod_meat from public.restaurant_modifiers m where m.name = 'لحمة مفرومة';
  select m.id into mod_pine from public.restaurant_modifiers m where m.name = 'صنوبر';
  select m.id into mod_medium from public.restaurant_modifiers m where m.name = 'وسط';
  select m.id into mod_welldone from public.restaurant_modifiers m where m.name = 'مستوي جيدًا';
  select m.id into mod_rice from public.restaurant_modifiers m where m.name = 'أرز إضافي';
  select m.id into mod_nogarlic from public.restaurant_modifiers m where m.name = 'بدون ثوم';
  select m.id into mod_cheese from public.restaurant_modifiers m where m.name = 'جبنة';

  select id into acct from public.treasury_accounts where branch_id = branch and is_default;
  select id into cust from public.customers where organization_id = org and name = 'أحمد فتحي';

  -- --- Table 1: a guest order that just came in from the QR, still unconfirmed
  select pl.token into token from public.public_links pl
    join public.restaurant_tables t on t.public_link_id = pl.id where t.id = t1;
  perform auth.logout();
  perform public.restaurant_place_public_order(
    token,
    ('[{"variant_id":"' || v_shawarma_c || '","quantity":2,"modifier_ids":["' || mod_nogarlic || '"]},
       {"variant_id":"' || v_ayran || '","quantity":2}]')::jsonb,
    'محمود', '01277778888', 'من فضلكم بسرعة');
  perform auth.as_admin();

  -- --- Table 2: confirmed, sitting in the kitchen queue
  perform auth.login_as(u_cash);
  select out_order_id into ord from public.restaurant_create_order(
    org, branch,
    ('[{"variant_id":"' || v_mixed_2 || '","quantity":1,"modifier_ids":["' || mod_welldone || '","' || mod_rice || '"]},
       {"variant_id":"' || v_hummus_l || '","quantity":1,"modifier_ids":["' || mod_meat || '"]},
       {"variant_id":"' || v_lemon || '","quantity":2}]')::jsonb,
    t2, 'dine_in');
  perform public.restaurant_set_order_status(org, ord, 'confirmed');
  perform auth.as_admin();

  -- --- Table 3: the kitchen is cooking it
  perform auth.login_as(u_cash);
  select out_order_id into ord from public.restaurant_create_order(
    org, branch,
    ('[{"variant_id":"' || v_shish || '","quantity":2,"modifier_ids":[]},
       {"variant_id":"' || v_fattoush || '","quantity":1},
       {"variant_id":"' || v_tea || '","quantity":3}]')::jsonb,
    t3, 'dine_in');
  perform public.restaurant_set_order_status(org, ord, 'confirmed');
  perform auth.as_admin();
  perform auth.login_as(u_kitchen);
  perform public.restaurant_set_order_status(org, ord, 'preparing');
  perform auth.as_admin();

  -- --- Table 4: ready, waiting for a waiter to run it
  perform auth.login_as(u_cash);
  select out_order_id into ord from public.restaurant_create_order(
    org, branch,
    ('[{"variant_id":"' || v_kebab || '","quantity":1},
       {"variant_id":"' || v_water || '","quantity":2}]')::jsonb,
    t4, 'dine_in');
  perform public.restaurant_set_order_status(org, ord, 'confirmed');
  perform auth.as_admin();
  perform auth.login_as(u_kitchen);
  perform public.restaurant_set_order_status(org, ord, 'preparing');
  perform public.restaurant_set_order_status(org, ord, 'ready');
  perform auth.as_admin();

  -- --- Table 5: served, bill not settled yet — half paid
  perform auth.login_as(u_cash);
  select out_order_id into ord from public.restaurant_create_order(
    org, branch,
    ('[{"variant_id":"' || v_mixed_1 || '","quantity":2,"modifier_ids":["' || mod_medium || '"]},
       {"variant_id":"' || v_knafeh || '","quantity":2}]')::jsonb,
    t5, 'dine_in', 'cashier', cust);
  perform public.restaurant_set_order_status(org, ord, 'confirmed');
  perform auth.as_admin();
  perform auth.login_as(u_kitchen);
  perform public.restaurant_set_order_status(org, ord, 'preparing');
  perform public.restaurant_set_order_status(org, ord, 'ready');
  perform auth.as_admin();
  perform auth.login_as(u_waiter);
  perform public.restaurant_set_order_status(org, ord, 'served');
  perform auth.as_admin();
  perform auth.login_as(u_cash);
  perform public.restaurant_pay_order(org, ord, 'cash', 40000, 0);
  perform auth.as_admin();

  -- --- Terrace table 7: takeaway counter order, paid and closed
  perform auth.login_as(u_cash);
  select out_order_id into ord from public.restaurant_create_order(
    org, branch,
    ('[{"variant_id":"' || v_shawarma_m || '","quantity":3,"modifier_ids":["' || mod_cheese || '"]},
       {"variant_id":"' || v_water || '","quantity":3}]')::jsonb,
    null, 'takeaway');
  perform public.restaurant_set_order_status(org, ord, 'confirmed');
  perform auth.as_admin();
  perform auth.login_as(u_kitchen);
  perform public.restaurant_set_order_status(org, ord, 'preparing');
  perform public.restaurant_set_order_status(org, ord, 'ready');
  perform auth.as_admin();
  perform auth.login_as(u_waiter);
  perform public.restaurant_set_order_status(org, ord, 'served');
  perform auth.as_admin();
  perform auth.login_as(u_cash);
  perform public.restaurant_pay_order(org, ord, 'cash', 50000, 0);
  perform public.restaurant_set_order_status(org, ord, 'completed');
  perform auth.as_admin();

  -- --- A handful of completed orders earlier in the shift, so reports and
  --- best sellers have something to show.
  perform auth.login_as(u_cash);
  select out_order_id into ord from public.restaurant_create_order(
    org, branch, ('[{"variant_id":"' || v_plate_c || '","quantity":2},
                    {"variant_id":"' || v_lemon || '","quantity":2}]')::jsonb, t6, 'dine_in');
  perform public.restaurant_set_order_status(org, ord, 'confirmed');
  perform auth.as_admin();
  perform auth.login_as(u_kitchen);
  perform public.restaurant_set_order_status(org, ord, 'preparing');
  perform public.restaurant_set_order_status(org, ord, 'ready');
  perform auth.as_admin();
  perform auth.login_as(u_waiter);
  perform public.restaurant_set_order_status(org, ord, 'served');
  perform auth.as_admin();
  perform auth.login_as(u_cash);
  perform public.restaurant_pay_order(org, ord, 'card', 60000, 0);
  perform public.restaurant_set_order_status(org, ord, 'completed');

  select out_order_id into ord from public.restaurant_create_order(
    org, branch, ('[{"variant_id":"' || v_shawarma_c || '","quantity":4},
                    {"variant_id":"' || v_tea || '","quantity":4}]')::jsonb, t7, 'dine_in');
  perform public.restaurant_set_order_status(org, ord, 'confirmed');
  perform auth.as_admin();
  perform auth.login_as(u_kitchen);
  perform public.restaurant_set_order_status(org, ord, 'preparing');
  perform public.restaurant_set_order_status(org, ord, 'ready');
  perform auth.as_admin();
  perform auth.login_as(u_waiter);
  perform public.restaurant_set_order_status(org, ord, 'served');
  perform auth.as_admin();
  perform auth.login_as(u_cash);
  perform public.restaurant_pay_order(org, ord, 'cash', 53000, 0);
  perform public.restaurant_set_order_status(org, ord, 'completed');

  -- One order the kitchen sent back, cancelled with a reason.
  select out_order_id into ord from public.restaurant_create_order(
    org, branch, ('[{"variant_id":"' || v_kebab || '","quantity":1}]')::jsonb, null, 'takeaway');
  perform auth.as_admin();
  perform auth.login_as(u_owner);
  perform public.restaurant_set_order_status(org, ord, 'cancelled', 'العميل غيّر رأيه قبل التحضير');
  perform auth.as_admin();

  -- --- Expenses paid out of the till today
  perform auth.login_as(u_owner);
  insert into public.treasury_transactions
    (organization_id, branch_id, account_id, direction, amount_cents, currency,
     category, reason, ref_type, created_by) values
    (org, branch, acct, 'out', 185000, 'EGP', 'supplies', 'فاتورة اللحمة — الجزار', 'manual', u_owner),
    (org, branch, acct, 'out',  42000, 'EGP', 'supplies', 'خضار وفاكهة — سوق العبور', 'manual', u_owner),
    (org, branch, acct, 'out',  30000, 'EGP', 'utilities', 'أنابيب غاز', 'manual', u_owner),
    (org, branch, acct, 'out',  15000, 'EGP', 'maintenance', 'صيانة شفاط المطبخ', 'manual', u_owner);
  perform auth.as_admin();

  raise notice 'DEMO DATA: مطعم الحارة الشامية is ready';
end $$;
