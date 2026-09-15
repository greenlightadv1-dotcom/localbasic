-- =============================================================================
-- LOCAL BASIC — 0037 Online ordering functions (D1 core)
--
-- The whole guest surface. Every one of these is SECURITY DEFINER and returns
-- a narrow projection, because `anon` holds no privilege on any restaurant
-- table and must never be given one.
--
-- The client sends identifiers and quantities. It never sends a price, a
-- subtotal, a delivery fee, a total, or a deadline — all of those are read or
-- computed here from current menu data and branch settings.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Resolve a storefront from public slugs.
--
-- Slugs rather than ids: a branch uuid is an internal identifier and there is
-- no reason for a storefront URL to carry one. The lookup also proves the
-- branch really belongs to the organization, so a caller cannot pair tenant
-- A's organization with tenant B's branch.
-- ---------------------------------------------------------------------------
create or replace function app.restaurant_online_branch(
  p_org_slug text, p_branch_slug text
) returns table (org_id uuid, branch_id uuid, currency char(3), org_name text, branch_name text)
language sql stable security definer set search_path = '' as $$
  select o.id, b.id, o.currency, o.name, b.name
  from public.organizations o
  join public.branches b on b.organization_id = o.id
  join public.organization_modules m
    on m.organization_id = o.id and m.module_key = 'restaurant' and m.enabled
  where lower(o.slug::text) = lower(trim(p_org_slug))
    and lower(b.slug::text) = lower(trim(p_branch_slug))
    and o.status = 'active' and o.deleted_at is null
    and b.is_active and b.deleted_at is null
  limit 1;
$$;

/** Is online ordering switched on for this organization? Default off. */
create or replace function app.restaurant_online_enabled(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select (s.value #>> '{}')::boolean from public.settings s
      where s.organization_id = p_org and s.branch_id is null
        and s.key = 'restaurant.online_ordering_enabled'),
    false);
$$;

/** The branch's delivery fee, in minor units. Server-read, never client-sent. */
create or replace function app.restaurant_delivery_fee(p_org uuid, p_branch uuid)
returns bigint language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select (s.value #>> '{}')::bigint from public.settings s
      where s.organization_id = p_org and s.branch_id = p_branch
        and s.key = 'restaurant.delivery_fee_cents'),
    (select (s.value #>> '{}')::bigint from public.settings s
      where s.organization_id = p_org and s.branch_id is null
        and s.key = 'restaurant.delivery_fee_cents'),
    0);
$$;

-- ---------------------------------------------------------------------------
-- Public menu for a storefront.
--
-- Returns only what a menu needs to render. No costs, no internal notes, no
-- ids beyond the ones the guest must send back to order.
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
  if not app.restaurant_online_enabled(v.org_id) then
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
       -- Absence of an availability row means available, matching the QR menu.
       and not exists (
         select 1 from public.restaurant_branch_availability a
          where a.branch_id = v.branch_id and a.variant_id = vr.id and not a.is_available)
     order by c.sort_order nulls last, p.sort_order, vr.sort_order;
end;
$$;

/** Modifier groups and options for the products on a storefront's menu. */
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
  if v.org_id is null or not app.restaurant_online_enabled(v.org_id) then
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

