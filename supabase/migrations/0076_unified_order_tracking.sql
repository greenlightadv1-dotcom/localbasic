-- =============================================================================
-- LOCAL BASIC — 0076 One tracking page for every ordering channel
--
-- /order/track/[token] (0037/0040) already has everything a live order needs:
-- a capability token nobody can guess, a realtime status channel
-- (app.broadcast_order_status, 0067), a 60-second edit/cancel window. It was
-- built for 'online' (pickup/delivery) orders only. A guest who scans a
-- table's QR code and orders through restaurant_place_public_order (0022)
-- gets none of that — the guest-menu screen shows a static "order received"
-- message and nothing ever updates it, and the "status token" it hands back
-- is literally the order NUMBER (guessable/sequential), not a real capability
-- token at all.
--
-- Rather than build a second tracking mechanism for the QR channel, this
-- widens the three gates that were hard-coded to `channel = 'online'` so a
-- 'qr' order is treated exactly the same way, and makes
-- restaurant_place_public_order mint the same kind of public_links
-- ('order_status') capability token online orders already mint. Everything
-- downstream — the tracking page, the realtime channel, the edit window,
-- cancel — needed no changes at all: they were already generic over "the
-- order this token names", not "the order this ONLINE token names".
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. The tracking page's status read: 'qr' joins 'online'.
-- ---------------------------------------------------------------------------
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
     and o.channel in ('online', 'qr');
$$;

-- ---------------------------------------------------------------------------
-- 2. The single edit/cancel gate both restaurant_online_edit_order and
--    restaurant_online_cancel_order already share: same widening, so a table
--    guest gets the same 60-second grace window a delivery guest does.
-- ---------------------------------------------------------------------------
create or replace function app.restaurant_assert_editable(p_order uuid)
returns void language plpgsql stable security definer set search_path = '' as $$
declare v record;
begin
  select status, customer_edit_until, channel into v
    from public.restaurant_orders where id = p_order;

  if v is null or v.channel not in ('online', 'qr') then
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

-- ---------------------------------------------------------------------------
-- 3. restaurant_place_public_order: a real capability token instead of the
--    order number, and the 60-second edit window every other channel gets.
--    Signature and output columns are unchanged, so the existing grants
--    (0022) still apply — out_status_token simply carries a different,
--    actually-opaque value now.
-- ---------------------------------------------------------------------------
create or replace function public.restaurant_place_public_order(
  p_token       text,
  p_items       jsonb,
  p_guest_name  text default null,
  p_guest_phone text default null,
  p_note        text default null
)
returns table (out_order_number text, out_total_cents bigint, out_status_token text)
language plpgsql security definer set search_path = '' as $$
declare
  v_org      uuid;
  v_branch   uuid;
  v_table    uuid;
  v_currency char(3);
  v_enabled  boolean;
  v_order    uuid;
  v_number   text;
  v_total    bigint;
  v_open     int;
  v_token    text;
begin
  select pl.organization_id, pl.branch_id, t.id, o.currency
    into v_org, v_branch, v_table, v_currency
  from public.public_links pl
  join public.organizations o on o.id = pl.organization_id
  join public.branches b on b.id = pl.branch_id
  join public.restaurant_tables t
    on t.id = (pl.target ->> 'entity_id')::uuid and t.branch_id = pl.branch_id
  where pl.token = p_token
    and pl.kind = 'menu'
    and pl.is_active and pl.revoked_at is null
    and (pl.expires_at is null or pl.expires_at > now())
    and o.status = 'active' and o.deleted_at is null
    and b.is_active and b.deleted_at is null
    and t.is_active and t.deleted_at is null;

  if v_org is null then
    raise exception 'this QR code is no longer active' using errcode = 'check_violation';
  end if;

  select coalesce((select (s.value #>> '{}')::boolean from public.settings s
                    where s.organization_id = v_org and s.branch_id is null
                      and s.key = 'restaurant.public_ordering_enabled'), true)
    into v_enabled;
  if not v_enabled then
    raise exception 'ordering from the QR code is disabled' using errcode = 'check_violation';
  end if;

  select count(*) into v_open
  from public.restaurant_orders
  where table_id = v_table and status = 'new' and placed_at > now() - interval '1 hour';
  if v_open >= 10 then
    raise exception 'too many open orders for this table' using errcode = 'check_violation';
  end if;

  v_number := app.next_document_number(v_org, v_branch, 'restaurant_order');

  insert into public.restaurant_orders
    (organization_id, branch_id, table_id, number, channel, type, status,
     guest_name, guest_phone, note, currency, customer_edit_until, created_by)
  values
    (v_org, v_branch, v_table, v_number, 'qr', 'dine_in', 'new',
     nullif(trim(coalesce(p_guest_name, '')), ''),
     nullif(trim(coalesce(p_guest_phone, '')), ''),
     nullif(trim(coalesce(p_note, '')), ''),
     v_currency, now() + interval '60 seconds', null)
  returning id into v_order;

  perform app.restaurant_build_order_lines(v_org, v_branch, v_order, p_items);

  select total_cents into v_total from public.restaurant_orders where id = v_order;

  update public.restaurant_tables
     set status = 'occupied'
   where id = v_table and status in ('available', 'reserved');

  v_token := app.new_public_token();
  insert into public.public_links
    (organization_id, branch_id, kind, token, target, label, expires_at)
  values (
    v_org, v_branch, 'order_status', v_token,
    jsonb_build_object('entity_type', 'restaurant_order', 'entity_id', v_order),
    v_number, now() + interval '30 days'
  );

  insert into public.audit_logs
    (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values
    (v_org, v_branch, null, 'restaurant.order.created', 'restaurant_order', v_order::text,
     jsonb_build_object('number', v_number, 'channel', 'qr', 'total_cents', v_total));

  return query select v_number, v_total, v_token;
end;
$$;
