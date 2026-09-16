-- =============================================================================
-- LOCAL BASIC — Website builder suite
--
-- What has to hold:
--
--   1. A website belongs to exactly one restaurant, and no other tenant can
--      read, change or publish it.
--   2. A visitor sees the PUBLISHED revision and never the draft.
--   3. Markup, scripts and arbitrary URLs cannot be stored at all — not
--      sanitised on the way out, refused on the way in.
--   4. Publishing is atomic: one live revision, always, or none.
--   5. The menu stays authoritative. Website content cannot move a price.
--   6. Platform Admin stays outside tenant RBAC.
--
-- Run with:  psql -v ON_ERROR_STOP=1 -f supabase/tests/15_website_builder.sql
-- =============================================================================

\set ON_ERROR_STOP on

do $$
declare
  u_a     uuid;  u_b uuid;  u_waiter uuid;  u_admin uuid;
  org_a   uuid;  branch_a uuid;  org_b uuid;  branch_b uuid;
  cat_a   uuid;  prod_a uuid;  var_a uuid;
  sec_hero uuid; sec_menu uuid; sec_b uuid;
  role_waiter uuid; member_waiter uuid;
  n       int;
  ok      boolean;
  msg     text;
  total   bigint;
  v       record;
  r       record;
begin
  -- ==========================================================================
  -- Fixture: two restaurants, both published, plus a non-privileged member.
  -- ==========================================================================
  insert into auth.users (email) values ('wba@test.local')      returning id into u_a;
  insert into auth.users (email) values ('wbb@test.local')      returning id into u_b;
  insert into auth.users (email) values ('wbwaiter@test.local') returning id into u_waiter;
  insert into auth.users (email) values ('wbadmin@test.local')  returning id into u_admin;

  perform auth.login_as(u_a);
  select out_organization_id, out_branch_id into org_a, branch_a
    from public.provision_workspace('مطعم البناء', 'wbalpha', 'restaurant');
  perform auth.login_as(u_b);
  select out_organization_id, out_branch_id into org_b, branch_b
    from public.provision_workspace('مطعم بيتا', 'wbbeta', 'restaurant');
  perform auth.as_admin();

  insert into public.platform_admins (user_id, role) values (u_admin, 'owner');

  insert into public.restaurant_categories (organization_id, name) values (org_a, 'الأطباق')
    returning id into cat_a;
  insert into public.restaurant_products (organization_id, category_id, name)
  values (org_a, cat_a, 'فتّة') returning id into prod_a;
  insert into public.restaurant_variants (organization_id, product_id, name, price_cents)
  values (org_a, prod_a, 'default', 8000) returning id into var_a;

  insert into public.settings (organization_id, branch_id, key, value) values
    (org_a, null, 'restaurant.website_enabled', 'true'::jsonb),
    (org_a, null, 'restaurant.online_ordering_enabled', 'true'::jsonb),
    (org_a, null, 'restaurant.pickup_enabled', 'true'::jsonb),
    (org_b, null, 'restaurant.website_enabled', 'true'::jsonb);

  -- A member of restaurant A who does NOT hold settings.manage.
  select id into role_waiter from public.roles
   where organization_id = org_a and key = 'waiter' limit 1;
  insert into public.organization_members (organization_id, user_id, status, all_branches)
  values (org_a, u_waiter, 'active', true) returning id into member_waiter;
  insert into public.user_roles (member_id, role_id) values (member_waiter, role_waiter);

  -- ==========================================================================
  -- 1. An authorized tenant user can build their own website
  -- ==========================================================================
  perform auth.login_as(u_a);

  assert app.has_permission(org_a, 'settings.manage'),
    'FAIL: fixture is wrong — the owner should hold settings.manage';

  insert into public.restaurant_website_sections
    (organization_id, section_type, sort_order, config)
  values (org_a, 'hero', 0, jsonb_build_object('title', 'أهلاً بكم', 'show_order_button', true))
  returning id into sec_hero;

  insert into public.restaurant_website_sections
    (organization_id, section_type, sort_order, config)
  values (org_a, 'menu', 1, jsonb_build_object('title', 'منيو اليوم', 'show_prices', true))
  returning id into sec_menu;

  select count(*) into n from public.restaurant_website_sections
   where organization_id = org_a;
  assert n = 2, format('FAIL: the owner has %s sections, expected 2', n);

  raise notice 'BUILDER: an authorized tenant user builds their own website';

  -- ==========================================================================
  -- 2. A member WITHOUT settings.manage is refused
  --
  -- Not hidden in the UI — refused by RLS, which is the actual boundary.
  -- ==========================================================================
  perform auth.login_as(u_waiter);

  assert not app.has_permission(org_a, 'settings.manage'),
    'FAIL: fixture is wrong — the waiter should not hold settings.manage';

  select count(*) into n from public.restaurant_website_sections;
  assert n = 0, 'FAIL: a member without settings.manage can read website sections';

  ok := false;
  begin
    insert into public.restaurant_website_sections (organization_id, section_type)
    values (org_a, 'about');
  exception when others then ok := true; end;
  assert ok, 'FAIL: a member without settings.manage created a section';

  begin
    update public.restaurant_website_sections set enabled = false where id = sec_hero;
    get diagnostics n = row_count;
    assert n = 0, 'FAIL: a member without settings.manage updated a section';
  exception when others then null; end;

  ok := false;
  begin perform public.restaurant_website_publish('wbalpha', null);
  exception when others then ok := true; end;
  assert ok, 'FAIL: a member without settings.manage published the website';

  raise notice 'BUILDER: a tenant member without settings.manage is refused';

  -- ==========================================================================
  -- 3. ATTACK: restaurant B goes after restaurant A's website
  -- ==========================================================================
  perform auth.login_as(u_b);

  select count(*) into n from public.restaurant_website_sections;
  assert n = 0, 'FAIL: tenant B can read tenant A''s website sections';

  select count(*) into n from public.restaurant_website_sections where id = sec_hero;
  assert n = 0, 'FAIL: tenant B can read tenant A''s section by id';

  -- Forging the organization id on insert.
  ok := false;
  begin
    insert into public.restaurant_website_sections (organization_id, section_type)
    values (org_a, 'cta');
  exception when others then ok := true; end;
  assert ok, 'FAIL: tenant B inserted a section into tenant A''s website';

  -- Forging a section id on update and delete: both match nothing.
  begin
    update public.restaurant_website_sections
       set config = jsonb_build_object('title', 'مخترق')
     where id = sec_hero;
    get diagnostics n = row_count;
    assert n = 0, 'FAIL: tenant B updated tenant A''s section';
  exception when others then null; end;

  begin
    delete from public.restaurant_website_sections where id = sec_hero;
    get diagnostics n = row_count;
    assert n = 0, 'FAIL: tenant B deleted tenant A''s section';
  exception when others then null; end;

  -- Publishing someone else's website by naming their slug.
  ok := false;
  begin perform public.restaurant_website_publish('wbalpha', 'stolen');
  exception when others then ok := true; end;
  assert ok, 'FAIL: tenant B published tenant A''s website';

  ok := false;
  begin perform public.restaurant_website_unpublish('wbalpha');
  exception when others then ok := true; end;
  assert ok, 'FAIL: tenant B unpublished tenant A''s website';

  perform auth.as_admin();
  select config ->> 'title' into msg from public.restaurant_website_sections where id = sec_hero;
  assert msg = 'أهلاً بكم', 'FAIL: tenant A''s section was modified';
  perform auth.login_as(u_a);

  raise notice 'BUILDER: one tenant cannot read, change or publish another''s website';

  -- ==========================================================================
  -- 4. Content validation: no markup, no scripts, no arbitrary URLs
  --
  -- Every one of these is refused at write time. Nothing is stripped or
  -- escaped, so no renderer downstream can be tricked by stored content.
  -- ==========================================================================
  for msg in select unnest(array[
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    'hello <b>world</b>',
    '<iframe src="https://evil.test"></iframe>'
  ]) loop
    ok := false;
    begin
      insert into public.restaurant_website_sections (organization_id, section_type, config)
      values (org_a, 'cta', jsonb_build_object('title', msg));
    exception when others then ok := true; end;
    assert ok, format('FAIL: markup was accepted: %s', msg);
  end loop;

  for msg in select unnest(array[
    'javascript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD4=',
    'http://insecure.test/a.jpg',
    'vbscript:msgbox(1)'
  ]) loop
    ok := false;
    begin
      insert into public.restaurant_website_sections (organization_id, section_type, config)
      values (org_a, 'about', jsonb_build_object('image_url', msg));
    exception when others then ok := true; end;
    assert ok, format('FAIL: an unsafe URL was accepted: %s', msg);
  end loop;

  -- An unknown key is refused rather than ignored, so nothing can be smuggled
  -- into the published snapshot for a later renderer to read.
  for msg in select unnest(array['custom_html', 'custom_css', 'script', 'onclick']) loop
    ok := false;
    begin
      insert into public.restaurant_website_sections (organization_id, section_type, config)
      values (org_a, 'cta', jsonb_build_object(msg, 'x'));
    exception when others then ok := true; end;
    assert ok, format('FAIL: an unknown config key was accepted: %s', msg);
  end loop;

  -- An unknown section type cannot exist at all.
  ok := false;
  begin
    insert into public.restaurant_website_sections (organization_id, section_type)
    values (org_a, 'custom_code');
  exception when others then ok := true; end;
  assert ok, 'FAIL: an unknown section type was accepted';

  -- A CTA cannot point anywhere it likes: that would be an open redirect.
  ok := false;
  begin
    insert into public.restaurant_website_sections (organization_id, section_type, config)
    values (org_a, 'cta', jsonb_build_object('button_target', 'https://evil.test'));
  exception when others then ok := true; end;
  assert ok, 'FAIL: an arbitrary CTA target was accepted';

  -- Gallery images are https or nothing, and bounded.
  ok := false;
  begin
    insert into public.restaurant_website_sections (organization_id, section_type, config)
    values (org_a, 'gallery', jsonb_build_object('images',
      jsonb_build_array('https://ok.test/a.jpg', 'javascript:alert(1)')));
  exception when others then ok := true; end;
  assert ok, 'FAIL: a gallery accepted an unsafe URL';

  raise notice 'BUILDER: markup, scripts, unsafe URLs and unknown keys are refused';

  -- ==========================================================================
  -- 5. Theme validation: no arbitrary CSS
  -- ==========================================================================
  for msg in select unnest(array[
    'red; background: url(https://evil.test)',
    'expression(alert(1))',
    '#1E2FC8; }',
    'inherit'
  ]) loop
    ok := false;
    begin
      insert into public.settings (organization_id, branch_id, key, value)
      values (org_a, null, 'restaurant.website_theme',
              jsonb_build_object('primary_color', msg))
      on conflict (organization_id, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid), key)
      do update set value = excluded.value;
    exception when others then ok := true; end;
    assert ok, format('FAIL: an unsafe colour was accepted: %s', msg);
  end loop;

  ok := false;
  begin
    insert into public.settings (organization_id, branch_id, key, value)
    values (org_a, null, 'restaurant.website_theme',
            jsonb_build_object('font', 'url(https://evil.test/f.woff)'));
  exception when others then ok := true; end;
  assert ok, 'FAIL: an arbitrary font was accepted';

  ok := false;
  begin
    insert into public.settings (organization_id, branch_id, key, value)
    values (org_a, null, 'restaurant.website_theme', jsonb_build_object('custom_css', 'body{}'));
  exception when others then ok := true; end;
  assert ok, 'FAIL: an unknown theme key was accepted';

  -- A valid theme stores cleanly.
  insert into public.settings (organization_id, branch_id, key, value)
  values (org_a, null, 'restaurant.website_theme',
          jsonb_build_object('primary_color', '#123456', 'font', 'cairo',
                             'background', 'dark', 'button_style', 'pill', 'width', 'wide'));

  raise notice 'BUILDER: the theme accepts hex colours and fixed choices only';

  -- ==========================================================================
  -- 6. Draft is invisible to the public; published is what shows
  -- ==========================================================================
  perform auth.logout();

  -- Before publishing, the public layout is empty and the site falls back.
  select count(*) into n from public.restaurant_website_layout('wbalpha');
  assert n = 0, 'FAIL: an unpublished draft was returned to a visitor';

  -- anon has no privilege on either table, so there is nothing to read even
  -- if a policy were later loosened by mistake.
  ok := false;
  begin perform 1 from public.restaurant_website_sections;
  exception when insufficient_privilege then ok := true; end;
  assert ok, 'FAIL: anon holds a privilege on restaurant_website_sections';

  ok := false;
  begin perform 1 from public.restaurant_website_revisions;
  exception when insufficient_privilege then ok := true; end;
  assert ok, 'FAIL: anon holds a privilege on restaurant_website_revisions';

  ok := false;
  begin perform public.restaurant_website_publish('wbalpha', null);
  exception when others then ok := true; end;
  assert ok, 'FAIL: an anonymous caller published a website';

  raise notice 'BUILDER: a visitor cannot reach a draft by any route';

  -- ==========================================================================
  -- 7. Publishing: atomic, versioned, ordered, audited
  -- ==========================================================================
  perform auth.login_as(u_a);

  select * into v from public.restaurant_website_publish('wbalpha', 'الإصدار الأول');
  assert v.out_version = 1, format('FAIL: first publish produced version %s', v.out_version);
  assert v.out_section_count = 2, format('FAIL: published %s sections', v.out_section_count);

  select count(*) into n from public.restaurant_website_revisions
   where organization_id = org_a and is_live;
  assert n = 1, 'FAIL: there is not exactly one live revision';

  select count(*) into n from public.audit_logs
   where organization_id = org_a and action = 'restaurant.website_published'
     and actor_id = u_a;
  assert n = 1, 'FAIL: publishing was not audited against the acting user';

  -- The published order is the draft's order, deterministically.
  perform auth.logout();
  select sections into msg from public.restaurant_website_layout('wbalpha') limit 1;
  select (msg::jsonb -> 0 ->> 'type'), (msg::jsonb -> 1 ->> 'type') into r;
  assert (msg::jsonb -> 0 ->> 'type') = 'hero',
    'FAIL: the first published section is not the first draft section';
  assert (msg::jsonb -> 1 ->> 'type') = 'menu',
    'FAIL: the second published section is not the second draft section';

  -- Reordering the draft does not move the public site.
  perform auth.login_as(u_a);
  update public.restaurant_website_sections set sort_order = 5 where id = sec_hero;

  perform auth.logout();
  select sections into msg from public.restaurant_website_layout('wbalpha') limit 1;
  assert (msg::jsonb -> 0 ->> 'type') = 'hero',
    'FAIL: a draft reorder changed the published site before publishing';

  -- Publishing again cuts version 2 and swaps which is live, with no moment
  -- in between where two are live or none is.
  perform auth.login_as(u_a);
  select * into v from public.restaurant_website_publish('wbalpha', null);
  assert v.out_version = 2, format('FAIL: second publish produced version %s', v.out_version);

  select count(*) into n from public.restaurant_website_revisions
   where organization_id = org_a and is_live;
  assert n = 1, 'FAIL: publishing twice left more or fewer than one live revision';

  select count(*) into n from public.restaurant_website_revisions where organization_id = org_a;
  assert n = 2, 'FAIL: the previous revision was not kept';

  perform auth.logout();
  select sections into msg from public.restaurant_website_layout('wbalpha') limit 1;
  assert (msg::jsonb -> 0 ->> 'type') = 'menu',
    'FAIL: the new revision did not take effect';

  raise notice 'BUILDER: publishing is versioned, ordered, atomic and audited';

  -- ==========================================================================
  -- 8. An empty website cannot be published over a working one
  -- ==========================================================================
  perform auth.login_as(u_a);
  update public.restaurant_website_sections set enabled = false where organization_id = org_a;

  ok := false;
  begin perform public.restaurant_website_publish('wbalpha', null);
  exception when others then ok := true; end;
  assert ok, 'FAIL: a website with no enabled sections was published';

  -- And the previous revision is untouched: a refused publish changes nothing.
  select count(*) into n from public.restaurant_website_revisions
   where organization_id = org_a and is_live and version = 2;
  assert n = 1, 'FAIL: a refused publish disturbed the live revision';

  update public.restaurant_website_sections set enabled = true where organization_id = org_a;

  raise notice 'BUILDER: a refused publish leaves the live revision alone';

  -- ==========================================================================
  -- 9. Unpublishing falls back without destroying history
  -- ==========================================================================
  perform public.restaurant_website_unpublish('wbalpha');

  perform auth.logout();
  select count(*) into n from public.restaurant_website_layout('wbalpha');
  assert n = 0, 'FAIL: the site still serves a layout after unpublishing';

  perform auth.as_admin();
  select count(*) into n from public.restaurant_website_revisions where organization_id = org_a;
  assert n = 2, 'FAIL: unpublishing destroyed revision history';
  perform auth.login_as(u_a);

  -- Put it back for the remaining sections.
  perform public.restaurant_website_publish('wbalpha', null);

  raise notice 'BUILDER: unpublishing falls back and keeps history';

  -- ==========================================================================
  -- 10. Turning the website off hides the custom layout too
  -- ==========================================================================
  perform auth.as_admin();
  update public.settings set value = 'false'::jsonb
   where organization_id = org_a and key = 'restaurant.website_enabled';
  perform auth.logout();

  select count(*) into n from public.restaurant_website_layout('wbalpha');
  assert n = 0, 'FAIL: an unpublished restaurant still served its custom layout';

  perform auth.as_admin();
  update public.settings set value = 'true'::jsonb
   where organization_id = org_a and key = 'restaurant.website_enabled';

  raise notice 'BUILDER: the website switch still governs the custom layout';

  -- ==========================================================================
  -- 11. The menu stays authoritative
  --
  -- The website decides whether to SHOW prices. It cannot decide what they are.
  -- ==========================================================================
  perform auth.login_as(u_a);
  update public.restaurant_website_sections
     set config = jsonb_build_object('title', 'منيو', 'show_prices', false)
   where id = sec_menu;
  perform public.restaurant_website_publish('wbalpha', null);
  perform auth.logout();

  -- The public menu still reports the real price, whatever the website says.
  select m.price_cents into total
    from public.restaurant_website_menu('wbalpha', 'main') m
   where m.variant_id = var_a;
  assert total = 8000, format('FAIL: the website moved the menu price to %s', total);

  -- And an order placed through D1 is priced from the menu, not the website.
  select out_total_cents into total
    from public.restaurant_place_online_order(
      'wbalpha', 'main',
      jsonb_build_array(jsonb_build_object('variant_id', var_a, 'quantity', 1)),
      'pickup', 'زائر', '01000000000', 'wb-price-key-0001');
  assert total = 8000, format('FAIL: checkout charged %s, not the menu price', total);

  raise notice 'BUILDER: the menu and checkout remain authoritative on price';

  -- ==========================================================================
  -- 12. Inactive branches stay hidden, whatever the layout says
  -- ==========================================================================
  perform auth.as_admin();
  insert into public.branches (organization_id, slug, name, is_active)
  values (org_a, 'closedbranch', 'فرع مغلق', false);
  perform auth.logout();

  select count(*) into n from public.restaurant_website_branches('wbalpha') b
   where b.branch_slug = 'closedbranch';
  assert n = 0, 'FAIL: an inactive branch is publicly visible';

  raise notice 'BUILDER: inactive branches stay hidden';

  -- ==========================================================================
  -- 13. A hostile slug is data, not query
  -- ==========================================================================
  select count(*) into n from public.restaurant_website_layout(
    'wbalpha''; drop table public.restaurant_website_sections; --');
  assert n = 0, 'FAIL: a hostile slug returned a layout';
  assert to_regclass('public.restaurant_website_sections') is not null,
    'FAIL: a hostile slug reached the schema';

  raise notice 'BUILDER: slugs are values';

  -- ==========================================================================
  -- 14. Platform Admin stays outside tenant RBAC
  --
  -- A platform admin operates the SaaS. That is not the same thing as being
  -- allowed to rewrite a customer's website, and nothing here grants it.
  -- ==========================================================================
  perform auth.login_as(u_admin);

  assert app.is_platform_admin(), 'FAIL: fixture is wrong — this user should be a platform admin';
  assert not app.has_permission(org_a, 'settings.manage'),
    'FAIL: a platform admin acquired a tenant permission';

  select count(*) into n from public.restaurant_website_sections;
  assert n = 0, 'FAIL: a platform admin can read tenant website drafts through RLS';

  ok := false;
  begin perform public.restaurant_website_publish('wbalpha', 'by platform admin');
  exception when others then ok := true; end;
  assert ok, 'FAIL: a platform admin published a tenant website';

  ok := false;
  begin
    insert into public.restaurant_website_sections (organization_id, section_type)
    values (org_a, 'gallery');
  exception when others then ok := true; end;
  assert ok, 'FAIL: a platform admin inserted a section into a tenant website';

  raise notice 'BUILDER: platform admin is not a tenant editor';

  -- ==========================================================================
  -- 15. Revisions are append-only
  -- ==========================================================================
  perform auth.login_as(u_a);

  begin
    update public.restaurant_website_revisions
       set sections = '[]'::jsonb
     where organization_id = org_a;
    get diagnostics n = row_count;
    assert n = 0, 'FAIL: a tenant rewrote a published revision';
  exception when others then null; end;

  begin
    delete from public.restaurant_website_revisions where organization_id = org_a;
    get diagnostics n = row_count;
    assert n = 0, 'FAIL: a tenant deleted a published revision';
  exception when others then null; end;

  select count(*) into n from public.restaurant_website_revisions where organization_id = org_a;
  assert n >= 3, format('FAIL: revision history was lost, %s remain', n);

  raise notice 'BUILDER: published revisions are append-only';

  raise notice 'WEBSITE BUILDER: all assertions passed';
end $$;
