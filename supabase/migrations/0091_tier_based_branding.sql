-- ---------------------------------------------------------------------------
-- 0091: tier-based branding.
--
-- A store's own brand colors apply only on plans that include them. The plan
-- data carries a `custom_colors` flag, the same mechanism `white_label`
-- already uses:
--     basic (أساسي)    → no  : the platform's default LocalBasic palette
--     growth (نمو)     → yes : "Pro"
--     scale (احترافي)  → yes : "Enterprise"
--     trial            → no
-- The stored colors are never overwritten, so a downgrade falls back to the
-- default palette and an upgrade brings the store's own colors straight back.
--
-- Enforced here, in the three SECURITY DEFINER functions every public page
-- reads its branding from, so no public surface can show a custom color for a
-- plan that does not include it. The white-label flag is gated the same way
-- (until now only the tenant dashboard checked the plan).
-- ---------------------------------------------------------------------------

update public.plans
   set features = coalesce(features, '{}'::jsonb)
                  || jsonb_build_object('custom_colors', key in ('growth', 'scale'));

-- Does the organization's live subscription include this feature flag?
create or replace function app.org_has_plan_feature(p_org uuid, p_feature text)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select (p.features ->> p_feature)::boolean
       from public.subscriptions s
       join public.plans p on p.id = s.plan_id
      where s.organization_id = p_org
        and s.status in ('trialing', 'active', 'past_due')
      limit 1),
    false);
$$;

-- The stored color when the plan allows custom colors, else the default.
create or replace function app.effective_brand_color(p_org uuid, p_stored text, p_default text)
returns text language sql stable security definer set search_path = '' as $$
  select case
           when p_stored is not null and app.org_has_plan_feature(p_org, 'custom_colors')
           then p_stored
           else p_default
         end;
$$;

revoke all on function app.org_has_plan_feature(uuid, text) from public, anon, authenticated;
revoke all on function app.effective_brand_color(uuid, text, text) from public, anon, authenticated;

-- restaurant_public_context (0022): the table-QR page
create or replace function public.restaurant_public_context(p_token text)
returns table (
  organization_name text,
  branch_name       text,
  table_name        text,
  currency          char(3),
  locale            text,
  logo_url          text,
  primary_color     text,
  secondary_color   text,
  white_label       boolean,
  phone             text,
  whatsapp          text,
  ordering_enabled  boolean
)
language sql stable security definer set search_path = '' as $$
  select
    coalesce(bs.display_name, o.name),
    b.name,
    t.name,
    o.currency,
    o.default_locale,
    bs.logo_url,
    app.effective_brand_color(o.id, bs.primary_color, '#1E2FC8'),
    app.effective_brand_color(o.id, bs.secondary_color, '#6B8BFA'),
    (coalesce(bs.white_label, false) and app.org_has_plan_feature(o.id, 'white_label')),
    bs.phone,
    bs.whatsapp,
    -- A restaurant can turn guest ordering off and use the QR as a menu only.
    coalesce(
      (select (s.value #>> '{}')::boolean from public.settings s
        where s.organization_id = o.id and s.branch_id is null
          and s.key = 'restaurant.public_ordering_enabled'),
      true)
  from public.public_links pl
  join public.organizations o on o.id = pl.organization_id
  join public.branches b      on b.id = pl.branch_id
  join public.restaurant_tables t
    on t.id = (pl.target ->> 'entity_id')::uuid
   and t.branch_id = pl.branch_id
  left join public.branding_settings bs on bs.organization_id = o.id
  where pl.token = p_token
    and pl.kind = 'menu'
    and pl.is_active and pl.revoked_at is null
    and (pl.expires_at is null or pl.expires_at > now())
    and o.status = 'active' and o.deleted_at is null
    and b.is_active and b.deleted_at is null
    and t.is_active and t.deleted_at is null;
$$;

-- restaurant_website (0039): the public site / menu header
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
      app.effective_brand_color(v.org_id, bs.primary_color, '#1E2FC8'),
      app.effective_brand_color(v.org_id, bs.secondary_color, '#6B8BFA'),
      bs.phone, bs.whatsapp, bs.email::text,
      v.currency, v.locale,
      (coalesce(bs.white_label, false) and app.org_has_plan_feature(v.org_id, 'white_label')),
      (select s.value from public.settings s
        where s.organization_id = v.org_id and s.branch_id is null
          and s.key = 'restaurant.opening_hours')
    from (select 1) _
    left join public.branding_settings bs on bs.organization_id = v.org_id;
end;
$$;

-- restaurant_online_storefront (0068): the online ordering page
create or replace function public.restaurant_online_storefront(
  p_org_slug text, p_branch_slug text
)
returns table (
  organization_name text, branch_name text, currency char(3),
  pickup_enabled boolean, delivery_enabled boolean, delivery_fee_cents bigint,
  primary_color text, secondary_color text, logo_url text
)
language plpgsql stable security definer set search_path = '' as $$
declare v record;
begin
  select * into v from app.restaurant_online_branch(p_org_slug, p_branch_slug);
  if v.org_id is null or not app.restaurant_online_enabled(v.org_id, v.branch_id) then
    raise exception 'storefront not found' using errcode = 'check_violation';
  end if;

  return query
    select
      v.org_name, v.branch_name, v.currency,
      app.restaurant_fulfillment_enabled(v.org_id, v.branch_id, 'pickup'),
      app.restaurant_fulfillment_enabled(v.org_id, v.branch_id, 'delivery'),
      app.restaurant_delivery_fee(v.org_id, v.branch_id),
      app.effective_brand_color(v.org_id, bs.primary_color, '#1E2FC8'),
      app.effective_brand_color(v.org_id, bs.secondary_color, '#6B8BFA'),
      bs.logo_url
    from (select 1) _
    left join public.branding_settings bs on bs.organization_id = v.org_id;
end;
$$;

-- The order-tracking page knows only a status token. This hands it the store's
-- effective theme (same gating as above) and nothing else about the order.
create or replace function public.restaurant_status_theme(p_token text)
returns table (organization_name text, logo_url text, primary_color text, secondary_color text)
language sql stable security definer set search_path = '' as $$
  select
    coalesce(bs.display_name, o.name),
    bs.logo_url,
    app.effective_brand_color(o.id, bs.primary_color, '#1E2FC8'),
    app.effective_brand_color(o.id, bs.secondary_color, '#6B8BFA')
  from public.public_links pl
  join public.organizations o on o.id = pl.organization_id
  left join public.branding_settings bs on bs.organization_id = o.id
  where pl.token = p_token
    and pl.kind = 'order_status'
    and pl.is_active and pl.revoked_at is null
    and (pl.expires_at is null or pl.expires_at > now())
    and o.deleted_at is null;
$$;

revoke all on function public.restaurant_status_theme(text) from public;
grant execute on function public.restaurant_status_theme(text) to anon, authenticated;
