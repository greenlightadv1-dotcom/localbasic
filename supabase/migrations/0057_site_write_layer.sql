-- =============================================================================
-- LOCAL BASIC — 0057 Site Engine write layer
--
-- 0055 created the tables, 0056 pinned a site's identity. Both assumed the
-- only writer would be site_provision(). Phase 1a adds real edit operations,
-- and two of them cannot be done safely from the application alone:
--
--   1. Reordering a page's sections is a multi-row write. Done as N PostgREST
--      updates it is not atomic, and a failure halfway leaves the page in an
--      order nobody chose — two sections at position 3, none at position 1.
--      It belongs in one statement, in one transaction.
--
--   2. site_sections.content is jsonb with no shape at all. Everything about
--      it is enforced in TypeScript, which is the layer a direct PostgREST
--      write does not pass through.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT VALIDATE
--
-- The Zod schemas in src/modules/sites/sections/content.ts carry per-field
-- length ceilings, nested array item shapes, array caps and per-field
-- fallbacks. None of that is repeated here. Those are presentation
-- tolerances: the renderer already absorbs a violation totally — a too-long
-- string or a malformed array costs that section its content and nothing
-- else — and encoding them in SQL would mean a migration every time a
-- headline's maximum length is reworded. That is schema drift bought with no
-- security.
--
-- What IS enforced here is the part the renderer cannot absorb and a second
-- writer could get wrong:
--
--   * content is a JSON OBJECT. `jsonb not null` permits 'null', '[]' and
--     '"text"'; none of those is a section.
--   * a closed KEY ALLOW-LIST per section type, the convention
--     app.check_website_section() established in 0042. An unknown key is
--     refused rather than ignored, so nothing can be parked in the column for
--     a future renderer to pick up.
--   * ctaHref carries a SAFE SCHEME. This is the only field in the whole
--     Site Engine where a bad value is a security problem rather than a
--     cosmetic one, so it is the only field whose format is duplicated.
--
-- The allow-lists are kept honest by src/modules/sites/sections/drift.test.ts,
-- which parses THIS FILE and asserts the three layers agree — the read
-- schemas, the write schemas and these arrays. A field added to one and
-- forgotten in another fails that test rather than production.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Section content.
--
-- SECURITY INVOKER (the default). The function reads NEW and touches no
-- table, so it needs no elevated rights, and a DEFINER trigger on a FORCE RLS
-- table is a bypass waiting to be found. It constrains the CONTENT of a write;
-- the policies still decide whether the write happens at all.
-- ---------------------------------------------------------------------------
create or replace function app.check_site_section_content()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_allowed text[];
  v_key     text;
  v_href    text;
begin
  if jsonb_typeof(new.content) <> 'object' then
    raise exception 'section content must be an object' using errcode = '22023';
  end if;

  -- Mirrors SECTION_SCHEMAS / SECTION_WRITE_SCHEMAS. Kept in this exact shape
  -- because drift.test.ts parses it.
  v_allowed := case new.section_type
    when 'hero'         then array['title', 'subtitle', 'ctaLabel', 'ctaHref', 'align']
    when 'about'        then array['title', 'body']
    when 'services'     then array['title', 'items']
    when 'testimonials' then array['title', 'items']
    when 'contact'      then array['title', 'phone', 'email', 'address']
    when 'footer'       then array['text']
    -- Unreachable: section_type carries a check constraint listing exactly
    -- these six. Reachable the moment that constraint gains a seventh, and
    -- then an empty allow-list refuses every key rather than waving through
    -- content no renderer has a case for.
    else array[]::text[]
  end;

  for v_key in select jsonb_object_keys(new.content) loop
    if not (v_key = any (v_allowed)) then
      raise exception 'unknown field "%" for a % section', v_key, new.section_type
        using errcode = '22023';
    end if;
  end loop;

  -- The one format worth duplicating. safeHref in content.ts allows a
  -- site-relative path, a mailto: address or a tel: number, and nothing else
  -- — so no stored value can become javascript:, data: or an off-site
  -- redirect, whatever renders it later.
  --
  -- A JSON null is the "no link" case and is accepted. Any other non-string
  -- is not a link at all.
  if new.section_type = 'hero' and new.content ? 'ctaHref'
     and jsonb_typeof(new.content -> 'ctaHref') <> 'null' then
    if jsonb_typeof(new.content -> 'ctaHref') <> 'string' then
      raise exception 'ctaHref must be text or null' using errcode = '22023';
    end if;
    v_href := btrim(new.content ->> 'ctaHref');
    if not (
         -- A path of this site. The second character may not be another
         -- slash (that is a protocol-relative URL) nor a backslash, which
         -- some browsers normalise into one.
         (v_href ~ '^/[^/]' and left(v_href, 2) <> ('/' || chr(92)))
      or v_href ~ '^mailto:[^[:space:]]+@[^[:space:]]+$'
      or v_href ~ '^tel:[+]?[0-9[:space:]-]+$'
    ) then
      raise exception 'unsupported link target for ctaHref' using errcode = '22023';
    end if;
  end if;

  return new;
