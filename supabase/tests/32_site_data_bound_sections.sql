-- =============================================================================
-- LOCAL BASIC — 0059 data-bound section contract
--
-- The architectural rule of Phase 3 is that a section may declare WHAT live
-- business data to show and may never store the data itself. TypeScript states
-- that rule; this file proves the DATABASE enforces it, which is the layer a
-- direct PostgREST write does not pass through.
--
--   1  the four new types are storable
--   2  declarative configuration is accepted
--   3  copied MENU data is refused
--   4  copied BUSINESS data is refused
--   5  copied HOURS data is refused
--   6  copied BRANCH data is refused
--   7  an organization id or branch id cannot be stored in any of them
--   8  source must be 'live'
--   9  categoryIds must be identifiers, and limit a sane whole number
--  10  the presentational types are unchanged by 0059
-- =============================================================================

\set ON_ERROR_STOP on

do $$
declare
  u uuid; org uuid; br uuid; site uuid; pg uuid;
  ok boolean; n int; v_state text; t text;
begin
  perform auth.as_admin();
  insert into auth.users (email) values ('db-owner@test.local') returning id into u;
  perform auth.login_as(u);
  select out_organization_id, out_branch_id into org, br
    from public.provision_workspace('DB Alpha', 'dbalpha', 'restaurant');
  select public.site_provision(org, 'Alpha Site', 'alpha-site') into site;
  select id into pg from public.site_pages where site_id = site and is_homepage;

  -- ── 1 + 2. The new types, with their declarative configuration ────────────
  insert into public.site_sections (page_id, section_type, content, sort_order) values
    (pg, 'menu',          '{"source":"live","title":"قائمتنا"}'::jsonb, 0),
    (pg, 'business_info', '{"source":"live"}'::jsonb, 1),
    (pg, 'hours',         '{"source":"live","title":"مواعيدنا"}'::jsonb, 2),
    (pg, 'branches',      '{"source":"live"}'::jsonb, 3);
  select count(*) into n from public.site_sections where page_id = pg;
  assert n = 4, 'the four data-bound types should all store, found ' || n;

  -- Empty content is a freshly created section, here as everywhere.
  insert into public.site_sections (page_id, section_type, content, sort_order)
       values (pg, 'menu', '{}'::jsonb, 4);

  -- The menu's two narrowings.
  insert into public.site_sections (page_id, section_type, content, sort_order)
       values (pg, 'menu',
               ('{"source":"live","limit":20,"categoryIds":["' || gen_random_uuid() || '"]}')::jsonb,
               5);
  raise notice 'OK 1/2 the four data-bound types store their declarative configuration';

  -- ── 3. Copied MENU data ───────────────────────────────────────────────────
  -- The whole point of the phase: a price, a dish or a description must be
  -- unstorable, not merely discouraged.
  foreach t in array array[
    '{"items":[{"name":"لاتيه","price":6500}]}',
    '{"products":[]}',
    '{"prices":{"latte":6500}}',
    '{"price_cents":6500}',
    '{"source":"live","itemName":"لاتيه"}',
    '{"source":"live","description":"حليب وإسبريسو"}',
    '{"source":"live","available":true}',
    '{"variants":[]}'
  ] loop
    ok := false;
    begin
      insert into public.site_sections (page_id, section_type, content)
           values (pg, 'menu', t::jsonb);
    exception when others then ok := true; end;
    assert ok, 'copied menu data was stored: ' || t;
  end loop;
  raise notice 'OK 3  copied menu items, prices and descriptions are refused';

  -- ── 4. Copied BUSINESS data ───────────────────────────────────────────────
  foreach t in array array[
    '{"source":"live","name":"Lavechi"}',
    '{"source":"live","phone":"0100"}',
    '{"source":"live","whatsapp":"0111"}',
    '{"source":"live","email":"hi@x.test"}',
    '{"source":"live","address":"شارع ٩"}',
    '{"source":"live","logoUrl":"https://x/l.png"}'
  ] loop
    ok := false;
    begin
      insert into public.site_sections (page_id, section_type, content)
           values (pg, 'business_info', t::jsonb);
    exception when others then ok := true; end;
    assert ok, 'copied business data was stored: ' || t;
  end loop;
  raise notice 'OK 4  copied business name, phone, email and address are refused';

  -- ── 5. Copied HOURS data ──────────────────────────────────────────────────
  foreach t in array array[
    '{"source":"live","days":[]}',
    '{"source":"live","opens":"09:00"}',
    '{"source":"live","closes":"23:00"}',
    '{"source":"live","schedule":{}}',
    '{"source":"live","openingHours":[]}'
  ] loop
    ok := false;
    begin
      insert into public.site_sections (page_id, section_type, content)
           values (pg, 'hours', t::jsonb);
    exception when others then ok := true; end;
    assert ok, 'copied hours data was stored: ' || t;
  end loop;
  raise notice 'OK 5  copied weekly opening hours are refused';

  -- ── 6. Copied BRANCH data ─────────────────────────────────────────────────
  foreach t in array array[
    '{"source":"live","branches":[]}',
    '{"source":"live","address":"المعادي"}',
    '{"source":"live","branchName":"فرع المعادي"}'
  ] loop
    ok := false;
    begin
      insert into public.site_sections (page_id, section_type, content)
           values (pg, 'branches', t::jsonb);
    exception when others then ok := true; end;
    assert ok, 'copied branch data was stored: ' || t;
  end loop;
  raise notice 'OK 6  copied branch records are refused';

  -- ── 7. Tenant identifiers ─────────────────────────────────────────────────
  -- A payload must not be able to name whose data to show. The resolver reads
  -- the organization from the authorized context, and these keys cannot even
  -- reach the column.
  foreach t in array array[
    '{"source":"live","organization_id":"11111111-1111-4111-8111-111111111111"}',
    '{"source":"live","organizationId":"11111111-1111-4111-8111-111111111111"}',
    '{"source":"live","branch_id":"11111111-1111-4111-8111-111111111111"}',
    '{"source":"live","branchId":"11111111-1111-4111-8111-111111111111"}',
    '{"source":"live","org":"other"}',
    '{"source":"live","table":"profiles"}'
  ] loop
    ok := false;
    begin
      insert into public.site_sections (page_id, section_type, content)
           values (pg, 'menu', t::jsonb);
    exception when others then ok := true; end;
    assert ok, 'a tenant identifier was stored in section content: ' || t;
  end loop;
  raise notice 'OK 7  no organization, branch or table identifier is storable';

  -- ── 8. source must be 'live' ──────────────────────────────────────────────
  -- A second value would be a second resolution strategy, and the only
  -- plausible one is a snapshot — the thing this design exists to prevent.
  foreach t in array array[
    '{"source":"snapshot"}', '{"source":"cached"}', '{"source":true}', '{"source":null}'
  ] loop
    ok := false;
    begin
      insert into public.site_sections (page_id, section_type, content)
           values (pg, 'hours', t::jsonb);
    exception when others then ok := true; end;
    assert ok, 'source was accepted as: ' || t;
  end loop;
  raise notice 'OK 8  source must be "live"';

  -- ── 9. categoryIds and limit ──────────────────────────────────────────────
  foreach t in array array[
    '{"categoryIds":"not-a-list"}',
    '{"categoryIds":[1,2]}',
    '{"categoryIds":["not-an-identifier"]}',
    '{"categoryIds":[{"id":"x"}]}',
    '{"limit":0}',
    '{"limit":201}',
    '{"limit":1.5}',
    '{"limit":"20"}'
  ] loop
    ok := false;
    begin
      insert into public.site_sections (page_id, section_type, content)
           values (pg, 'menu', t::jsonb);
    exception when others then ok := true; end;
    assert ok, 'an invalid narrowing was stored: ' || t;
  end loop;
  raise notice 'OK 9  categoryIds must be identifiers and limit a whole 1..200';

  -- ── 10. The presentational types are untouched ────────────────────────────
  insert into public.site_sections (page_id, section_type, content, sort_order)
       values (pg, 'hero', '{"title":"مرحبا","ctaHref":"/contact"}'::jsonb, 10);

  ok := false;
  begin
    insert into public.site_sections (page_id, section_type, content)
         values (pg, 'hero', '{"ctaHref":"javascript:alert(1)"}'::jsonb);
  exception when others then ok := true; end;
  assert ok, '0059 weakened the hero ctaHref rule';

  ok := false;
  begin
    insert into public.site_sections (page_id, section_type, content)
         values (pg, 'about', '{"title":"t","source":"live"}'::jsonb);
  exception when others then ok := true; end;
  assert ok, 'a data-bound key was accepted on a presentational section';

  -- And a type outside the list is still unstorable.
  ok := false;
  begin
    insert into public.site_sections (page_id, section_type, content)
         values (pg, 'gallery', '{}'::jsonb);
  exception when others then ok := true; end;
  assert ok, 'an unknown section type was stored';
  raise notice 'OK 10 presentational rules unchanged; unknown types still refused';

  raise notice '';
  raise notice 'SITE DATA-BOUND SECTIONS: all assertions passed';
end $$;
