-- =============================================================================
-- LOCAL BASIC — 0039 Public restaurant website (D2)
--
-- The website is a READ surface over data that already exists. It introduces no
-- menu, product, price, order, branch or customer concept: the organization,
-- its branding, its branches and its menu are all already modelled, and the
-- ordering engine is D1's.
--
-- PUBLIC IDENTITY: organizations.slug, which is already citext, unique, URL-safe
-- by CHECK, and already public in the /order/<org>/<branch> addresses. No new
-- slug column. The opaque QR tokens in public_links stay exactly as they are —
-- a table's QR is a revocable capability, a website address is not, and the two
-- must not be conflated.
--
-- WEBSITE SETTINGS live in public.settings, the same scoped key/value store
-- D1.1 uses, validated and audited by the same triggers. No second settings
-- system, and no opening-hours table: the hours are one JSON value under a key,
-- which is the smallest thing that can hold them.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Validation for the new keys.
--
-- Extends the D1.1 trigger function rather than adding a second trigger, so
-- every settings write still passes through exactly one gate.
-- ---------------------------------------------------------------------------
create or replace function app.check_restaurant_setting()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_num numeric;
  v_day jsonb;
begin
  if new.key in (
    'restaurant.online_ordering_enabled',
    'restaurant.pickup_enabled',
    'restaurant.delivery_enabled',
    'restaurant.public_ordering_enabled',
    'restaurant.website_enabled'
  ) then
    if jsonb_typeof(new.value) <> 'boolean' then
      raise exception '% must be true or false', new.key using errcode = '22023';
    end if;

  elsif new.key = 'restaurant.delivery_fee_cents' then
    if jsonb_typeof(new.value) <> 'number' then
      raise exception 'the delivery fee must be a number of minor units'
        using errcode = '22023';
    end if;
    v_num := (new.value #>> '{}')::numeric;
    if v_num <> floor(v_num) then
      raise exception 'the delivery fee must be a whole number of minor units'
        using errcode = '22023';
    end if;
    if v_num < 0 or v_num > 1000000 then
      raise exception 'the delivery fee must be between 0 and 1000000 minor units'
        using errcode = '22023';
    end if;

  elsif new.key in ('restaurant.website_tagline', 'restaurant.website_about') then
    if jsonb_typeof(new.value) <> 'string' then
      raise exception '% must be text', new.key using errcode = '22023';
    end if;
    if length(new.value #>> '{}') > 2000 then
      raise exception '% is too long', new.key using errcode = '22023';
    end if;

  elsif new.key = 'restaurant.website_hero_url' then
    if jsonb_typeof(new.value) <> 'string' then
      raise exception 'the hero image must be a URL' using errcode = '22023';
    end if;
    -- Only https, and only when set. Rejecting javascript:, data: and any other
    -- scheme here means no stored value can become an injection vector later,
    -- whatever renders it.
    if new.value #>> '{}' <> '' then
      if length(new.value #>> '{}') > 500 then
        raise exception 'the hero image URL is too long' using errcode = '22023';
      end if;
      if new.value #>> '{}' !~ '^https://[^[:space:]<>"]+$' then
        raise exception 'the hero image must be an https URL' using errcode = '22023';
      end if;
    end if;

  elsif new.key = 'restaurant.opening_hours' then
    if jsonb_typeof(new.value) <> 'array' then
      raise exception 'opening hours must be a list of days' using errcode = '22023';
    end if;
    if jsonb_array_length(new.value) <> 7 then
      raise exception 'opening hours need exactly seven days' using errcode = '22023';
    end if;
    for v_day in select * from jsonb_array_elements(new.value) loop
      if jsonb_typeof(v_day) <> 'object'
         or jsonb_typeof(v_day -> 'closed') <> 'boolean' then
        raise exception 'each day needs a closed flag' using errcode = '22023';
      end if;
      if not (v_day ->> 'closed')::boolean then
        if coalesce(v_day ->> 'opens', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
           or coalesce(v_day ->> 'closes', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
          raise exception 'opening times must be HH:MM' using errcode = '22023';
        end if;
      end if;
    end loop;
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Resolve a restaurant from its public slug.
--
-- The one place that decides a slug names a real, active, restaurant-enabled
-- organization whose website is switched on. Everything public goes through it,
-- so an inactive or unpublished restaurant is invisible from every entry point
-- rather than from each one separately.
-- ---------------------------------------------------------------------------
create or replace function app.restaurant_website_org(p_org_slug text)
returns table (org_id uuid, org_name text, currency char(3), locale text)
language sql stable security definer set search_path = '' as $$
  select o.id, o.name, o.currency, o.default_locale
  from public.organizations o
  join public.organization_modules m
    on m.organization_id = o.id and m.module_key = 'restaurant' and m.enabled
  where lower(o.slug::text) = lower(trim(p_org_slug))
    and o.status = 'active' and o.deleted_at is null
    and coalesce(
      (select (s.value #>> '{}')::boolean from public.settings s
        where s.organization_id = o.id and s.branch_id is null
          and s.key = 'restaurant.website_enabled'),
      false)
  limit 1;
$$;

revoke all on function app.restaurant_website_org(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. The website's own content.
--
-- Explicit columns, all of them things a restaurant chooses to publish. No
-- staff, no customers, no order data, no internal ids, no private settings.
-- ---------------------------------------------------------------------------
create or replace function public.restaurant_website(p_org_slug text)
returns table (
  organization_name text,
  tagline           text,
  about             text,
  logo_url          text,
  hero_url          text,
  primary_color     text,
  secondary_color   text,
  phone             text,
  whatsapp          text,
  email             text,
  currency          char(3),
  locale            text,
  white_label       boolean,
  opening_hours     jsonb
)
language plpgsql stable security definer set search_path = '' as $$
declare v record;
begin
  select * into v from app.restaurant_website_org(p_org_slug);
  if v.org_id is null then
    raise exception 'restaurant not found' using errcode = 'check_violation';
  end if;

  return query
    select
      coalesce(bs.display_name, v.org_name),
      nullif((select s.value #>> '{}' from public.settings s
               where s.organization_id = v.org_id and s.branch_id is null
                 and s.key = 'restaurant.website_tagline'), ''),
      nullif((select s.value #>> '{}' from public.settings s
               where s.organization_id = v.org_id and s.branch_id is null
                 and s.key = 'restaurant.website_about'), ''),
      bs.logo_url,
      nullif((select s.value #>> '{}' from public.settings s
               where s.organization_id = v.org_id and s.branch_id is null
                 and s.key = 'restaurant.website_hero_url'), ''),
      coalesce(bs.primary_color, '#1E2FC8'),
      coalesce(bs.secondary_color, '#6B8BFA'),
      bs.phone, bs.whatsapp, bs.email::text,
      v.currency, v.locale,
      coalesce(bs.white_label, false),
      (select s.value from public.settings s
        where s.organization_id = v.org_id and s.branch_id is null
          and s.key = 'restaurant.opening_hours')
    from (select 1) _
    left join public.branding_settings bs on bs.organization_id = v.org_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Branches, with each one's own ordering availability.
--
-- The D1.1 settings resolve branch-then-organization here exactly as they do at
-- checkout, so a branch that cannot take an order never advertises one. The
-- page is not the control — but it must not lie either.
-- ---------------------------------------------------------------------------
create or replace function public.restaurant_website_branches(p_org_slug text)
returns table (
  branch_slug        text,
  branch_name        text,
  address            text,
  phone              text,
  ordering_enabled   boolean,
  pickup_enabled     boolean,
  delivery_enabled   boolean,
  delivery_fee_cents bigint
)
language plpgsql stable security definer set search_path = '' as $$
declare v record;
begin
  select * into v from app.restaurant_website_org(p_org_slug);
  if v.org_id is null then
    raise exception 'restaurant not found' using errcode = 'check_violation';
  end if;

  return query
    select
      b.slug::text, b.name, b.address, b.phone,
      app.restaurant_online_enabled(v.org_id, b.id),
      app.restaurant_fulfillment_enabled(v.org_id, b.id, 'pickup'),
      app.restaurant_fulfillment_enabled(v.org_id, b.id, 'delivery'),
      app.restaurant_delivery_fee(v.org_id, b.id)
      from public.branches b
     where b.organization_id = v.org_id
       and b.is_active and b.deleted_at is null
     order by b.created_at;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. The published menu.
--
-- Deliberately NOT gated on online ordering: a restaurant that has switched
-- ordering off still wants its menu readable, which is the whole point of
-- having a website. Ordering remains gated where it is actually performed.
--
-- Branch availability is honoured, so an item a branch has run out of does not
-- appear on that branch's page.
-- ---------------------------------------------------------------------------
create or replace function public.restaurant_website_menu(
  p_org_slug text, p_branch_slug text
)
returns table (
  category_id uuid, category_name text, category_sort int,
  product_id uuid, product_name text, product_description text,
  image_url text, product_sort int,
  variant_id uuid, variant_name text, price_cents bigint, variant_sort int
)
language plpgsql stable security definer set search_path = '' as $$
declare
  v        record;
  v_branch uuid;
begin
  select * into v from app.restaurant_website_org(p_org_slug);
  if v.org_id is null then
    raise exception 'restaurant not found' using errcode = 'check_violation';
  end if;

  -- The branch must belong to this organization. A caller pairing one
  -- restaurant's slug with another's branch resolves to nothing.
  select b.id into v_branch
    from public.branches b
   where b.organization_id = v.org_id
     and lower(b.slug::text) = lower(trim(p_branch_slug))
     and b.is_active and b.deleted_at is null;

  if v_branch is null then
    raise exception 'branch not found' using errcode = 'check_violation';
  end if;

  return query
    select c.id, c.name, c.sort_order,
           p.id, p.name, p.description, p.image_url, p.sort_order,
           vr.id, vr.name, vr.price_cents, vr.sort_order
      from public.restaurant_variants vr
      join public.restaurant_products p on p.id = vr.product_id
      left join public.restaurant_categories c on c.id = p.category_id
     where vr.organization_id = v.org_id
       and vr.is_active and vr.deleted_at is null
       and p.is_active and p.deleted_at is null
       and (c.id is null or c.is_active)
       and not exists (
         select 1 from public.restaurant_branch_availability a
          where a.branch_id = v_branch and a.variant_id = vr.id and not a.is_available)
     order by c.sort_order nulls last, p.sort_order, vr.sort_order;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Grants. Guest-readable, nothing else.
-- ---------------------------------------------------------------------------
do $$
declare fn text;
begin
  foreach fn in array array[
    'public.restaurant_website(text)',
    'public.restaurant_website_branches(text)',
    'public.restaurant_website_menu(text, text)'
  ]
  loop
    execute format('revoke all on function %s from public', fn);
    execute format('grant execute on function %s to anon, authenticated', fn);
  end loop;
end $$;
