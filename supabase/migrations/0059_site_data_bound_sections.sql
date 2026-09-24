-- =============================================================================
-- LOCAL BASIC — 0059 Site Engine data-bound sections
--
-- WHY THIS MIGRATION IS NECESSARY
--
-- Phase 3 adds four section types that display live business data. Two things
-- in the schema are closed against them and cannot be opened from TypeScript:
--
--   1. site_sections.section_type carries a CHECK listing exactly six values.
--      A 'menu' row cannot be stored at all until that list grows.
--   2. app.check_site_section_content() (0057) allow-lists content keys per
--      type and refuses every key for a type it does not know, so the new
--      sections would be storable and then unwritable.
--
-- No table, column or policy is added. Nothing about ownership, RLS, the
-- homepage invariant or the permission model changes. In particular there is
-- NO sites.branch_id and no site_menu_items / site_hours / site_branches /
-- site_business_info: the business data already has authoritative tables and
-- this phase reads them, it does not copy them.
--
-- THE CONTRACT THESE SECTIONS STORE
--
-- Declarative configuration only. A data-bound section says WHAT it wants
-- shown; it never stores the thing itself. `source` names the resolution
-- strategy, `title` is the operator's own heading copy, and `categoryIds` and
-- `limit` narrow the query. That is the whole allowed surface, and the
-- allow-list below is what makes a price, an address, a phone number, an
-- opening time or an organization id unstorable rather than merely discouraged
-- — including through a direct PostgREST write, which is the layer TypeScript
-- does not see.
--
-- `title` is presentation, not business data: it is the heading an operator
-- types above the menu, exactly like an about section's title. The business
-- name, phone, address and opening times are NOT storable anywhere here.
--
-- SEMANTICS, recorded here because the constraint is where they end up being
-- enforced:
--
--   * A Site Engine site is ORGANIZATION-scoped. sites has organization_id and
--     no branch_id, by the design 0055 states explicitly.
--   * The menu section therefore means THE ORGANIZATION'S MENU. It does not
--     consult restaurant_branch_availability, because no branch is selected
--     and picking one would be inventing a relationship the schema does not
--     have. It must not be described as a particular branch's menu.
--   * Business info is organization-scoped and so has NO address: the only
--     addresses in this schema belong to branches. Branch addresses are
--     rendered by the branches section and nowhere else.
--   * None of this is gated on restaurant.website_enabled. That toggle governs
--     the legacy restaurant website; the Site Engine is a separate system.
--     Both read the same authoritative tables where they overlap, which is the
--     point: one source of truth, two presentation layers.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. The section-type list.
--
-- Dropped and re-added rather than altered: PostgreSQL has no "extend a CHECK"
-- and the replacement lists every accepted value, so the constraint stays
-- readable as the closed set it is. Existing rows all carry one of the
-- original six, so nothing is revalidated into failure.
-- ---------------------------------------------------------------------------
alter table public.site_sections
  drop constraint site_sections_section_type_check;

alter table public.site_sections
  add constraint site_sections_section_type_check check (section_type in (
    -- Presentational: content lives in the row.
    'hero', 'about', 'services', 'testimonials', 'contact', 'footer',
    -- Data-bound: the row holds configuration, the data is resolved at render.
    'menu', 'business_info', 'hours', 'branches'
  ));

-- ---------------------------------------------------------------------------
-- 2. Content validation for the new types.
--
-- Replaces the 0057 function. Same shape, same SECURITY INVOKER, same
-- `set search_path = ''`, same errcode; the presentational branches are
-- unchanged, and the `else array[]::text[]` floor still refuses every key for
-- a type nobody has taught it.
--
-- src/modules/sites/sections/drift.test.ts parses the LAST migration that
-- defines this function and asserts the read schemas, the write schemas and
-- these arrays all declare the same fields, so the three layers cannot drift
-- apart quietly.
-- ---------------------------------------------------------------------------
create or replace function app.check_site_section_content()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_allowed text[];
  v_key     text;
  v_href    text;
  v_item    jsonb;
  v_limit   numeric;
