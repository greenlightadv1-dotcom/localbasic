-- =============================================================================
-- LOCAL BASIC — The guest ordering storefront adopts the restaurant's brand
--
-- restaurant_online_storefront() told the storefront everything it needed to
-- decide WHAT it could sell (pickup/delivery, delivery fee, currency), but
-- nothing about how the restaurant wants to look. The page rendered in
-- LocalBasic's own platform colors — the same bug the legacy website's own
-- restaurant_website() function was built to avoid, and reads the exact same
-- source that one already does: branding_settings, with the exact same
-- defaults (#1E2FC8 / #6B8BFA) when a restaurant has not set its own.
--
-- Adds three columns to the same function rather than a second one: the
-- storefront already calls this once per page load, and "the branch's
-- ordering info" and "how it looks" are the same request from the caller's
-- point of view.
-- =============================================================================

-- The return row shape is widening (three new trailing columns), which
-- PostgreSQL will not let a plain CREATE OR REPLACE do.
drop function public.restaurant_online_storefront(text, text);

create function public.restaurant_online_storefront(
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
      coalesce(bs.primary_color, '#1E2FC8'),
      coalesce(bs.secondary_color, '#6B8BFA'),
      bs.logo_url
    from (select 1) _
    left join public.branding_settings bs on bs.organization_id = v.org_id;
end;
$$;

revoke all on function public.restaurant_online_storefront(text, text) from public;
grant execute on function public.restaurant_online_storefront(text, text) to anon, authenticated;
