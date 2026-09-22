-- =============================================================================
-- LOCAL BASIC — 0058 Site Engine page operations
--
-- 0055 created site_pages with a partial unique index:
--
--     create unique index site_pages_one_homepage
--       on public.site_pages(site_id) where is_homepage;
--
-- That index says AT MOST ONE homepage. It says nothing about at least one: a
-- site whose only homepage is deleted, or whose is_homepage is simply set to
-- false, satisfies it perfectly and has no homepage at all. The renderer then
-- falls back to `pages[0]`, so the site does not break — it silently stops
-- being the site its owner arranged.
--
-- Page operations are what make that reachable, so they arrive together with
-- the enforcement.
--
-- WHY A DEFERRED CONSTRAINT TRIGGER
--
-- The invariant is legitimately false in the middle of a correct transaction.
-- Deleting a homepage and promoting its replacement cannot be one statement,
-- and between the two the site has zero homepages. An immediate trigger would
-- reject the correct operation; a CHECK constraint cannot see other rows at
-- all. DEFERRABLE INITIALLY DEFERRED is the mechanism that matches the shape
-- of the problem: the invariant is asserted once, at COMMIT, against whatever
-- the transaction finally settled on.
--
-- WHY THAT ONE FUNCTION IS SECURITY DEFINER
--
-- Every other function here is SECURITY INVOKER, matching site_provision() and
-- site_sections_reorder(): they are conveniences, never a way around RLS.
--
-- app.assert_site_homepage() cannot be, because it has to COUNT a site's pages
-- and site_pages' select policy requires `site.read` — a permission the
-- catalog keeps separate from `site.manage`. Under invoker rights the count
-- would be the WRITER'S VIEW of the site rather than the site, and a check
-- that measures a view cannot assert a fact.
--
-- Today invoker rights would happen to give the right answer, and it is worth
-- being precise about why that is not good enough. PostgreSQL applies SELECT
-- policies to the rows an UPDATE or DELETE locates through a WHERE clause, so
-- a caller holding site.manage without site.read cannot mutate a page at all —
-- their statements match zero rows. The invariant therefore survives, but only
-- as a side effect of two policies lining up, in a way nothing states and no
-- test could reasonably pin. Grant site.read more broadly, or add a permissive
-- select policy, and the check would start silently passing for exactly the
-- caller most able to break it. An integrity check whose correctness depends
-- on the writer's read permissions is one policy change away from being
-- decorative.
--
-- This is not a new dependency. app.has_permission(), app.site_can_manage()
-- and every other helper the policies call is already SECURITY DEFINER reading
-- organization_members, user_roles and role_permissions, all of which carry
-- FORCE RLS — the entire RBAC system rests on the same mechanism.
--
-- It is safe to elevate because of what it does with the rights: it reads two
-- integers, compares them, and returns NULL. It selects no user data, returns
-- no rows, writes nothing, and takes no argument — there is no value a caller
-- can supply to steer it. `set search_path = ''` is set, as everywhere else in
-- this schema, so every name it touches is schema-qualified and none can be
-- captured. It constrains writes; it does not authorize them.
--
-- SCOPE. This migration adds page operations and the homepage invariant. It
-- changes no existing table, column, policy, grant or permission.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. A page never moves between sites.
--
-- site_pages_update carries USING and WITH CHECK, both app.site_can_manage(
-- site_id), so a page cannot be pushed into another ORGANIZATION's site. It
-- can still be moved between two sites of the same organization, which
-- scrambles the ordering of both and can leave one of them with two homepages
-- or none. Same class of hole 0056 closed for sites.organization_id, closed
-- the same way and for the same reason: the policy decides whether a row may
-- be written, not what the row may claim to be.
-- ---------------------------------------------------------------------------
create or replace function app.check_site_page_identity()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.site_id <> old.site_id then
    raise exception 'a page cannot be moved to another site' using errcode = '22023';
  end if;
  -- A fact about the row, not a field. Preserved silently rather than refused,
  -- so a caller echoing it back unchanged does not fail.
  new.created_at := old.created_at;
  return new;
end;
$$;

create trigger site_pages_identity
  before update on public.site_pages
  for each row execute function app.check_site_page_identity();

