-- =============================================================================
-- LOCAL BASIC — 0038 Online ordering settings (D1.1)
--
-- No new settings table. public.settings already stores scoped key/value pairs
-- with a unique index that treats a null branch_id as the organization scope,
-- and already carries the right RLS: members read, `settings.manage` writes.
--
-- SCOPE: branch-level, falling back to the organization.
--
-- That is not a new convention — app.restaurant_delivery_fee has resolved the
-- fee branch-then-organization since 0037. This migration applies the same rule
-- to the three switches, so one branch can stop taking delivery on a busy night
-- without touching the rest of the chain, while an organization-wide default
-- still covers branches that have never been configured.
--
-- The four keys, all optional, all defaulting to "off" / zero:
--   restaurant.online_ordering_enabled   boolean
--   restaurant.pickup_enabled            boolean
--   restaurant.delivery_enabled          boolean
--   restaurant.delivery_fee_cents        integer minor units
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Scoped readers. Branch value wins; organization value is the default.
-- ---------------------------------------------------------------------------
create or replace function app.restaurant_setting_bool(
  p_org uuid, p_branch uuid, p_key text, p_default boolean
) returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select (s.value #>> '{}')::boolean from public.settings s
      where s.organization_id = p_org and s.branch_id = p_branch and s.key = p_key),
    (select (s.value #>> '{}')::boolean from public.settings s
      where s.organization_id = p_org and s.branch_id is null and s.key = p_key),
    p_default);
$$;

-- The 1-argument form is replaced rather than overloaded: leaving both would
-- let a caller silently ask the organization-wide question when they meant the
-- branch's. It is a private helper in `app`, never exposed through PostgREST,
-- so nothing outside these migrations can be referring to it.
drop function if exists app.restaurant_online_enabled(uuid);

