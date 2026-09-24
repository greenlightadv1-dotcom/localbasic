-- =============================================================================
-- LOCAL BASIC — Best sellers, bundles, and a banner section for the Site Engine
--
-- Three pieces:
--   1. restaurant_products.is_best_seller — a flag, not a new table. "Best
--      seller" is a property of an existing product, the same way is_active
--      already is; staff toggle it, nothing is copied anywhere.
--   2. restaurant_bundles — a new, DISPLAY-ONLY table. A bundle is
--      merchandising copy (name, description of contents, image, one
--      all-in price) for the customer-facing site. It is not a sellable POS
--      catalog item: nothing here changes restaurant_orders, inventory, or
--      what a cashier can ring up. Selling a bundle as one line through the
--      POS is a real, separate, larger feature — not attempted here.
--   3. Two new Site Engine section types (best_sellers, bundles) plus a
--      third, PRESENTATIONAL one (banner) for a promotional strip at the top
--      of a homepage. banner is copy an operator writes for a campaign, not
--      resolved from a table — same shape as hero, with an image.
--
-- The section-type list and app.check_site_section_content() are extended the
-- same way 0059 extended them for the first four data-bound types: dropped
-- and re-added rather than ALTERed, so the constraint stays a readable closed
-- set, and CREATE OR REPLACE so drift.test.ts picks this migration up as the
-- current allow-list definition.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. The best-seller flag.
-- ---------------------------------------------------------------------------
alter table public.restaurant_products
  add column is_best_seller boolean not null default false;

-- ---------------------------------------------------------------------------
-- 2. Bundles.
-- ---------------------------------------------------------------------------
create table public.restaurant_bundles (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  name             text not null check (length(trim(name)) between 1 and 200),
  description      text,
  image_url        text,
  price_cents      bigint not null check (price_cents >= 0),
  sort_order       int not null default 0,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid references public.profiles(id),
  deleted_at       timestamptz
);
create index restaurant_bundles_org_idx
  on public.restaurant_bundles(organization_id, sort_order) where deleted_at is null;
create trigger restaurant_bundles_touch before update on public.restaurant_bundles
  for each row execute function app.touch_updated_at();

alter table public.restaurant_bundles enable row level security;
alter table public.restaurant_bundles force row level security;
revoke all on public.restaurant_bundles from anon;

-- Same permission pair the rest of the menu uses: bundles are a menu-adjacent
-- merchandising concept, not a reason for a new permission key.
create policy restaurant_bundles_select on public.restaurant_bundles for select to authenticated
  using (app.has_permission(organization_id, 'restaurant.menu.read') and deleted_at is null);
create policy restaurant_bundles_insert on public.restaurant_bundles for insert to authenticated
  with check (app.has_permission(organization_id, 'restaurant.menu.manage'));
create policy restaurant_bundles_update on public.restaurant_bundles for update to authenticated
  using (app.has_permission(organization_id, 'restaurant.menu.manage'))
  with check (app.has_permission(organization_id, 'restaurant.menu.manage'));

grant select, insert, update on public.restaurant_bundles to authenticated;
revoke delete on public.restaurant_bundles from authenticated;

-- ---------------------------------------------------------------------------
-- 3. The section-type list.
-- ---------------------------------------------------------------------------
alter table public.site_sections
  drop constraint site_sections_section_type_check;

alter table public.site_sections
  add constraint site_sections_section_type_check check (section_type in (
    'hero', 'about', 'services', 'testimonials', 'contact', 'footer', 'banner',
    'menu', 'business_info', 'hours', 'branches', 'best_sellers', 'bundles'
  ));

