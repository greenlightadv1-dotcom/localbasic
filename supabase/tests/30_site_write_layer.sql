-- =============================================================================
-- LOCAL BASIC — 0057 Site Engine write layer
--
-- 28 proves the policies, 29 proves a site's identity. This proves the two
-- things 0057 added: that section content cannot be malformed by a direct
-- write, and that reordering a page is all-or-nothing and page-scoped.
--
-- As in 29, every write is made by somebody who genuinely holds site.manage on
-- the organization involved — a failure caused by a missing permission would
-- prove nothing about the trigger or the function.
--
--   1. content must be an object.
--   2. unknown fields are refused per section type.
--   3. ctaHref accepts only a site path, mailto: or tel:.
--   4. the template's own content still stores (no false positives).
--   5. reorder rejects a foreign section, a duplicate and a short list,
--      and leaves the existing order untouched when it refuses.
--   6. reorder applies a real permutation, and touches no other page.
--   7. reorder refuses a caller without site.manage, and anon.
--   8. site_settings must be an object.
-- =============================================================================

\set ON_ERROR_STOP on

do $$
declare
  u_owner uuid; u_staff uuid; u_other uuid;
  org uuid; br uuid; org_b uuid; br_b uuid;
  m_staff uuid; r_staff uuid;
  site uuid; page1 uuid; page2 uuid; site_b uuid; page_b uuid;
  s1 uuid; s2 uuid; s3 uuid; p2s1 uuid; sec_b uuid;
  ok boolean; n int; v_order uuid[]; v_state text;