-- ---------------------------------------------------------------------------
-- 2. The homepage invariant.
--
-- Stated as: a site that has pages has exactly one homepage.
--
-- Deliberately conditioned on having pages. A site with none is not left
-- reachable by anything here — site_provision() creates its homepage in the
-- same transaction as the site, and site_page_delete() refuses to remove the
-- last page — and making zero pages an error as well would turn a bare
-- `insert into sites` into a constraint violation, which is a decision about
-- site creation rather than about page operations.
--
-- Fires on DELETE as well as INSERT and UPDATE, so a site cascading away does
-- not trip it: the first thing the check does is ask whether the site is still
-- there.
-- ---------------------------------------------------------------------------
create or replace function app.assert_site_homepage()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_site  uuid;
  v_pages int;
  v_home  int;
begin
  -- NEW is unset on DELETE; TG_OP rather than coalesce, so this reads as what
  -- it is instead of relying on a null.
  if tg_op = 'DELETE' then v_site := old.site_id; else v_site := new.site_id; end if;

  -- The site itself was deleted and took its pages with it. Nothing to assert:
  -- an invariant about a site's pages says nothing about a site that is gone.
  if not exists (select 1 from public.sites where id = v_site) then
    return null;
  end if;

  select count(*), count(*) filter (where is_homepage)
    into v_pages, v_home
    from public.site_pages where site_id = v_site;

  if v_pages > 0 and v_home <> 1 then
    raise exception 'a site must have exactly one homepage (found %)', v_home
      using errcode = '23514';
  end if;

  return null;
end;
$$;

-- AFTER, not BEFORE: the rows have to be in their final state to be counted.
-- FOR EACH ROW because a constraint trigger cannot be a statement trigger; the
-- checks a multi-row reorder queues are identical and collapse to the same
-- answer at commit.
create constraint trigger site_pages_homepage_check
  after insert or update or delete on public.site_pages
  deferrable initially deferred
  for each row execute function app.assert_site_homepage();

-- ---------------------------------------------------------------------------
-- 3. Creating a page.
--
-- is_homepage is written as FALSE here and is not a parameter. A site has a
-- homepage from the moment site_provision() creates it, so "create a page"
-- never means "create the homepage" — and letting a caller pass the flag would
-- make every new page a chance to take the homepage away from the page that
-- has it, which is a different operation with a different confirmation.
--
-- sort_order is computed rather than accepted, in the same statement that
-- inserts, so two pages created at once cannot both read the same maximum.
-- ---------------------------------------------------------------------------
create or replace function public.site_page_create(
  p_site  uuid,
  p_title text,
  p_slug  text
) returns uuid language plpgsql security invoker set search_path = '' as $$
declare v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;
  if not app.site_can_manage(p_site) then
    raise exception 'site.manage required' using errcode = 'insufficient_privilege';
  end if;

  insert into public.site_pages (site_id, title, slug, is_homepage, sort_order)
  select p_site, p_title, p_slug, false,
         least(coalesce(max(sort_order) + 1, 0), 9999)
    from public.site_pages where site_id = p_site
  returning id into v_id;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Reordering a site's pages.
--
-- The same strict permutation site_sections_reorder() uses, for the same
-- reason: the array must be every page of the site, each exactly once, so a
-- partial or inconsistent order is unrepresentable rather than merely
-- unlikely. A refusal raises, so nothing is applied.
--
-- is_homepage is never touched. Which page is the homepage and where it sits
-- in the menu are separate facts, and moving it to the end of the navigation
-- does not stop it being the page the site opens on.
-- ---------------------------------------------------------------------------
create or replace function public.site_pages_reorder(p_site uuid, p_ids uuid[])
returns int language plpgsql security invoker set search_path = '' as $$
declare
  v_len   int := coalesce(array_length(p_ids, 1), 0);
  v_uniq  int;
  v_total int;
  v_match int;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;
  if not app.site_can_manage(p_site) then
    raise exception 'site.manage required' using errcode = 'insufficient_privilege';
  end if;

  select count(distinct x) into v_uniq from unnest(p_ids) as x;
  if v_uniq <> v_len then
    raise exception 'a page may appear only once in the order' using errcode = '22023';
  end if;

  select count(*) into v_total from public.site_pages where site_id = p_site;
  select count(*) into v_match
    from public.site_pages where site_id = p_site and id = any (p_ids);

  -- Counted against the site, so an id belonging to another site and an id
  -- that does not exist fail identically. Telling them apart would confirm
  -- that some other site owns that page.
  if v_match <> v_len then
    raise exception 'every page in the order must belong to this site'
      using errcode = '22023';
  end if;
  if v_match <> v_total then
    raise exception 'the order must list every page of this site'
      using errcode = '22023';
  end if;

  update public.site_pages s
     set sort_order = t.pos - 1
    from unnest(p_ids) with ordinality as t(id, pos)
   where s.id = t.id and s.site_id = p_site;

  return v_total;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Deleting a page.
