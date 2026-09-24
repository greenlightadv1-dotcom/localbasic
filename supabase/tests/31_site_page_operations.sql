-- =============================================================================
-- LOCAL BASIC — 0058 Site Engine page operations and the homepage invariant
--
-- 0055's partial unique index says a site has AT MOST one homepage. This file
-- proves the other half — a site with pages has AT LEAST one, after every
-- committed transaction — and that the four page operations cannot reach a
-- state where it does not.
--
-- ON TESTING A DEFERRED CONSTRAINT
--
-- site_pages_homepage_check is DEFERRABLE INITIALLY DEFERRED, so it fires at
-- COMMIT — after any PL/pgSQL exception handler has stopped listening. A plain
-- `begin ... exception when others` around a homepage-destroying write would
-- therefore catch nothing and the assertion would pass for the wrong reason.
--
-- `set constraints all immediate` forces the pending checks to run at that
-- point instead, inside the subtransaction, where the handler can see them.
-- Every case below that expects a DEFERRED refusal says so and uses it; the
-- cases that expect an immediate refusal (a RAISE inside a function, a BEFORE
-- trigger, a permission check) use an ordinary handler.
--
--   1  deleting the only page is refused
--   2  homepage + one page: deleting the homepage promotes the other
--   3  homepage + several: the replacement is deterministic, others unchanged
--   4  deleting a normal page leaves the homepage alone
--   5  reordering never changes which page is the homepage
--   6  a created page is never the homepage
--   7  renaming cannot alter site, ownership or homepage status
--   8  cross-SITE page mutation is refused
--   9  cross-ORGANIZATION page mutation is refused
--  10  a member without site.manage cannot create, rename, reorder or delete
--  11  site.read alone reads but does not mutate
--  12  anon is refused everywhere
--  13  a failed reorder leaves the order identical
--  14  a failed homepage deletion leaves the homepage unchanged
--  15  deleting a page removes its sections and orphans none
--  16  site settings survive page deletion untouched
--  17  the real FK delete actions, read from the catalog rather than assumed
--  18  no intermediate state can be committed
--
-- Run with:  psql -v ON_ERROR_STOP=1 -f supabase/tests/31_site_page_operations.sql
-- =============================================================================

\set ON_ERROR_STOP on

do $$
declare
  u_owner uuid; u_reader uuid; u_none uuid; u_other uuid;
  org uuid; org_b uuid; br uuid; m uuid; r uuid;
  site uuid; site2 uuid; site_b uuid;
  home uuid; p_a uuid; p_b uuid; p_c uuid; other_home uuid; b_home uuid;
  solo uuid; solo_home uuid; duo uuid; duo_home uuid; duo_other uuid;
  v_id uuid; v_home uuid; v_new uuid; v_order text[]; v_before text[];
  ok boolean; n int; v_state text; v_action char;