begin
  if jsonb_typeof(new.content) <> 'object' then
    raise exception 'section content must be an object' using errcode = '22023';
  end if;

  v_allowed := case new.section_type
    when 'hero'          then array['title', 'subtitle', 'ctaLabel', 'ctaHref', 'align']
    when 'about'         then array['title', 'body']
    when 'services'      then array['title', 'items']
    when 'testimonials'  then array['title', 'items']
    when 'contact'       then array['title', 'phone', 'email', 'address']
    when 'footer'        then array['text']
    -- Data-bound. `source` and `title` only, plus the menu's two query
    -- narrowings. No field here can hold business data.
    when 'menu'          then array['title', 'source', 'categoryIds', 'limit']
    when 'business_info' then array['title', 'source']
    when 'hours'         then array['title', 'source']
    when 'branches'      then array['title', 'source']
    else array[]::text[]
  end;

  for v_key in select jsonb_object_keys(new.content) loop
    if not (v_key = any (v_allowed)) then
      raise exception 'unknown field "%" for a % section', v_key, new.section_type
        using errcode = '22023';
    end if;
  end loop;

  if new.section_type = 'hero' and new.content ? 'ctaHref'
     and jsonb_typeof(new.content -> 'ctaHref') <> 'null' then
    if jsonb_typeof(new.content -> 'ctaHref') <> 'string' then
      raise exception 'ctaHref must be text or null' using errcode = '22023';
    end if;
    v_href := btrim(new.content ->> 'ctaHref');
    if not (
         (v_href ~ '^/[^/]' and left(v_href, 2) <> ('/' || chr(92)))
      or v_href ~ '^mailto:[^[:space:]]+@[^[:space:]]+$'
      or v_href ~ '^tel:[+]?[0-9[:space:]-]+$'
    ) then
      raise exception 'unsupported link target for ctaHref' using errcode = '22023';
    end if;
  end if;

  -- ── The declarative contract ──────────────────────────────────────────────
  if new.section_type in ('menu', 'business_info', 'hours', 'branches') then
    -- One strategy, named. A value other than 'live' would be a second
    -- resolution mode nothing implements — most likely a snapshot, which is
    -- the thing this whole design exists to prevent.
    if new.content ? 'source' and new.content ->> 'source' is distinct from 'live' then
      raise exception 'a % section resolves live data; source must be "live"',
        new.section_type using errcode = '22023';
    end if;

    if new.content ? 'categoryIds' then
      if jsonb_typeof(new.content -> 'categoryIds') <> 'array' then
        raise exception 'categoryIds must be a list' using errcode = '22023';
      end if;
      if jsonb_array_length(new.content -> 'categoryIds') > 50 then
        raise exception 'categoryIds holds at most 50 entries' using errcode = '22023';
      end if;
      for v_item in select * from jsonb_array_elements(new.content -> 'categoryIds') loop
        -- Shape only. WHOSE category it is is not decided here and cannot be:
        -- a trigger sees the row, not the caller's organization. The resolver
        -- re-queries every id inside the site's own organization, so an id
        -- from another tenant resolves to nothing rather than to their menu.
        if jsonb_typeof(v_item) <> 'string'
           or v_item #>> '{}' !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
          raise exception 'every category must be an identifier' using errcode = '22023';
        end if;
      end loop;
    end if;

    if new.content ? 'limit' then
      if jsonb_typeof(new.content -> 'limit') <> 'number' then
        raise exception 'limit must be a number' using errcode = '22023';
      end if;
      v_limit := (new.content -> 'limit') #>> '{}';
      if v_limit <> floor(v_limit) or v_limit < 1 or v_limit > 200 then
        raise exception 'limit must be a whole number between 1 and 200'
          using errcode = '22023';
      end if;
    end if;
  end if;

  return new;
end;
$$;
