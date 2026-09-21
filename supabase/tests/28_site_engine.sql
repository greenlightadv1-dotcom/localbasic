-- =============================================================================
-- LOCAL BASIC — Site Engine suite (0055)
--
-- A site belongs to one user. The whole security model rests on that single
-- sentence, so this suite tries to break it from the outside rather than
-- confirming it from the inside.
--
-- What has to hold:
--
--   1. A user sees only their own sites, pages, sections and settings.
--   2. A user cannot read another user's rows even knowing the primary key.
--   3. A user cannot WRITE into another user's site — not a page, not a
--      section, not settings — and cannot re-parent their own row into it.
--   4. A user cannot forge ownership by inserting a site with someone else's
--      user_id.
--   5. anon sees nothing and can write nothing.
--   6. The structural guarantees hold: one homepage per site, one settings row
--      per site, unique slug per owner, closed section-type list.
--   7. site_provision() creates site + homepage + settings atomically, and
--      runs as the caller rather than around them.
--   8. Deleting a site takes its pages, sections and settings with it.
--
-- Run with:  psql -v ON_ERROR_STOP=1 -f supabase/tests/28_site_engine.sql
-- =============================================================================

\set ON_ERROR_STOP on

do $$
declare
  u_a uuid; u_b uuid;
  site_a uuid; site_b uuid;
  page_a uuid; page_b uuid;
  sec_a uuid;
  ok boolean; n int;