-- ---------------------------------------------------------------------------
-- Price a cart without placing it.
--
-- The cart itself lives in the guest's browser; this is what makes it
-- trustworthy. The same validation the checkout performs runs here, against
-- current menu data, so the figure shown in the cart is the figure that will
-- be charged — and a tampered cart is rejected before the guest ever reaches
-- checkout rather than at the till.
--
-- It writes nothing. The order it builds to compute the numbers is rolled back
-- by the exception at the end of the block.
-- ---------------------------------------------------------------------------
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
  if v.org_id is null or not app.restaurant_online_enabled(v.org_id) then
    raise exception 'storefront not found' using errcode = 'check_violation';
  end if;
  if p_fulfillment not in ('pickup', 'delivery') then
    raise exception 'invalid fulfilment type' using errcode = 'check_violation';
  end if;

  v_fee := case when p_fulfillment = 'delivery'
                then app.restaurant_delivery_fee(v.org_id, v.branch_id) else 0 end;

  -- Priced by building a real order in a savepoint and reading the totals the
  -- database derives, so quoting and charging cannot drift apart. The
  -- savepoint is released by the rollback below; nothing survives.
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

    -- Discard the scratch order. Deleting it inside the same statement keeps
    -- the quote read-only from the caller's point of view.
    delete from public.restaurant_orders where id = v_order;
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- Checkout.
--
-- Returns an opaque token, the human order number, and the total the database
-- computed. The token is the guest's only handle on the order: it carries no
-- organization, no ids, no prices — it is 24 random bytes, and the order it
-- refers to is looked up server-side.
-- ---------------------------------------------------------------------------
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
  if not app.restaurant_online_enabled(v.org_id) then
    raise exception 'online ordering is not enabled' using errcode = 'check_violation';
  end if;
  if p_fulfillment not in ('pickup', 'delivery') then
    raise exception 'invalid fulfilment type' using errcode = 'check_violation';
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

  -- Retry of a checkout we already accepted: hand back the original order
  -- rather than creating a second one. Checked before any write.
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

  -- Caps what one storefront can accumulate between rate-limit windows.
  select count(*) into v_open
    from public.restaurant_orders
   where organization_id = v.org_id and channel = 'online'
     and status = 'new' and placed_at > now() - interval '1 hour';
  if v_open >= 200 then
    raise exception 'too many open online orders' using errcode = 'check_violation';
  end if;

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
     -- The window. now() is the transaction clock on the server; no caller can
     -- influence it, and the trigger from 0036 freezes it from here on.
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

  -- The guest's capability token. Opaque, single-purpose, revocable.
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

  -- Notification seam. A pending row in the existing outbox; a later worker
  -- delivers it. Nothing here knows about WhatsApp, SMS or email.
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
-- Follow one order, by token.
--
-- Resolves the token to exactly one order. There is no way to ask for another:
-- the order id never appears in the request.
-- ---------------------------------------------------------------------------
create or replace function app.restaurant_order_for_token(p_token text)
returns uuid language sql stable security definer set search_path = '' as $$
  select (pl.target ->> 'entity_id')::uuid
  from public.public_links pl
  where pl.token = p_token
    and pl.kind = 'order_status'
    and pl.is_active and pl.revoked_at is null
    and (pl.expires_at is null or pl.expires_at > now())
    and pl.target ->> 'entity_type' = 'restaurant_order'
  limit 1;
$$;

create or replace function public.restaurant_online_order_status(p_token text)
returns table (
  number text, status text, type text,
  subtotal_cents bigint, tax_cents bigint, delivery_fee_cents bigint, total_cents bigint,
  currency char(3), placed_at timestamptz, customer_edit_until timestamptz,
  can_edit boolean, seconds_left int
)
language sql stable security definer set search_path = '' as $$
  select o.number, o.status, o.type,
         o.subtotal_cents, o.tax_cents, o.delivery_fee_cents, o.total_cents,
         o.currency, o.placed_at, o.customer_edit_until,
         (o.status = 'new' and o.customer_edit_until > now()),
         greatest(0, floor(extract(epoch from (o.customer_edit_until - now())))::int)
    from public.restaurant_orders o
   where o.id = app.restaurant_order_for_token(p_token)
     and o.channel = 'online';
$$;

/** The lines of one order, for the guest's confirmation screen. */
create or replace function public.restaurant_online_order_items(p_token text)
returns table (product_name text, variant_name text, quantity numeric,
               line_total_cents bigint, note text)
language sql stable security definer set search_path = '' as $$
  select i.product_name, i.variant_name, i.quantity, i.line_total_cents, i.note
    from public.restaurant_order_items i
   where i.order_id = app.restaurant_order_for_token(p_token)
   order by i.position;
$$;

-- ---------------------------------------------------------------------------
-- Customer self-service, inside the window.
--
-- Both check the same two things: the order is still 'new', and the server's
-- own clock has not passed the deadline written at creation. There is no
-- parameter either could accept that would change that answer.
-- ---------------------------------------------------------------------------
create or replace function app.restaurant_assert_editable(p_order uuid)
returns void language plpgsql stable security definer set search_path = '' as $$
declare v record;
begin
  select status, customer_edit_until, channel into v
    from public.restaurant_orders where id = p_order;

  if v is null or v.channel <> 'online' then
    raise exception 'order not found' using errcode = 'check_violation';
  end if;
  if v.status <> 'new' then
    raise exception 'the restaurant has already started this order'
      using errcode = 'check_violation';
  end if;
  if v.customer_edit_until is null or v.customer_edit_until <= now() then
    raise exception 'the time to change this order has passed'
      using errcode = 'check_violation';
  end if;