-- ---------------------------------------------------------------------------
-- 4. Content validation for the new types. Replaces 0059's function.
-- ---------------------------------------------------------------------------
create or replace function app.check_site_section_content()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_allowed text[];
  v_key     text;
  v_href    text;
  v_image   text;
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
    when 'banner'        then array['title', 'subtitle', 'imageUrl', 'ctaLabel', 'ctaHref']
    -- Data-bound. `source` and `title` only, plus each type's own narrowing.
    -- No field here can hold business data.
    when 'menu'          then array['title', 'source', 'categoryIds', 'limit']
    when 'business_info' then array['title', 'source']
    when 'hours'         then array['title', 'source']
    when 'branches'      then array['title', 'source']
    when 'best_sellers'  then array['title', 'source', 'limit']
    when 'bundles'       then array['title', 'source', 'limit']
    else array[]::text[]
  end;

  for v_key in select jsonb_object_keys(new.content) loop
    if not (v_key = any (v_allowed)) then
      raise exception 'unknown field "%" for a % section', v_key, new.section_type
        using errcode = '22023';
    end if;
  end loop;

  if new.section_type in ('hero', 'banner') and new.content ? 'ctaHref'
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

  if new.section_type = 'banner' and new.content ? 'imageUrl'
     and jsonb_typeof(new.content -> 'imageUrl') <> 'null' then
    if jsonb_typeof(new.content -> 'imageUrl') <> 'string' then
      raise exception 'imageUrl must be text or null' using errcode = '22023';
    end if;
    v_image := btrim(new.content ->> 'imageUrl');
    if not (
         v_image ~ '^https://'
      or (v_image ~ '^/[^/]' and left(v_image, 2) <> ('/' || chr(92)))
    ) then
      raise exception 'unsupported image source' using errcode = '22023';
    end if;
  end if;

  -- ── The declarative contract ──────────────────────────────────────────────
  if new.section_type in ('menu', 'business_info', 'hours', 'branches', 'best_sellers', 'bundles') then
    if new.content ? 'source' and new.content ->> 'source' is distinct from 'live' then
      raise exception 'a % section resolves live data; source must be "live"',
        new.section_type using errcode = '22023';
    end if;

    if new.section_type = 'menu' and new.content ? 'categoryIds' then
      if jsonb_typeof(new.content -> 'categoryIds') <> 'array' then
        raise exception 'categoryIds must be a list' using errcode = '22023';
      end if;
      if jsonb_array_length(new.content -> 'categoryIds') > 50 then
        raise exception 'categoryIds holds at most 50 entries' using errcode = '22023';
      end if;
      for v_item in select * from jsonb_array_elements(new.content -> 'categoryIds') loop
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
      if new.section_type = 'menu' then
        if v_limit <> floor(v_limit) or v_limit < 1 or v_limit > 200 then
          raise exception 'limit must be a whole number between 1 and 200' using errcode = '22023';
        end if;
      else
        if v_limit <> floor(v_limit) or v_limit < 1 or v_limit > 50 then
          raise exception 'limit must be a whole number between 1 and 50' using errcode = '22023';
        end if;
      end if;
    end if;
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Public, unauthenticated reads — the same shape restaurant_website_menu()
-- already takes, organization-scoped like every other Site Engine data-bound
-- section (see 0059): no branch is selected, and app.restaurant_website_org()
-- is deliberately NOT reused here, because it gates on restaurant.website_enabled,
-- which governs the LEGACY website, not the Site Engine.
-- ---------------------------------------------------------------------------
create or replace function public.restaurant_website_best_sellers(p_org_slug text, p_limit int default 50)
returns table (
  product_id uuid, product_name text, product_description text, image_url text,
  product_sort int, variant_id uuid, variant_name text, price_cents bigint, variant_sort int
)
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid;
begin
  select o.id into v_org from public.organizations o
   where lower(o.slug::text) = lower(trim(p_org_slug)) and o.status = 'active' and o.deleted_at is null;
  if v_org is null then
    raise exception 'not found' using errcode = '22023';
  end if;

  return query
    select p.id, p.name, p.description, p.image_url, p.sort_order,
           vr.id, vr.name, vr.price_cents, vr.sort_order
      from public.restaurant_products p
      join public.restaurant_variants vr
        on vr.product_id = p.id and vr.organization_id = v_org
       and vr.is_active and vr.deleted_at is null
     where p.organization_id = v_org and p.is_active and p.is_best_seller and p.deleted_at is null
     order by p.sort_order, p.id
     limit greatest(1, least(coalesce(p_limit, 50), 200));
end;
$$;

revoke all on function public.restaurant_website_best_sellers(text, int) from public;
grant execute on function public.restaurant_website_best_sellers(text, int) to anon, authenticated;

create or replace function public.restaurant_website_bundles(p_org_slug text, p_limit int default 50)
returns table (bundle_id uuid, name text, description text, image_url text, price_cents bigint, sort_order int)
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid;
begin
  select o.id into v_org from public.organizations o
   where lower(o.slug::text) = lower(trim(p_org_slug)) and o.status = 'active' and o.deleted_at is null;
  if v_org is null then
    raise exception 'not found' using errcode = '22023';
  end if;

  return query
    select b.id, b.name, b.description, b.image_url, b.price_cents, b.sort_order
      from public.restaurant_bundles b
     where b.organization_id = v_org and b.is_active and b.deleted_at is null
     order by b.sort_order, b.id
     limit greatest(1, least(coalesce(p_limit, 50), 200));
end;
$$;

revoke all on function public.restaurant_website_bundles(text, int) from public;
grant execute on function public.restaurant_website_bundles(text, int) to anon, authenticated;