begin
  -- ── Fixture ───────────────────────────────────────────────────────────────
  perform auth.as_admin();
  insert into auth.users (email) values ('pg-owner@test.local')  returning id into u_owner;
  insert into auth.users (email) values ('pg-reader@test.local') returning id into u_reader;
  insert into auth.users (email) values ('pg-none@test.local')   returning id into u_none;
  insert into auth.users (email) values ('pg-other@test.local')  returning id into u_other;

  perform auth.login_as(u_owner);
  select out_organization_id, out_branch_id into org, br
    from public.provision_workspace('PG Alpha', 'pgalpha', 'restaurant');
  perform auth.login_as(u_other);
  select out_organization_id into org_b
    from public.provision_workspace('PG Beta', 'pgbeta', 'restaurant');

  perform auth.as_admin();
  insert into public.organization_members (organization_id, user_id, status, all_branches)
       values (org, u_reader, 'active', true) returning id into m;
  insert into public.roles (organization_id, key, name_ar, name_en, description)
       values (org, 'pg_reader', 'قارئ', 'Reader', 'test') returning id into r;
  insert into public.role_permissions (role_id, permission_key) values (r, 'site.read');
  insert into public.user_roles (member_id, role_id) values (m, r);

  insert into public.organization_members (organization_id, user_id, status, all_branches)
       values (org, u_none, 'active', true) returning id into m;
  insert into public.roles (organization_id, key, name_ar, name_en, description)
       values (org, 'pg_none', 'موظف', 'Staff', 'test') returning id into r;
  insert into public.role_permissions (role_id, permission_key) values (r, 'customer.read');
  insert into public.user_roles (member_id, role_id) values (m, r);

  perform auth.login_as(u_owner);
  select public.site_provision(org, 'Alpha Site', 'alpha-site') into site;
  select id into home from public.site_pages where site_id = site and is_homepage;
  select public.site_page_create(site, 'من نحن',  'about')    into p_a;
  select public.site_page_create(site, 'الخدمات', 'services') into p_b;
  select public.site_page_create(site, 'تواصل',   'contact')  into p_c;

  insert into public.site_sections (page_id, section_type, content, sort_order)
       values (home, 'hero',  '{"title":"مرحبا"}'::jsonb, 0),
              (home, 'about', '{"title":"عنّا"}'::jsonb, 1),
              (p_a,  'about', '{"title":"من نحن"}'::jsonb, 0);

  select public.site_provision(org, 'Second Site', 'second-site') into site2;
  select id into other_home from public.site_pages where site_id = site2 and is_homepage;

  perform auth.login_as(u_other);
  select public.site_provision(org_b, 'Beta Site', 'beta-site') into site_b;
  select id into b_home from public.site_pages where site_id = site_b and is_homepage;
  perform auth.login_as(u_owner);

  -- ── 17. The real foreign keys ─────────────────────────────────────────────
  select confdeltype into v_action from pg_constraint where conname = 'site_sections_page_id_fkey';
  assert v_action = 'c', 'site_sections.page_id should CASCADE, found ' || v_action;
  select confdeltype into v_action from pg_constraint where conname = 'site_pages_site_id_fkey';
  assert v_action = 'c', 'site_pages.site_id should CASCADE, found ' || v_action;
  select confdeltype into v_action from pg_constraint where conname = 'site_settings_site_id_fkey';
  assert v_action = 'c', 'site_settings.site_id should CASCADE, found ' || v_action;
  -- Nothing but sections hangs off a page, so the cascade story is complete.
  assert not exists (
    select 1 from pg_constraint
     where contype = 'f' and confrelid = 'public.site_pages'::regclass
       and conrelid <> 'public.site_sections'::regclass
  ), 'an unexpected table references site_pages';
  raise notice 'OK 17 FK actions read from the catalog: sections cascade, settings are site-scoped';

  -- ── 6. A created page is never the homepage ───────────────────────────────
  select count(*) filter (where is_homepage) into n
    from public.site_pages where site_id = site;
  assert n = 1, 'the fixture site should have exactly one homepage, found ' || n;
  select count(*) into n from public.site_pages
   where id in (p_a, p_b, p_c) and is_homepage;
  assert n = 0, 'a created page became the homepage';

  select array_agg(slug::text order by sort_order, id) into v_order
    from public.site_pages where site_id = site;
  assert v_order = array['home','about','services','contact'],
    'created pages are not appended in order: ' || v_order::text;
  raise notice 'OK 6  a created page is never the homepage, and is appended last';

  -- ── 5. Reordering moves positions, never homepage identity ────────────────
  n := public.site_pages_reorder(site, array[p_c, p_a, home, p_b]);
  assert n = 4, 'reorder reported ' || n;

  select array_agg(slug::text order by sort_order, id) into v_order
    from public.site_pages where site_id = site;
  assert v_order = array['contact','about','home','services'],
    'the new order was not applied: ' || v_order::text;
  select count(distinct sort_order) into n from public.site_pages where site_id = site;
  assert n = 4, 'reorder produced duplicate positions';
  select id into v_new from public.site_pages where site_id = site and is_homepage;
  assert v_new = home, 'reordering changed which page is the homepage';
  select count(*) into n from public.site_pages
   where site_id = site2 and is_homepage and sort_order = 0;
  assert n = 1, 'reordering one site disturbed another';
  raise notice 'OK 5  reordering changes positions only, never homepage identity';

  perform public.site_pages_reorder(site, array[home, p_a, p_b, p_c]);

  -- ── 13. A failed reorder leaves the order identical ───────────────────────
  select array_agg(slug::text order by sort_order, id) into v_before
    from public.site_pages where site_id = site;

  v_state := null;
  begin perform public.site_pages_reorder(site, array[home, p_a, p_b]);
  exception when others then v_state := sqlstate; end;
  assert v_state = '22023', 'reorder accepted a partial list (' || coalesce(v_state,'none') || ')';

  v_state := null;
  begin perform public.site_pages_reorder(site, array[home, home, p_a, p_b]);
  exception when others then v_state := sqlstate; end;
  assert v_state = '22023', 'reorder accepted a duplicate (' || coalesce(v_state,'none') || ')';

  -- A page of the OTHER site in this same organization: the caller may manage
  -- both, so only the permutation check can refuse this.
  v_state := null;
  begin perform public.site_pages_reorder(site, array[home, p_a, p_b, other_home]);
  exception when others then v_state := sqlstate; end;
  assert v_state = '22023', 'reorder accepted a page of another site (' || coalesce(v_state,'none') || ')';

  v_state := null;
  begin perform public.site_pages_reorder(site, array[home, p_a, p_b, gen_random_uuid()]);
  exception when others then v_state := sqlstate; end;
  assert v_state = '22023', 'reorder accepted an unknown id (' || coalesce(v_state,'none') || ')';

  select array_agg(slug::text order by sort_order, id) into v_order
    from public.site_pages where site_id = site;
  assert v_order = v_before, 'a refused reorder changed the order: ' || v_order::text;
  raise notice 'OK 13 a refused reorder leaves the previous order identical';

  -- ── 7. Renaming touches the title and nothing else ────────────────────────
  update public.site_pages set title = 'من نحن (محدّث)' where id = p_a;
  get diagnostics n = row_count;
  assert n = 1, 'a rename was refused';
  select count(*) into n from public.site_pages
   where id = p_a and site_id = site and not is_homepage and sort_order = 1;
  assert n = 1, 'a rename changed the page''s site, homepage flag or position';

  -- Re-parenting to another site is refused by the identity trigger, even
  -- though the caller manages both sites.
  v_state := null;
  begin update public.site_pages set site_id = site2 where id = p_a;
  exception when others then v_state := sqlstate; end;
  assert v_state = '22023', 'a page was moved to another site (' || coalesce(v_state,'none') || ')';
  select count(*) into n from public.site_pages where id = p_a and site_id = site;
  assert n = 1, 'the page left its site despite the refusal';
  raise notice 'OK 7  renaming changes the title only; a page cannot change site';

  -- ── 8. Cross-site mutation through the RPCs ───────────────────────────────
  -- other_home belongs to site2. Deleting it "as part of" site is not a thing
  -- the API can express — the function reads the page's own site — so the
  -- cross-site case that matters is the reorder above plus this direct check.
  select site_id into v_id from public.site_pages where id = other_home;
  assert v_id = site2, 'fixture drift: other_home is not on site2';
  raise notice 'OK 8  cross-site page mutation is refused';

  -- ── 18 + 14. No intermediate state can be committed ───────────────────────
  -- Clearing the homepage flag with nothing to replace it is accepted by every
  -- statement-level rule: the partial unique index is satisfied by zero
  -- homepages, and the update policy passes. Only the deferred constraint
  -- refuses it, and only at commit — which is what `set constraints all
  -- immediate` brings forward so the handler can observe it.
  select id into v_home from public.site_pages where site_id = site and is_homepage;
  v_state := null;
  begin
    update public.site_pages set is_homepage = false where id = home;
    set constraints all immediate;
  exception when others then v_state := sqlstate; end;
  set constraints all deferred;
  assert v_state = '23514',
    'a site was left with no homepage (' || coalesce(v_state, 'none') || ')';

  select id into v_new from public.site_pages where site_id = site and is_homepage;
  assert v_new = v_home, 'the homepage changed after a refused clear';

  -- And deleting the homepage row directly, without promoting anything.
  v_state := null;
  begin
    delete from public.site_pages where id = home;
    set constraints all immediate;
  exception when others then v_state := sqlstate; end;
  set constraints all deferred;
  assert v_state = '23514',
    'the homepage was deleted with no replacement (' || coalesce(v_state,'none') || ')';

  select count(*) into n from public.site_pages where id = home and is_homepage;
  assert n = 1, 'the homepage did not survive a refused deletion';
  select count(*) into n from public.site_pages where site_id = site;
  assert n = 4, 'the refused deletion changed how many pages the site has';
  raise notice 'OK 18 a transaction cannot commit a site with zero homepages';
  raise notice 'OK 14 a refused homepage deletion leaves the homepage unchanged';

  -- ── 4 + 15 + 16. Deleting a normal page ───────────────────────────────────
  select count(*) into n from public.site_sections where page_id = p_a;
  assert n = 1, 'fixture drift: p_a should carry one section';

  select public.site_page_delete(p_a) into v_new;
  assert v_new is null, 'deleting a normal page promoted something';

  select count(*) into n from public.site_pages where id = p_a;
  assert n = 0, 'the page was not deleted';
  select count(*) into n from public.site_sections where page_id = p_a;
  assert n = 0, 'the page''s sections outlived it';
  -- No orphans anywhere: every section still points at a page that exists.
  assert not exists (
    select 1 from public.site_sections s
     where not exists (select 1 from public.site_pages p where p.id = s.page_id)
  ), 'an orphaned section survived a page deletion';

  select id into v_new from public.site_pages where site_id = site and is_homepage;
  assert v_new = home, 'deleting a normal page moved the homepage';
  select count(*) into n from public.site_sections where page_id = home;
  assert n = 2, 'the homepage lost sections when another page was deleted';

  select count(*) into n from public.site_settings where site_id = site;
  assert n = 1, 'the site settings row was affected by a page deletion';
  select count(*) into n from public.site_settings
   where site_id = site and settings ? 'locale';
  assert n = 1, 'the site settings content was altered by a page deletion';

  -- Remaining pages compacted to 0..n-1.
  select array_agg(sort_order order by sort_order) into v_order
    from (select sort_order from public.site_pages where site_id = site) x;
  select count(*) into n from public.site_pages where site_id = site;
  assert n = 3, 'wrong page count after deletion';
  select count(*) into n from public.site_pages
   where site_id = site and sort_order between 0 and 2;
  assert n = 3, 'positions were not compacted after deletion';
  raise notice 'OK 4  deleting a normal page leaves the homepage alone';
  raise notice 'OK 15 a deleted page takes its sections and orphans none';
  raise notice 'OK 16 site settings are untouched by page deletion';

  -- ── 3. Deleting the homepage promotes the NEXT page, deterministically ────
  -- Order is now: home(0), services(1), contact(2).
  select public.site_page_delete(home) into v_new;
  assert v_new = p_b, 'the promoted page should be the next by sort_order';

  select count(*) filter (where is_homepage) into n
    from public.site_pages where site_id = site;
  assert n = 1, 'the site has ' || n || ' homepages after promotion';
  select id into v_home from public.site_pages where site_id = site and is_homepage;
  assert v_home = p_b, 'the wrong page was promoted';

  -- The page that was NOT promoted is otherwise unchanged.
  select count(*) into n from public.site_pages
   where id = p_c and not is_homepage and site_id = site;
  assert n = 1, 'an unrelated page was altered by the promotion';
  select count(*) into n from public.site_sections where page_id = home;
  assert n = 0, 'the deleted homepage''s sections survived';
  raise notice 'OK 3  the next page by sort_order is promoted; others are unchanged';

  -- ── 2. Homepage + exactly one other page ──────────────────────────────────
  select public.site_provision(org, 'Duo Site', 'duo-site') into duo;
  select id into duo_home from public.site_pages where site_id = duo and is_homepage;
  select public.site_page_create(duo, 'ثانية', 'second') into duo_other;

  select public.site_page_delete(duo_home) into v_new;
  assert v_new = duo_other, 'the only other page was not promoted';
  select count(*) filter (where is_homepage) into n
    from public.site_pages where site_id = duo;
  assert n = 1, 'the two-page site has ' || n || ' homepages';
  select count(*) into n from public.site_pages where site_id = duo;
  assert n = 1, 'the two-page site has ' || n || ' pages';
  raise notice 'OK 2  deleting the homepage of a two-page site promotes the other';

  -- ── 1. Deleting the only page is refused ──────────────────────────────────
  v_state := null;
  begin perform public.site_page_delete(duo_other);
  exception when others then v_state := sqlstate; end;
  assert v_state = '23514',
    'the only page of a site was deleted (' || coalesce(v_state,'none') || ')';
  select count(*) into n from public.site_pages where site_id = duo and is_homepage;
  assert n = 1, 'the last page did not survive its refused deletion';
  raise notice 'OK 1  a site''s only page cannot be deleted';

  -- Promotion when the homepage is LAST falls back to the previous page.
  select public.site_provision(org, 'Tail Site', 'tail-site') into solo;
  select id into solo_home from public.site_pages where site_id = solo and is_homepage;
  select public.site_page_create(solo, 'أخرى', 'other') into v_id;
  -- Put the homepage at the end.
  perform public.site_pages_reorder(solo, array[v_id, solo_home]);
  select public.site_page_delete(solo_home) into v_new;
  assert v_new = v_id, 'a trailing homepage did not fall back to the previous page';
  raise notice 'OK 3b a trailing homepage falls back to the previous page';

  -- ── 9. Cross-organization ─────────────────────────────────────────────────
  perform auth.login_as(u_other);
  -- Reads nothing.
  select count(*) into n from public.site_pages where site_id = site;
  assert n = 0, 'another organization can see these pages';

  -- Writes nothing. RLS filters rather than raising, so row counts are the
  -- assertion; the RPCs raise because their permission check fails.
  update public.site_pages set title = 'Stolen' where id = p_c;
  get diagnostics n = row_count;
  assert n = 0, 'another organization renamed a page';

  v_state := null;
  begin perform public.site_page_create(site, 'Intruder', 'intruder');
  exception when others then v_state := sqlstate; end;
  assert v_state = '42501', 'another organization created a page (' || coalesce(v_state,'none') || ')';

  v_state := null;
  begin perform public.site_page_delete(p_c);
  exception when others then v_state := sqlstate; end;
  assert v_state = '42501', 'another organization deleted a page (' || coalesce(v_state,'none') || ')';

  v_state := null;
  begin perform public.site_pages_reorder(site, array[p_b, p_c]);
  exception when others then v_state := sqlstate; end;
  assert v_state = '42501', 'another organization reordered a site (' || coalesce(v_state,'none') || ')';

  -- Checked as admin: asking while still logged in as the other organization
  -- would count zero because RLS hides the row, which proves nothing about
  -- whether it still exists.
  perform auth.as_admin();
  select count(*) into n from public.site_pages where id = p_c;
  assert n = 1, 'the page did not survive the cross-organization attempts';
  raise notice 'OK 9  cross-organization page mutation is refused';

  -- ── 10 + 11. Permissions inside the owning organization ───────────────────
  perform auth.login_as(u_reader);
  -- site.read alone: reads.
  select count(*) into n from public.site_pages where site_id = site;
  assert n = 2, 'site.read cannot see the pages it should (' || n || ')';

  -- and does not mutate.
  update public.site_pages set title = 'Reader edit' where id = p_c;
  get diagnostics n = row_count;
  assert n = 0, 'site.read renamed a page';

  v_state := null;
  begin perform public.site_page_create(site, 'Reader page', 'readerpage');
  exception when others then v_state := sqlstate; end;
  assert v_state = '42501', 'site.read created a page (' || coalesce(v_state,'none') || ')';

  v_state := null;
  begin perform public.site_page_delete(p_c);
  exception when others then v_state := sqlstate; end;
  assert v_state = '42501', 'site.read deleted a page (' || coalesce(v_state,'none') || ')';

  v_state := null;
  begin perform public.site_pages_reorder(site, array[p_b, p_c]);
  exception when others then v_state := sqlstate; end;
  assert v_state = '42501', 'site.read reordered a site (' || coalesce(v_state,'none') || ')';
  raise notice 'OK 11 site.read reads and cannot mutate';

  -- A member with neither permission sees nothing and does nothing.
  perform auth.login_as(u_none);
  select count(*) into n from public.site_pages where site_id = site;
  assert n = 0, 'a member without site.read can see pages';

  update public.site_pages set title = 'Staff edit' where id = p_c;
  get diagnostics n = row_count;
  assert n = 0, 'a member without site.manage renamed a page';

  v_state := null;
  begin perform public.site_page_create(site, 'Staff page', 'staffpage');
  exception when others then v_state := sqlstate; end;
  assert v_state = '42501', 'a member without site.manage created a page';

  v_state := null;
  begin perform public.site_page_delete(p_c);
  exception when others then v_state := sqlstate; end;
  assert v_state = '42501', 'a member without site.manage deleted a page';

  v_state := null;
  begin perform public.site_pages_reorder(site, array[p_b, p_c]);
  exception when others then v_state := sqlstate; end;
  assert v_state = '42501', 'a member without site.manage reordered a site';
  raise notice 'OK 10 a member without site.manage cannot create, rename, reorder or delete';

  -- ── 12. Anonymous ─────────────────────────────────────────────────────────
  perform auth.logout();
  -- 0055 revokes every privilege on site_pages from anon, so this is refused
  -- outright rather than filtered to zero rows. Asserting on a count would
  -- have been the weaker claim.
  v_state := null;
  begin select count(*) into n from public.site_pages;
  exception when others then v_state := sqlstate; end;
  assert v_state = '42501', 'anon could read site_pages (' || coalesce(v_state,'none') || ')';

  v_state := null;
  begin perform public.site_page_create(site, 'Anon page', 'anonpage');
  exception when others then v_state := sqlstate; end;
  assert v_state in ('42501','42P01'), 'anon created a page (' || coalesce(v_state,'none') || ')';

  v_state := null;
  begin perform public.site_page_delete(p_c);
  exception when others then v_state := sqlstate; end;
  assert v_state in ('42501','42P01'), 'anon deleted a page (' || coalesce(v_state,'none') || ')';

  v_state := null;
  begin perform public.site_pages_reorder(site, array[p_b, p_c]);
  exception when others then v_state := sqlstate; end;
  assert v_state in ('42501','42P01'), 'anon reordered a site (' || coalesce(v_state,'none') || ')';
  raise notice 'OK 12 anon reads nothing and writes nothing';

  -- ── Final state: every site still satisfies the invariant ─────────────────
  perform auth.as_admin();
  assert not exists (
    select 1 from public.sites s
     where exists (select 1 from public.site_pages p where p.site_id = s.id)
       and (select count(*) filter (where is_homepage)
              from public.site_pages p where p.site_id = s.id) <> 1
  ), 'some site ended the run without exactly one homepage';

  raise notice '';
  raise notice 'SITE PAGE OPERATIONS: all assertions passed';
end $$;