end;
$$;

create trigger site_sections_content_check
  before insert or update on public.site_sections
  for each row execute function app.check_site_section_content();

-- ---------------------------------------------------------------------------
-- 2. Site settings.
--
-- Object-typed and no further. siteSettingsSchema validates locale, direction,
-- template id and four hex colours, every one of them with a fallback the
-- renderer applies on read before a value can reach a style attribute. There
-- is no path by which a malformed settings row becomes unsafe, so pinning the
-- palette's format in SQL would buy drift and nothing else. The object check
-- is worth having because 'null'::jsonb and '[]'::jsonb are not settings and
-- would make every reader's `?? {}` a lie.
-- ---------------------------------------------------------------------------
create or replace function app.check_site_settings()
returns trigger language plpgsql set search_path = '' as $$
begin
  if jsonb_typeof(new.settings) <> 'object' then
    raise exception 'site settings must be an object' using errcode = '22023';
  end if;
  return new;
end;
$$;

create trigger site_settings_check
  before insert or update on public.site_settings
  for each row execute function app.check_site_settings();

-- ---------------------------------------------------------------------------
-- 3. Reordering a page's sections.
--
-- One statement, one transaction, one page. The array is required to be an
-- exact PERMUTATION of the sections on that page — every one of them, each
-- exactly once — which is what makes a partial or inconsistent order
-- unrepresentable rather than merely unlikely:
--
--   * an id from another page      → refused (and could not be updated anyway,
--                                     the policy would filter it)
--   * an id that does not exist    → refused
--   * a duplicate id               → refused, two sections cannot share a slot
--   * a short list                 → refused, the unlisted sections would keep
--                                     stale positions and collide
--
-- SECURITY INVOKER: the UPDATE passes through site_sections' own policies, so
-- this function is a convenience and never a way around RLS. The explicit
-- permission check exists only to produce a readable error rather than a
-- silent zero-row update, which a caller could not tell from success.
-- ---------------------------------------------------------------------------
create or replace function public.site_sections_reorder(p_page uuid, p_ids uuid[])
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

  if not app.site_page_can_manage(p_page) then
    raise exception 'site.manage required' using errcode = 'insufficient_privilege';
  end if;

  select count(distinct x) into v_uniq from unnest(p_ids) as x;
  if v_uniq <> v_len then
    raise exception 'a section may appear only once in the order'
      using errcode = '22023';
  end if;

  select count(*) into v_total from public.site_sections where page_id = p_page;
  select count(*) into v_match
    from public.site_sections where page_id = p_page and id = any (p_ids);

  -- Counted against the page rather than against the ids, so an id belonging
  -- to another page and an id that does not exist fail identically. Telling
  -- them apart would confirm that some other page owns that section.
  if v_match <> v_len then
    raise exception 'every section in the order must belong to this page'
      using errcode = '22023';
  end if;
  if v_match <> v_total then
    raise exception 'the order must list every section on this page'
      using errcode = '22023';
  end if;

  -- WITH ORDINALITY gives each id its position; page_id is repeated in the
  -- predicate so the statement itself cannot touch another page's row even if
  -- the checks above were ever loosened.
  update public.site_sections s
     set sort_order = t.pos - 1
    from unnest(p_ids) with ordinality as t(id, pos)
   where s.id = t.id and s.page_id = p_page;

  return v_total;
end;
$$;

revoke all on function public.site_sections_reorder(uuid, uuid[]) from public, anon;
grant execute on function public.site_sections_reorder(uuid, uuid[]) to authenticated;