create or replace function app.restaurant_online_enabled(p_org uuid, p_branch uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select app.restaurant_setting_bool(p_org, p_branch, 'restaurant.online_ordering_enabled', false);
$$;

/**
 * Is this fulfilment type on sale at this branch?
 *
 * Both default to true so an organization that switches ordering on gets a
 * working storefront without having to discover two more keys; a restaurant
 * that does not deliver turns delivery off explicitly.
 */
create or replace function app.restaurant_fulfillment_enabled(
  p_org uuid, p_branch uuid, p_type text
) returns boolean language sql stable security definer set search_path = '' as $$
  select case p_type
    when 'pickup'   then app.restaurant_setting_bool(p_org, p_branch, 'restaurant.pickup_enabled', true)
    when 'delivery' then app.restaurant_setting_bool(p_org, p_branch, 'restaurant.delivery_enabled', true)
    else false
  end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Server-side validation of the stored values.
--
-- RLS decides WHO may write a setting; nothing until now decided WHAT. A
-- member holding settings.manage could store "maybe" as a boolean or a
-- negative fee, and the readers above would either throw at checkout or
-- quietly charge nonsense. The shape is enforced here, once, for every writer.
-- ---------------------------------------------------------------------------
create or replace function app.check_restaurant_setting()
returns trigger language plpgsql set search_path = '' as $$
declare v_num numeric;
begin
  if new.key in (
    'restaurant.online_ordering_enabled',
    'restaurant.pickup_enabled',
    'restaurant.delivery_enabled',
    'restaurant.public_ordering_enabled'
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
    -- Non-negative, and capped well above any plausible fee so a slipped digit
    -- cannot quietly become a five-figure charge.
    if v_num < 0 or v_num > 1000000 then
      raise exception 'the delivery fee must be between 0 and 1000000 minor units'
        using errcode = '22023';
    end if;
  end if;

  return new;
end;
$$;

create trigger settings_check_restaurant
  before insert or update on public.settings
  for each row execute function app.check_restaurant_setting();

-- ---------------------------------------------------------------------------
-- 3. Audit. Changing whether a restaurant accepts orders, or what it charges
--    to deliver, is a commercial decision and belongs in the trail.
-- ---------------------------------------------------------------------------
create or replace function app.audit_restaurant_setting()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.key not like 'restaurant.%' then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.value is not distinct from old.value then
    return new;
  end if;

  insert into public.audit_logs
    (organization_id, branch_id, actor_id, actor_label, action,
     entity_type, entity_id, before, after)
  values (
    new.organization_id, new.branch_id, auth.uid(),
    (select p.full_name from public.profiles p where p.id = auth.uid()),
    'restaurant.setting_changed', 'setting', new.key,
    case when tg_op = 'UPDATE' then jsonb_build_object('value', old.value) else null end,
    jsonb_build_object('value', new.value, 'scope',
                       case when new.branch_id is null then 'organization' else 'branch' end)
  );
  return new;
end;
$$;

create trigger settings_audit_restaurant
  after insert or update on public.settings
  for each row execute function app.audit_restaurant_setting();

-- ---------------------------------------------------------------------------
-- 4. Enforcement at every guest entry point.
--
-- Each of these already resolved the branch from the storefront slugs; they now
-- ask the branch-scoped question instead of the organization-wide one, and the
-- two order paths additionally refuse a fulfilment type that is switched off.
-- Nothing about how prices are resolved changes.
-- ---------------------------------------------------------------------------
create or replace function public.restaurant_online_menu(
  p_org_slug text, p_branch_slug text
)
returns table (
  category_id uuid, category_name text, category_sort int,
  product_id uuid, product_name text, product_description text,
  image_url text, prep_minutes int, product_sort int,
  variant_id uuid, variant_name text, price_cents bigint, variant_sort int
)
language plpgsql stable security definer set search_path = '' as $$
declare v record;
begin
  select * into v from app.restaurant_online_branch(p_org_slug, p_branch_slug);
  if v.org_id is null then
    raise exception 'storefront not found' using errcode = 'check_violation';
  end if;
  if not app.restaurant_online_enabled(v.org_id, v.branch_id) then
    raise exception 'online ordering is not enabled' using errcode = 'check_violation';
  end if;

  return query
    select c.id, c.name, c.sort_order,
           p.id, p.name, p.description, p.image_url, p.prep_minutes, p.sort_order,
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
          where a.branch_id = v.branch_id and a.variant_id = vr.id and not a.is_available)
     order by c.sort_order nulls last, p.sort_order, vr.sort_order;
end;
$$;

create or replace function public.restaurant_online_modifiers(
  p_org_slug text, p_branch_slug text
)
returns table (
  product_id uuid, group_id uuid, group_name text,
  min_select int, max_select int, group_sort int,
  modifier_id uuid, modifier_name text, price_cents bigint, modifier_sort int
)
language plpgsql stable security definer set search_path = '' as $$
declare v record;
begin
  select * into v from app.restaurant_online_branch(p_org_slug, p_branch_slug);
  if v.org_id is null or not app.restaurant_online_enabled(v.org_id, v.branch_id) then
    raise exception 'storefront not found' using errcode = 'check_violation';
  end if;

  return query
    select g.product_id, g.id, g.name, g.min_select, g.max_select, g.sort_order,
           m.id, m.name, m.price_cents, m.sort_order
      from public.restaurant_modifier_groups g
      join public.restaurant_modifiers m on m.group_id = g.id
      join public.restaurant_products p on p.id = g.product_id
     where g.organization_id = v.org_id
       and g.is_active and m.is_active
       and p.is_active and p.deleted_at is null
     order by g.sort_order, m.sort_order;
end;
$$;

create or replace function public.restaurant_price_online_cart(
  p_org_slug text, p_branch_slug text, p_items jsonb, p_fulfillment text default 'pickup'
)
returns table (
  subtotal_cents bigint, tax_cents bigint,
  delivery_fee_cents bigint, total_cents bigint, currency char(3)
)
language plpgsql security definer set search_path = '' as $$
declare
  v        record;
  v_order  uuid;
  v_fee    bigint;
  v_number text;
begin
  select * into v from app.restaurant_online_branch(p_org_slug, p_branch_slug);
  if v.org_id is null or not app.restaurant_online_enabled(v.org_id, v.branch_id) then
    raise exception 'storefront not found' using errcode = 'check_violation';
  end if;
  if p_fulfillment not in ('pickup', 'delivery') then
    raise exception 'invalid fulfilment type' using errcode = 'check_violation';
  end if;
  if not app.restaurant_fulfillment_enabled(v.org_id, v.branch_id, p_fulfillment) then
    raise exception 'this fulfilment option is not available' using errcode = 'check_violation';
  end if;

  v_fee := case when p_fulfillment = 'delivery'
                then app.restaurant_delivery_fee(v.org_id, v.branch_id) else 0 end;

  begin
    v_number := 'QUOTE-' || substr(md5(random()::text), 1, 12);
    insert into public.restaurant_orders
      (organization_id, branch_id, number, channel, type, status, currency,
       delivery_fee_cents)
    values (v.org_id, v.branch_id, v_number, 'online', p_fulfillment, 'new',
            v.currency, v_fee)
    returning id into v_order;

    perform app.restaurant_build_order_lines(v.org_id, v.branch_id, v_order, p_items);

    return query
      select o.subtotal_cents, o.tax_cents, o.delivery_fee_cents, o.total_cents, o.currency
        from public.restaurant_orders o where o.id = v_order;

    delete from public.restaurant_orders where id = v_order;
  end;
end;
$$;

create or replace function public.restaurant_place_online_order(
  p_org_slug        text,
  p_branch_slug     text,
  p_items           jsonb,
  p_fulfillment     text,
  p_customer_name   text,
  p_customer_phone  text,
  p_idempotency_key text,
  p_address         jsonb default null,
  p_note            text default null
)
returns table (out_token text, out_number text, out_total_cents bigint, out_edit_until timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  v        record;
  v_order  uuid;
  v_number text;
  v_token  text;
  v_fee    bigint;
  v_open   int;
  v_existing uuid;
begin
  select * into v from app.restaurant_online_branch(p_org_slug, p_branch_slug);
  if v.org_id is null then
    raise exception 'storefront not found' using errcode = 'check_violation';
  end if;
  -- Branch-scoped. A guest calling this function directly, with ordering
  -- switched off for the branch, is refused here — the storefront page being
  -- unreachable was never the control.
  if not app.restaurant_online_enabled(v.org_id, v.branch_id) then
    raise exception 'online ordering is not enabled' using errcode = 'check_violation';
  end if;
  if p_fulfillment not in ('pickup', 'delivery') then
    raise exception 'invalid fulfilment type' using errcode = 'check_violation';
  end if;
  if not app.restaurant_fulfillment_enabled(v.org_id, v.branch_id, p_fulfillment) then
    raise exception 'this fulfilment option is not available' using errcode = 'check_violation';
  end if;
  if length(trim(coalesce(p_customer_name, ''))) < 2 then
    raise exception 'customer name is required' using errcode = 'check_violation';
  end if;
  if length(trim(coalesce(p_customer_phone, ''))) < 6 then
    raise exception 'customer phone is required' using errcode = 'check_violation';
  end if;
  if length(trim(coalesce(p_idempotency_key, ''))) < 8 then
    raise exception 'an idempotency key is required' using errcode = 'check_violation';
  end if;

  select o.id into v_existing
    from public.restaurant_orders o
   where o.organization_id = v.org_id
     and o.idempotency_key = trim(p_idempotency_key);

  if v_existing is not null then
    return query
      select pl.token, o.number, o.total_cents, o.customer_edit_until
        from public.restaurant_orders o
        join public.public_links pl
          on pl.kind = 'order_status'
         and (pl.target ->> 'entity_id')::uuid = o.id
       where o.id = v_existing;
    return;
  end if;

  if p_fulfillment = 'delivery' and p_address is null then
    raise exception 'a delivery order needs an address' using errcode = 'check_violation';
  end if;

  select count(*) into v_open
    from public.restaurant_orders
   where organization_id = v.org_id and channel = 'online'
     and status = 'new' and placed_at > now() - interval '1 hour';
  if v_open >= 200 then
    raise exception 'too many open online orders' using errcode = 'check_violation';
  end if;

  -- The fee is read from settings, never from the caller. A pickup order is
  -- charged nothing for delivery no matter what was sent.
  v_fee := case when p_fulfillment = 'delivery'
                then app.restaurant_delivery_fee(v.org_id, v.branch_id) else 0 end;

  v_number := app.next_document_number(v.org_id, v.branch_id, 'restaurant_order');

  insert into public.restaurant_orders
    (organization_id, branch_id, number, channel, type, status,
     guest_name, guest_phone, note, currency, delivery_fee_cents,
     idempotency_key, customer_edit_until, created_by)
  values
    (v.org_id, v.branch_id, v_number, 'online', p_fulfillment, 'new',
     left(trim(p_customer_name), 120), left(trim(p_customer_phone), 32),
     nullif(left(trim(coalesce(p_note, '')), 500), ''),
     v.currency, v_fee, trim(p_idempotency_key),
     now() + interval '60 seconds',
     null)
  returning id into v_order;

  perform app.restaurant_build_order_lines(v.org_id, v.branch_id, v_order, p_items);

  if p_fulfillment = 'delivery' then
    insert into public.restaurant_order_deliveries
      (order_id, organization_id, branch_id, recipient_name, phone,
       city, area, address, landmark, latitude, longitude, notes)
    values (
      v_order, v.org_id, v.branch_id,
      left(trim(coalesce(p_address ->> 'recipient_name', p_customer_name)), 120),
      left(trim(coalesce(p_address ->> 'phone', p_customer_phone)), 32),
      nullif(left(trim(coalesce(p_address ->> 'city', '')), 120), ''),
      nullif(left(trim(coalesce(p_address ->> 'area', '')), 120), ''),
      left(trim(coalesce(p_address ->> 'address', '')), 500),
      nullif(left(trim(coalesce(p_address ->> 'landmark', '')), 240), ''),
      (p_address ->> 'latitude')::numeric,
      (p_address ->> 'longitude')::numeric,
      nullif(left(trim(coalesce(p_address ->> 'notes', '')), 500), '')
    );
  end if;

  v_token := app.new_public_token();
  insert into public.public_links
    (organization_id, branch_id, kind, token, target, label, expires_at)
  values (
    v.org_id, v.branch_id, 'order_status', v_token,
    jsonb_build_object('entity_type', 'restaurant_order', 'entity_id', v_order),
    v_number, now() + interval '30 days'
  );

  insert into public.audit_logs
    (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  select v.org_id, v.branch_id, null, 'restaurant.online_order.created',
         'restaurant_order', v_order::text,
         jsonb_build_object('number', v_number, 'channel', 'online',
                            'type', p_fulfillment, 'total_cents', o.total_cents)
    from public.restaurant_orders o where o.id = v_order;

  insert into public.notifications
    (organization_id, branch_id, recipient, channel, template, payload)
  values (
    v.org_id, v.branch_id, left(trim(p_customer_phone), 32), 'inapp',
    'restaurant.online_order.created',
    jsonb_build_object('order_number', v_number, 'fulfillment', p_fulfillment)
  );

  return query
    select v_token, o.number, o.total_cents, o.customer_edit_until
      from public.restaurant_orders o where o.id = v_order;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. What the storefront may show.
--
-- The guest UI needs to know which buttons to render and what delivery costs.
-- Returning it from here means the page cannot invent an option the checkout
-- would refuse — and the fee it displays is the fee that will be charged.
-- ---------------------------------------------------------------------------
create or replace function public.restaurant_online_storefront(
  p_org_slug text, p_branch_slug text
)
returns table (
  organization_name text, branch_name text, currency char(3),
  pickup_enabled boolean, delivery_enabled boolean, delivery_fee_cents bigint
)
language plpgsql stable security definer set search_path = '' as $$
declare v record;
begin
  select * into v from app.restaurant_online_branch(p_org_slug, p_branch_slug);
  if v.org_id is null or not app.restaurant_online_enabled(v.org_id, v.branch_id) then
    raise exception 'storefront not found' using errcode = 'check_violation';
  end if;

  return query select
    v.org_name, v.branch_name, v.currency,
    app.restaurant_fulfillment_enabled(v.org_id, v.branch_id, 'pickup'),
    app.restaurant_fulfillment_enabled(v.org_id, v.branch_id, 'delivery'),
    app.restaurant_delivery_fee(v.org_id, v.branch_id);
end;
$$;

revoke all on function public.restaurant_online_storefront(text, text) from public;
grant execute on function public.restaurant_online_storefront(text, text) to anon, authenticated;

revoke all on function app.restaurant_setting_bool(uuid, uuid, text, boolean)
  from public, anon, authenticated;
revoke all on function app.restaurant_online_enabled(uuid, uuid)
  from public, anon, authenticated;
revoke all on function app.restaurant_fulfillment_enabled(uuid, uuid, text)
  from public, anon, authenticated;