--
-- Sections go with it: site_sections.page_id references site_pages ON DELETE
-- CASCADE, so no statement here needs to remove them and none can leave one
-- orphaned. site_settings references the SITE, not the page, and is untouched.
--
-- Deleting the homepage promotes a replacement, chosen deterministically:
-- the NEXT page in (sort_order, id) — the same order every list uses — and the
-- PREVIOUS one when the homepage is last. Never an arbitrary row, so the same
-- deletion on the same data always promotes the same page.
--
-- The last page cannot be deleted. Not because the cascade would be unsafe,
-- but because a site with no pages has nothing to render and nothing to
-- promote, and quietly creating a replacement page to satisfy the invariant
-- would be inventing content nobody asked for.
--
-- The delete happens BEFORE the promotion, which the deferred constraint is
-- what makes legal: between the two statements the site has zero homepages,
-- and at COMMIT it has exactly one. Doing it the other way round would mean
-- clearing the old flag first anyway — the partial unique index forbids two
-- homepages at every statement boundary — so this is the same operation in
-- one statement fewer, not a weaker one.
--
-- Remaining pages are compacted to 0..n-1. Gaps would render identically,
-- since every read orders by (sort_order, id), but they make the next
-- site_page_create()'s max + 1 drift upward toward the 9999 ceiling for no
-- reason.
-- ---------------------------------------------------------------------------
create or replace function public.site_page_delete(p_page uuid)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  v_site  uuid;
  v_home  boolean;
  v_order int;
  v_total int;
  v_new   uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;
  -- Checked before the row is read, so a caller holding site.manage without
  -- site.read gets "page not found" rather than a permission error that would
  -- confirm the page exists.
  if not app.site_page_can_manage(p_page) then
    raise exception 'site.manage required' using errcode = 'insufficient_privilege';
  end if;

  select site_id, is_homepage, sort_order
    into v_site, v_home, v_order
    from public.site_pages where id = p_page;
  if v_site is null then
    raise exception 'page not found' using errcode = '22023';
  end if;

  select count(*) into v_total from public.site_pages where site_id = v_site;
  if v_total <= 1 then
    raise exception 'a site must keep at least one page' using errcode = '23514';
  end if;

  if v_home then
    select id into v_new from public.site_pages
      where site_id = v_site and (sort_order, id) > (v_order, p_page)
      order by sort_order, id limit 1;

    if v_new is null then
      select id into v_new from public.site_pages
        where site_id = v_site and (sort_order, id) < (v_order, p_page)
        order by sort_order desc, id desc limit 1;
    end if;

    -- v_total > 1 guarantees one exists; the check is here so a future change
    -- to that guard fails loudly instead of committing a homepage-less site.
    if v_new is null then
      raise exception 'no replacement homepage available' using errcode = '23514';
    end if;
  end if;

  delete from public.site_pages where id = p_page;

  if v_new is not null then
    update public.site_pages set is_homepage = true where id = v_new;
  end if;

  update public.site_pages s
     set sort_order = t.pos - 1
    from (
      select id, row_number() over (order by sort_order, id) as pos
        from public.site_pages where site_id = v_site
    ) t
   where s.id = t.id and s.site_id = v_site and s.sort_order <> t.pos - 1;

  return v_new;
end;
$$;

revoke all on function public.site_page_create(uuid, text, text)   from public, anon;
revoke all on function public.site_pages_reorder(uuid, uuid[])     from public, anon;
revoke all on function public.site_page_delete(uuid)               from public, anon;
grant execute on function public.site_page_create(uuid, text, text) to authenticated;
grant execute on function public.site_pages_reorder(uuid, uuid[])   to authenticated;
grant execute on function public.site_page_delete(uuid)             to authenticated;
