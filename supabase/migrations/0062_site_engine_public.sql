-- =============================================================================
-- LOCAL BASIC — Site Engine, a public read surface
--
-- The Site Engine (0055-0061) has an editor and two authenticated previews
-- (the tenant's own /settings/sites, and Platform Admin's
-- /admin/customers/[code]/sites) but nothing an anonymous visitor can reach:
-- sites/site_pages/site_sections/site_settings/site_revisions carry ordinary
-- tenant RLS, proven unreachable even to a Platform Admin in 0061's test 10.
--
-- This adds exactly one new capability: given an organization's public slug
-- and (optionally) a page slug, return the PUBLISHED site's structural
-- content — organization identity, site settings (theme/locale/direction),
-- the target page, and its visible sections' STORED content, unresolved.
--
-- Deliberately unresolved. A menu/hours/branches/business_info section's
-- live data (the actual products, hours, branches) is not this function's
-- job: the public website already has a proven, tested read path for that
-- (restaurant_website(), restaurant_website_menu(), restaurant_website_branches(),
-- all SECURITY DEFINER, all in production use today). Re-deriving that
-- resolution logic a second time in SQL, untested, is exactly the kind of
-- second source of truth src/modules/sites/resolve.ts's own docstring warns
-- against. The Next.js server route composes this function's structural
-- result with those existing, already-public functions.
--
-- SECURITY, THE SAME SHAPE AS restaurant_website_org():
--   - the organization must resolve from its slug, be active, not deleted
--   - the site must be this organization's, and PUBLISHED — a draft site,
--     or an organization with no site yet, is "not found", indistinguishable
--     from a made-up slug
--   - the requested page must belong to that site; an unknown page slug is
--     "not found" rather than falling back to the homepage
--   - only VISIBLE sections are returned, in their stored order
-- =============================================================================

create or replace function public.site_public_page(p_org_slug text, p_page_slug text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_org_id       uuid;
  v_org_name     text;
  v_org_currency text;
  v_site_id      uuid;
  v_site_name    text;
  v_site_slug    text;
  v_settings     jsonb;
  v_page_id      uuid;
  v_page_title   text;
  v_page_slug    text;
  v_page_home    boolean;
  v_sections     jsonb;
  v_pages        jsonb;
begin
  select o.id, o.name, o.currency::text
    into v_org_id, v_org_name, v_org_currency
    from public.organizations o
   where lower(o.slug::text) = lower(btrim(p_org_slug))
     and o.status = 'active'
     and o.deleted_at is null;

  if v_org_id is null then
    raise exception 'not found' using errcode = '22023';
  end if;

  -- One published site per organization is all the product supports today;
  -- the oldest is the deterministic pick if that ever changes.
  select s.id, s.name, s.slug::text
    into v_site_id, v_site_name, v_site_slug
    from public.sites s
   where s.organization_id = v_org_id
     and s.status = 'published'
   order by s.created_at asc, s.id asc
   limit 1;

  if v_site_id is null then
    raise exception 'not found' using errcode = '22023';
  end if;

  select st.settings into v_settings
    from public.site_settings st
   where st.site_id = v_site_id;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', p.id, 'title', p.title, 'slug', p.slug::text, 'isHomepage', p.is_homepage
      )
      order by p.sort_order, p.id
    ),
    '[]'::jsonb
  )
    into v_pages
    from public.site_pages p
   where p.site_id = v_site_id;

  if p_page_slug is null then
    select p.id, p.title, p.slug::text, p.is_homepage
      into v_page_id, v_page_title, v_page_slug, v_page_home
      from public.site_pages p
     where p.site_id = v_site_id and p.is_homepage
     limit 1;
  else
    select p.id, p.title, p.slug::text, p.is_homepage
      into v_page_id, v_page_title, v_page_slug, v_page_home
      from public.site_pages p
     where p.site_id = v_site_id and lower(p.slug::text) = lower(btrim(p_page_slug))
     limit 1;
  end if;

  if v_page_id is null then
    raise exception 'not found' using errcode = '22023';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', sec.id,
        'sectionType', sec.section_type,
        'content', sec.content,
        'sortOrder', sec.sort_order
      )
      order by sec.sort_order, sec.id
    ),
    '[]'::jsonb
  )
    into v_sections
    from public.site_sections sec
   where sec.page_id = v_page_id and sec.is_visible;

  return jsonb_build_object(
    'organization', jsonb_build_object(
      'name', v_org_name,
      'slug', lower(btrim(p_org_slug)),
      'currency', v_org_currency
    ),
    'site', jsonb_build_object('id', v_site_id, 'name', v_site_name, 'slug', v_site_slug),
    'settings', coalesce(v_settings, '{}'::jsonb),
    'pages', v_pages,
    'page', jsonb_build_object(
      'id', v_page_id, 'title', v_page_title, 'slug', v_page_slug, 'isHomepage', v_page_home
    ),
    'sections', v_sections
  );
end;
$function$;

comment on function public.site_public_page(text, text) is
  'Public, unauthenticated read of a PUBLISHED Site Engine site''s structural content (org identity, theme settings, one page''s visible sections, unresolved). Data-bound sections'' live data is resolved by the caller via the existing public restaurant_website* functions.';

grant execute on function public.site_public_page(text, text) to anon, authenticated;