begin
  perform auth.as_admin();
  insert into auth.users (email) values ('wl-owner@test.local') returning id into u_owner;
  insert into auth.users (email) values ('wl-staff@test.local') returning id into u_staff;
  insert into auth.users (email) values ('wl-other@test.local') returning id into u_other;

  perform auth.login_as(u_owner);
  select out_organization_id, out_branch_id into org, br
    from public.provision_workspace('WL Alpha', 'wlalpha', 'restaurant');
  perform auth.login_as(u_other);
  select out_organization_id, out_branch_id into org_b, br_b
    from public.provision_workspace('WL Beta', 'wlbeta', 'restaurant');

  -- A real member of org A holding a permission that is not a site permission.
  perform auth.as_admin();
  insert into public.organization_members (organization_id, user_id, status, all_branches)
       values (org, u_staff, 'active', true) returning id into m_staff;
  insert into public.roles (organization_id, key, name_ar, name_en, description)
       values (org, 'wl_staff', 'موظف', 'Staff', 'test') returning id into r_staff;
  insert into public.role_permissions (role_id, permission_key)
       values (r_staff, 'customer.read');
  insert into public.user_roles (member_id, role_id) values (m_staff, r_staff);

  perform auth.login_as(u_owner);
  select public.site_provision(org, 'Alpha Site', 'alpha-site') into site;
  select id into page1 from public.site_pages where site_id = site and is_homepage;
  insert into public.site_pages (site_id, title, slug, sort_order)
       values (site, 'من نحن', 'about', 1) returning id into page2;

  -- ── 4. The template's own content stores ──────────────────────────────────
  -- Run first. If the trigger rejects what the application actually writes,
  -- every refusal below is meaningless.
  insert into public.site_sections (page_id, section_type, content, sort_order) values
    (page1, 'hero', '{"title":"اسم نشاطك هنا","subtitle":"جملة قصيرة","ctaLabel":"تواصل معنا","ctaHref":"/contact","align":"center"}'::jsonb, 0)
    returning id into s1;
  insert into public.site_sections (page_id, section_type, content, sort_order) values
    (page1, 'about', '{"title":"من نحن","body":"نبذة"}'::jsonb, 1)
    returning id into s2;
  insert into public.site_sections (page_id, section_type, content, sort_order) values
    (page1, 'services', '{"title":"خدماتنا","items":[{"name":"الأولى","description":"وصف"}]}'::jsonb, 2)
    returning id into s3;
  insert into public.site_sections (page_id, section_type, content, sort_order) values
    (page1, 'testimonials', '{"title":"آراء","items":[{"quote":"ممتاز","author":"عميل"}]}'::jsonb, 3);
  insert into public.site_sections (page_id, section_type, content, sort_order) values
    (page1, 'contact', '{"title":"تواصل","phone":"","email":"","address":""}'::jsonb, 4);
  insert into public.site_sections (page_id, section_type, content, sort_order) values
    (page1, 'footer', '{"text":"جميع الحقوق محفوظة."}'::jsonb, 5);
  -- And the empty section a freshly created block is.
  insert into public.site_sections (page_id, section_type, content, sort_order)
       values (page2, 'hero', '{}'::jsonb, 0) returning id into p2s1;
  raise notice 'OK 4  every field the template writes is accepted, and so is {}';

  -- ── 1. content must be an object ──────────────────────────────────────────

  ok := false;
  begin
    insert into public.site_sections (page_id, section_type, content)
         values (page1, 'about', '[]'::jsonb);
  exception when others then ok := true; end;
  assert ok, 'a JSON array was accepted as section content';

  ok := false;
  begin
    insert into public.site_sections (page_id, section_type, content)
         values (page1, 'about', '"text"'::jsonb);
  exception when others then ok := true; end;
  assert ok, 'a JSON string was accepted as section content';

  ok := false;
  begin
    insert into public.site_sections (page_id, section_type, content)
         values (page1, 'about', 'null'::jsonb);
  exception when others then ok := true; end;
  assert ok, 'a JSON null was accepted as section content';
  raise notice 'OK 1  section content must be a JSON object';

  -- ── 2. Unknown fields ─────────────────────────────────────────────────────
  ok := false;
  begin
    insert into public.site_sections (page_id, section_type, content)
         values (page1, 'about', '{"title":"ok","script":"<img onerror=x>"}'::jsonb);
  exception when others then ok := true; end;
  assert ok, 'an unknown field was stored on an about section';

  -- A field that is real on ANOTHER type is still unknown on this one: the
  -- allow-list is per type, not a union.
  ok := false;
  begin
    insert into public.site_sections (page_id, section_type, content)
         values (page1, 'footer', '{"text":"ok","ctaHref":"/x"}'::jsonb);
  exception when others then ok := true; end;
  assert ok, 'a hero field was stored on a footer section';

  ok := false;
  begin
    update public.site_sections set content = '{"title":"t","body":"b","extra":1}'::jsonb
     where id = s2;
  exception when others then ok := true; end;
  assert ok, 'an unknown field was smuggled in through UPDATE';
  select count(*) into n from public.site_sections where id = s2 and content ? 'extra';
  assert n = 0, 'the refused update still changed the row';
  raise notice 'OK 2  unknown fields are refused, per type, on insert and update';

  -- ── 3. ctaHref ────────────────────────────────────────────────────────────
  ok := false;
  begin
    update public.site_sections set content = '{"ctaHref":"javascript:alert(1)"}'::jsonb where id = s1;
  exception when others then ok := true; end;
  assert ok, 'javascript: was accepted as a link target';

  ok := false;
  begin
    update public.site_sections set content = '{"ctaHref":"https://evil.example/x"}'::jsonb where id = s1;
  exception when others then ok := true; end;
  assert ok, 'an off-site https link was accepted';

  ok := false;
  begin
    update public.site_sections set content = '{"ctaHref":"//evil.example/x"}'::jsonb where id = s1;
  exception when others then ok := true; end;
  assert ok, 'a protocol-relative link was accepted';

  ok := false;
  begin
    update public.site_sections set content = ('{"ctaHref":"/' || chr(92) || 'evil.example"}')::jsonb where id = s1;
  exception when others then ok := true; end;
  assert ok, 'a backslash-normalised link was accepted';

  ok := false;
  begin
    update public.site_sections set content = '{"ctaHref":"data:text/html,<script>"}'::jsonb where id = s1;
  exception when others then ok := true; end;
  assert ok, 'a data: URL was accepted';

  ok := false;
  begin
    update public.site_sections set content = '{"ctaHref":123}'::jsonb where id = s1;
  exception when others then ok := true; end;
  assert ok, 'a number was accepted as a link target';

  -- The three that must work, plus explicit "no link".
  update public.site_sections set content = '{"ctaHref":"/contact"}'::jsonb where id = s1;
  update public.site_sections set content = '{"ctaHref":"mailto:hi@example.com"}'::jsonb where id = s1;
  update public.site_sections set content = '{"ctaHref":"tel:+20 100 000 0000"}'::jsonb where id = s1;
  update public.site_sections set content = '{"ctaHref":null}'::jsonb where id = s1;
  select count(*) into n from public.site_sections where id = s1;
  assert n = 1, 'a valid link target was refused';
  raise notice 'OK 3  ctaHref accepts a site path, mailto: and tel:, and nothing else';

  -- ── 5. Reorder refusals leave the order untouched ─────────────────────────
  update public.site_sections set content = '{}'::jsonb where id = s1;
  select array_agg(id order by sort_order, id) into v_order
    from public.site_sections where page_id = page1;
  assert array_length(v_order, 1) = 6, 'the fixture page should hold six sections';

  -- The identity permutation, first, so the refusals below are known to come
  -- from the function's own checks rather than from it not existing. Every
  -- refusal also asserts its SQLSTATE for the same reason: 42883 (undefined
  -- function) must never be mistaken for a rejection.
  n := public.site_sections_reorder(page1, v_order);
  assert n = 6, 'the identity reorder reported ' || n;

  -- A section from another page of the same site.
  v_state := null;
  begin
    perform public.site_sections_reorder(page1, array[s1, s2, s3, p2s1]);
  exception when others then v_state := sqlstate; end;
  assert v_state = '22023', 'reorder accepted a section from another page (sqlstate '
    || coalesce(v_state, 'none') || ')';

  -- A duplicate.
  v_state := null;
  begin
    perform public.site_sections_reorder(page1, array[s1, s1, s2, s3]);
  exception when others then v_state := sqlstate; end;
  assert v_state = '22023', 'reorder accepted the same section twice (sqlstate '
    || coalesce(v_state, 'none') || ')';

  -- A short list: the unlisted sections would keep stale positions.
  v_state := null;
  begin
    perform public.site_sections_reorder(page1, array[s1, s2]);
  exception when others then v_state := sqlstate; end;
  assert v_state = '22023', 'reorder accepted a partial list (sqlstate '
    || coalesce(v_state, 'none') || ')';

  -- A random id that is not a section at all.
  v_state := null;
  begin
    perform public.site_sections_reorder(page1, array[gen_random_uuid()]);
  exception when others then v_state := sqlstate; end;
  assert v_state = '22023', 'reorder accepted an id that is not a section (sqlstate '
    || coalesce(v_state, 'none') || ')';

  select count(*) into n from public.site_sections
   where page_id = page1
     and id = v_order[sort_order + 1];
  assert n = 6, 'a refused reorder changed the existing order';
  raise notice 'OK 5  reorder refuses a foreign, duplicate, partial or unknown id, atomically';

  -- ── 6. A real permutation applies, and only to this page ──────────────────
  select array_agg(id order by sort_order desc, id desc) into v_order
    from public.site_sections where page_id = page1;
  n := public.site_sections_reorder(page1, v_order);
  assert n = 6, 'reorder reported ' || n || ' sections';

  select count(*) into n from public.site_sections
   where page_id = page1 and id = v_order[sort_order + 1];
  assert n = 6, 'the new order was not applied in full';

  select count(*) into n from public.site_sections where page_id = page1;
  assert n = 6, 'reorder changed how many sections the page has';

  -- No duplicate positions: six sections must occupy six distinct slots.
  select count(distinct sort_order) into n from public.site_sections where page_id = page1;
  assert n = 6, 'reorder produced duplicate positions';

  select sort_order into n from public.site_sections where id = p2s1;
  assert n = 0, 'reordering one page moved a section on another page';
  raise notice 'OK 6  a permutation applies in full, to one page, with distinct positions';

  -- ── 7. Reorder authorization ──────────────────────────────────────────────
  select array_agg(id order by sort_order, id) into v_order
    from public.site_sections where page_id = page1;

  -- A real member of the org, without site.manage.
  perform auth.login_as(u_staff);
  v_state := null;
  begin
    perform public.site_sections_reorder(page1, v_order);
  exception when others then v_state := sqlstate; end;
  assert v_state = '42501', 'a member without site.manage reordered a page (sqlstate '
    || coalesce(v_state, 'none') || ')';

  -- An owner of another organization, holding site.manage — in their own org.
  perform auth.login_as(u_other);
  v_state := null;
  begin
    perform public.site_sections_reorder(page1, v_order);
  exception when others then v_state := sqlstate; end;
  assert v_state = '42501', 'another organization''s owner reordered this page (sqlstate '
    || coalesce(v_state, 'none') || ')';

  perform auth.logout();
  v_state := null;
  begin
    perform public.site_sections_reorder(page1, v_order);
  exception when others then v_state := sqlstate; end;
  assert v_state in ('42501', '42P01'), 'anon reordered a page (sqlstate '
    || coalesce(v_state, 'none') || ')';
  raise notice 'OK 7  reorder refuses a member without the permission, another org, and anon';

  -- ── 8. site_settings must be an object ────────────────────────────────────
  perform auth.login_as(u_owner);
  ok := false;
  begin
    update public.site_settings set settings = '[]'::jsonb where site_id = site;
  exception when others then ok := true; end;
  assert ok, 'a JSON array was accepted as site settings';

  update public.site_settings set settings = '{"locale":"ar","direction":"rtl"}'::jsonb
   where site_id = site;
  select count(*) into n from public.site_settings
   where site_id = site and settings ->> 'locale' = 'ar';
  assert n = 1, 'a valid settings object was refused';
  raise notice 'OK 8  site settings must be a JSON object';

  raise notice '';
  raise notice 'SITE WRITE LAYER: all assertions passed';
end $$;