begin
  perform auth.as_admin();
  insert into auth.users (email) values ('site-a@test.local') returning id into u_a;
  insert into auth.users (email) values ('site-b@test.local') returning id into u_b;

  -- ── 7. Provisioning ───────────────────────────────────────────────────────
  perform auth.login_as(u_a);
  select public.site_provision('Alpha Site', 'alpha-site') into site_a;

  select count(*) into n from public.site_pages where site_id = site_a;
  assert n = 1, 'provision should create exactly one page, found ' || n;

  select count(*) into n from public.site_pages
   where site_id = site_a and is_homepage and slug = 'home';
  assert n = 1, 'provision should create a homepage';

  select count(*) into n from public.site_settings where site_id = site_a;
  assert n = 1, 'provision should create exactly one settings row';

  select id into page_a from public.site_pages where site_id = site_a;
  insert into public.site_sections (page_id, section_type, content, sort_order)
       values (page_a, 'hero', '{"title":"مرحبا"}'::jsonb, 0)
    returning id into sec_a;
  raise notice 'OK 7  site_provision creates site + homepage + settings atomically';

  perform auth.login_as(u_b);
  select public.site_provision('Beta Site', 'beta-site') into site_b;
  select id into page_b from public.site_pages where site_id = site_b;
  raise notice 'OK 1a each user provisions independently';

  -- ── 1/2. Read isolation ───────────────────────────────────────────────────
  -- B is logged in. A's rows must be invisible even by primary key.
  select count(*) into n from public.sites where id = site_a;
  assert n = 0, 'B can see A''s site';

  select count(*) into n from public.site_pages where id = page_a;
  assert n = 0, 'B can see A''s page';

  select count(*) into n from public.site_sections where id = sec_a;
  assert n = 0, 'B can see A''s section';

  select count(*) into n from public.site_settings where site_id = site_a;
  assert n = 0, 'B can see A''s settings';

  select count(*) into n from public.sites;
  assert n = 1, 'B should see exactly their own site, saw ' || n;
  raise notice 'OK 1/2 a user reads only their own sites, pages, sections and settings';

  -- ── 3. Write isolation ────────────────────────────────────────────────────
  -- Every one of these must be refused. Each is wrapped so the failure is
  -- observed rather than aborting the suite.
  ok := false;
  begin
    insert into public.site_pages (site_id, title, slug)
         values (site_a, 'Injected', 'injected');
  exception when others then ok := true;
  end;
  assert ok, 'B inserted a page into A''s site';

  ok := false;
  begin
    insert into public.site_sections (page_id, section_type, content)
         values (page_a, 'about', '{}'::jsonb);
  exception when others then ok := true;
  end;
  assert ok, 'B inserted a section into A''s page';

  ok := false;
  begin
    insert into public.site_settings (site_id, settings)
         values (site_a, '{"hacked":true}'::jsonb);
  exception when others then ok := true;
  end;
  assert ok, 'B inserted settings for A''s site';

  -- Updates that target A's rows must affect nothing: RLS filters them out of
  -- the UPDATE's scan rather than raising.
  update public.sites set name = 'Stolen' where id = site_a;
  get diagnostics n = row_count;
  assert n = 0, 'B updated A''s site';

  update public.site_sections set content = '{"x":1}'::jsonb where id = sec_a;
  get diagnostics n = row_count;
  assert n = 0, 'B updated A''s section';

  delete from public.sites where id = site_a;
  get diagnostics n = row_count;
  assert n = 0, 'B deleted A''s site';
  raise notice 'OK 3  a user cannot write into another user''s site';

  -- Re-parenting: move B's own page under A's site. The WITH CHECK clause is
  -- what has to catch this; USING alone would let the row escape.
  ok := false;
  begin
    update public.site_pages set site_id = site_a where id = page_b;
    get diagnostics n = row_count;
    if n = 0 then ok := true; end if;
  exception when others then ok := true;
  end;
  assert ok, 'B re-parented their page into A''s site';
  raise notice 'OK 3b a row cannot be re-parented into another user''s site';

  -- ── 4. Forged ownership ───────────────────────────────────────────────────
  ok := false;
  begin
    insert into public.sites (user_id, name, slug) values (u_a, 'Forged', 'forged');
  exception when others then ok := true;
  end;
  assert ok, 'B created a site owned by A';
  raise notice 'OK 4  a site cannot be created under another user''s id';

  -- ── 6. Structural guarantees ──────────────────────────────────────────────
  ok := false;
  begin
    insert into public.site_pages (site_id, title, slug, is_homepage)
         values (site_b, 'Second home', 'second-home', true);
  exception when others then ok := true;
  end;
  assert ok, 'a site accepted two homepages';

  ok := false;
  begin
    insert into public.site_settings (site_id, settings) values (site_b, '{}'::jsonb);
  exception when others then ok := true;
  end;
  assert ok, 'a site accepted two settings rows';

  ok := false;
  begin
    insert into public.sites (user_id, name, slug) values (u_b, 'Dup', 'beta-site');
  exception when others then ok := true;
  end;
  assert ok, 'a user reused their own slug';

  ok := false;
  begin
    insert into public.site_sections (page_id, section_type)
         values (page_b, 'carousel');
  exception when others then ok := true;
  end;
  assert ok, 'an unknown section_type was stored';
  raise notice 'OK 6  one homepage, one settings row, unique slug, closed type list';

  -- Two different users MAY hold the same slug: uniqueness is per owner.
  perform auth.login_as(u_a);
  declare v_dup uuid;
  begin
    select public.site_provision('Beta name, A''s copy', 'beta-site') into v_dup;
    assert v_dup is not null, 'A could not reuse B''s slug';
  end;
  raise notice 'OK 6b slug uniqueness is per owner, not global';

  -- ── 5. anon ───────────────────────────────────────────────────────────────
  perform auth.logout();

  -- anon holds no grant on these tables at all, so a read is refused outright
  -- rather than returning an empty set. That is the stronger of the two
  -- outcomes: the table is not merely filtered, it is unreachable.
  ok := false;
  begin
    select count(*) into n from public.sites;
  exception when insufficient_privilege then ok := true;
  end;
  assert ok, 'anon can reach the sites table';

  ok := false;
  begin
    select count(*) into n from public.site_sections;
  exception when insufficient_privilege then ok := true;
  end;
  assert ok, 'anon can reach the site_sections table';

  ok := false;
  begin
    insert into public.sites (user_id, name, slug) values (u_a, 'Anon', 'anon-site');
  exception when others then ok := true;
  end;
  assert ok, 'anon inserted a site';

  ok := false;
  begin
    perform public.site_provision('Anon', 'anon-two');
  exception when others then ok := true;
  end;
  assert ok, 'anon called site_provision';
  raise notice 'OK 5  anon reads nothing and writes nothing';

  -- ── 8. Cascade ────────────────────────────────────────────────────────────
  perform auth.login_as(u_a);
  delete from public.sites where id = site_a;

  perform auth.as_admin();
  select count(*) into n from public.site_pages where site_id = site_a;
  assert n = 0, 'pages survived their site, ' || n || ' left';
  select count(*) into n from public.site_sections where page_id = page_a;
  assert n = 0, 'sections survived their page';
  select count(*) into n from public.site_settings where site_id = site_a;
  assert n = 0, 'settings survived their site';
  raise notice 'OK 8  deleting a site removes its pages, sections and settings';

  raise notice '';
  raise notice 'SITE ENGINE: all assertions passed';
end $$;