end;
$$;

create or replace function public.restaurant_online_edit_order(
  p_token text, p_items jsonb
)
returns table (out_number text, out_total_cents bigint)
language plpgsql security definer set search_path = '' as $$
declare
  v_order uuid;
  v_org   uuid;
  v_branch uuid;
begin
  v_order := app.restaurant_order_for_token(p_token);
  if v_order is null then
    raise exception 'order not found' using errcode = 'check_violation';
  end if;
  perform app.restaurant_assert_editable(v_order);

  select organization_id, branch_id into v_org, v_branch
    from public.restaurant_orders where id = v_order;

  -- Rebuild the lines from scratch through the shared builder, so an edit is
  -- validated and priced exactly as the original order was.
  delete from public.restaurant_order_items where order_id = v_order;
  perform app.restaurant_build_order_lines(v_org, v_branch, v_order, p_items);

  insert into public.audit_logs
    (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  select v_org, v_branch, null, 'restaurant.online_order.customer_edited',
         'restaurant_order', v_order::text,
         jsonb_build_object('total_cents', o.total_cents)
    from public.restaurant_orders o where o.id = v_order;

  return query
    select o.number, o.total_cents from public.restaurant_orders o where o.id = v_order;
end;
$$;

create or replace function public.restaurant_online_cancel_order(
  p_token text, p_reason text default null
)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_order uuid;
  v_org   uuid;
  v_branch uuid;
begin
  v_order := app.restaurant_order_for_token(p_token);
  if v_order is null then
    raise exception 'order not found' using errcode = 'check_violation';
  end if;
  perform app.restaurant_assert_editable(v_order);

  select organization_id, branch_id into v_org, v_branch
    from public.restaurant_orders where id = v_order;

  -- 'new' → 'cancelled' is already a legal transition, so the existing trigger
  -- stamps cancelled_at and the state machine is not bypassed.
  update public.restaurant_orders
     set status = 'cancelled',
         cancel_reason = coalesce(nullif(trim(p_reason), ''), 'ألغى العميل الطلب')
   where id = v_order;

  insert into public.audit_logs
    (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values (v_org, v_branch, null, 'restaurant.online_order.customer_cancelled',
          'restaurant_order', v_order::text,
          jsonb_build_object('reason', p_reason));

  insert into public.notifications
    (organization_id, branch_id, channel, template, payload)
  values (v_org, v_branch, 'inapp', 'restaurant.online_order.cancelled',
          jsonb_build_object('order_id', v_order));
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants.
--
-- Guest-facing only. None of these touch a table the caller could reach
-- directly, and none accept an organization id.
-- ---------------------------------------------------------------------------
do $$
declare fn text;
begin
  foreach fn in array array[
    'public.restaurant_online_menu(text, text)',
    'public.restaurant_online_modifiers(text, text)',
    'public.restaurant_price_online_cart(text, text, jsonb, text)',
    'public.restaurant_place_online_order(text, text, jsonb, text, text, text, text, jsonb, text)',
    'public.restaurant_online_order_status(text)',
    'public.restaurant_online_order_items(text)',
    'public.restaurant_online_edit_order(text, jsonb)',
    'public.restaurant_online_cancel_order(text, text)'
  ]
  loop
    execute format('revoke all on function %s from public', fn);
    execute format('grant execute on function %s to anon, authenticated', fn);
  end loop;
end $$;

-- Private helpers stay private: `app` is not exposed through PostgREST, and
-- these are revoked from every client role besides.
revoke all on function app.restaurant_online_branch(text, text)   from public, anon, authenticated;
revoke all on function app.restaurant_online_enabled(uuid)        from public, anon, authenticated;
revoke all on function app.restaurant_delivery_fee(uuid, uuid)    from public, anon, authenticated;
revoke all on function app.restaurant_order_for_token(text)       from public, anon, authenticated;
revoke all on function app.restaurant_assert_editable(uuid)       from public, anon, authenticated;
