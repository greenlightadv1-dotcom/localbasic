-- ---------------------------------------------------------------------------
-- 0086: automated WhatsApp verification via a self-hosted gateway webhook
-- (Evolution API / Baileys style — no Meta Cloud API, no Twilio).
--
-- Flips the sequencing from the previous design: instead of verifying a
-- device BEFORE an order exists, the order is created immediately, carrying
-- its own verification_code, at a NEW status — 'pending_verification' — that
-- sits before 'new'. A first-time (device, phone) pair lands here; an
-- already-trusted one still goes straight to 'new', unchanged.
--
-- The webhook (a Next.js route, guarded by a shared secret — not part of
-- this migration) receives the gateway's forwarded WhatsApp message, extracts
-- "VERIFY-<BRANCH_CODE>-<CODE>", and calls restaurant_whatsapp_verify_webhook
-- below, which finds the matching pending order by (branch, code, phone),
-- flips it to 'new', and marks the device trusted — the same two effects the
-- cashier's manual "confirm via WhatsApp" button already has, just automatic.
-- The existing order-status broadcast (0067, app.broadcast_order_status)
-- fires on this transition like any other, which is what the storefront's
-- realtime listener rides on.
-- ---------------------------------------------------------------------------

alter table public.restaurant_orders
  add column verification_code text,
  add column verification_code_expires_at timestamptz;

alter table public.restaurant_orders drop constraint restaurant_orders_status_check;
alter table public.restaurant_orders add constraint restaurant_orders_status_check
  check (status = any (array[
    'pending_verification', 'new', 'confirmed', 'preparing', 'ready',
    'served', 'completed', 'cancelled'
  ]));

create or replace function app.check_order_transition()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  allowed text[];
begin
  if new.status = old.status then
    return new;
  end if;
  allowed := case old.status
    when 'pending_verification' then array['new','cancelled']
    when 'new'       then array['confirmed','cancelled']
    when 'confirmed' then array['preparing','ready','cancelled']
    when 'preparing' then array['ready','cancelled']
    when 'ready'     then array['served','cancelled']
    when 'served'    then array['completed']
    else array[]::text[]
  end;
  if not (new.status = any(allowed)) then
    raise exception 'invalid order transition % → %', old.status, new.status
      using errcode = 'check_violation';
  end if;
  new.confirmed_at := case when new.status = 'confirmed' then now() else new.confirmed_at end;
  new.ready_at     := case when new.status = 'ready'     then now() else new.ready_at end;
  new.served_at    := case when new.status = 'served'    then now() else new.served_at end;
  new.completed_at := case when new.status = 'completed' then now() else new.completed_at end;
  new.cancelled_at := case when new.status = 'cancelled' then now() else new.cancelled_at end;
  return new;
end;
$$;

-- A cashier's manual override (dashboard "confirm via WhatsApp" button) can
-- now also advance pending_verification → new; 'confirmed' itself is still
-- the only transition requiring restaurant.order.update beyond this one.
create or replace function public.restaurant_set_order_status(
  p_org uuid, p_order uuid, p_status text, p_reason text default null
) returns table (out_status text)
language plpgsql security definer set search_path = '' as $$
declare
  v_user   uuid := auth.uid();
  v_order  record;
  v_needed text;
  v_ok     boolean;
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  select id, branch_id, status, table_id, total_cents, invoice_id
    into v_order
    from public.restaurant_orders
   where id = p_order and organization_id = p_org;
  if v_order.id is null then
    raise exception 'order not found' using errcode = 'check_violation';
  end if;

  v_needed := case p_status
    when 'new'       then 'restaurant.order.update'
    when 'confirmed' then 'restaurant.order.update'
    when 'preparing' then 'restaurant.kitchen.use'
    when 'ready'     then 'restaurant.kitchen.use'
    when 'served'    then 'restaurant.service.use'
    when 'completed' then 'restaurant.pos.use'
    when 'cancelled' then 'restaurant.order.cancel'
    else null
  end;
  if v_needed is null then
    raise exception 'unknown order status %', p_status using errcode = '22023';
  end if;

  v_ok := app.has_branch_permission(p_org, v_order.branch_id, v_needed);
  if not v_ok and p_status = 'confirmed' then
    v_ok := app.has_branch_permission(p_org, v_order.branch_id, 'restaurant.pos.use')
         or app.has_branch_permission(p_org, v_order.branch_id, 'restaurant.service.use');
  end if;
  if not v_ok and v_needed = 'restaurant.kitchen.use' then
    v_ok := app.has_branch_permission(p_org, v_order.branch_id, 'restaurant.bar.use');
  end if;
  if not v_ok then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  if p_status = 'cancelled' and nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'a cancellation needs a reason' using errcode = 'check_violation';
  end if;

  if p_status = 'cancelled' and v_order.invoice_id is not null then
    raise exception 'a paid order cannot be cancelled — issue a refund'
      using errcode = 'check_violation';
  end if;

  if p_status = 'completed' and v_order.invoice_id is null and v_order.total_cents > 0 then
    raise exception 'the order must be paid before it is completed'
      using errcode = 'check_violation';
  end if;

  update public.restaurant_orders
     set status = p_status,
         guest_verified = case when p_status = 'new' then true else guest_verified end,
         cancel_reason = case when p_status = 'cancelled' then p_reason else cancel_reason end
   where id = p_order;

  if v_order.table_id is not null and p_status in ('completed', 'cancelled') then
    update public.restaurant_tables
       set status = 'cleaning'
     where id = v_order.table_id and status in ('occupied', 'waiting_payment');
  end if;

  insert into public.audit_logs
    (organization_id, branch_id, actor_id, action, entity_type, entity_id, before, after)
  values
    (p_org, v_order.branch_id, v_user, 'restaurant.order.status', 'restaurant_order',
     p_order::text,
     jsonb_build_object('status', v_order.status),
     jsonb_build_object('status', p_status, 'reason', p_reason));

  return query select p_status;
end;
$$;

-- The cashier's dedicated verify action also flips pending_verification → new,
-- not just the guest_verified flag — it is the manual fallback for the
-- automated webhook below.
create or replace function public.restaurant_guest_verify_order(
  p_org uuid, p_order uuid
) returns table (out_verified boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_branch uuid;
  v_device text;
  v_phone  text;
  v_status text;
  v_user   uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  select branch_id, device_id, guest_phone, status into v_branch, v_device, v_phone, v_status
    from public.restaurant_orders
   where id = p_order and organization_id = p_org;
  if v_branch is null then
    raise exception 'order not found' using errcode = 'check_violation';
  end if;

  if not app.has_branch_permission(p_org, v_branch, 'restaurant.order.update') then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  update public.restaurant_orders
     set guest_verified = true,
         status = case when status = 'pending_verification' then 'new' else status end
   where id = p_order;

  if v_device is not null and v_phone is not null then
    insert into public.restaurant_guest_devices (organization_id, device_id, phone, verified_at)
    values (p_org, v_device, v_phone, now())
    on conflict (organization_id, device_id, phone) do update set verified_at = now();
  end if;

  insert into public.audit_logs
    (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, v_branch, v_user, 'restaurant.order.guest_verified', 'restaurant_order', p_order::text,
    jsonb_build_object('device_id', v_device));

  return query select true;
end;
$$;

-- ---------------------------------------------------------------------------
-- restaurant_place_public_order (QR/in-store): same 8-arg signature as 0081.
-- An untrusted device with a phone now gets a verification code and starts
-- at 'pending_verification' instead of 'new'; everything else is unchanged.
-- ---------------------------------------------------------------------------
create or replace function public.restaurant_place_public_order(
  p_token       text,
  p_items       jsonb,
  p_guest_name  text default null,
  p_guest_phone text default null,
  p_note        text default null,
  p_device_id   text default null,
  p_latitude    numeric default null,
  p_longitude   numeric default null
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
  v_phone    text;
  v_geo      record;
  v_distance numeric;
  v_status   text := 'unknown';
  v_verified boolean := true;
  v_code     text;
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
  where table_id = v_table and status in ('new', 'pending_verification')
    and placed_at > now() - interval '1 hour';
  if v_open >= 10 then
    raise exception 'too many open orders for this table' using errcode = 'check_violation';
  end if;

  select * into v_geo from app.restaurant_geofence(v_org, v_branch);
  if v_geo.lat is not null and p_latitude is not null and p_longitude is not null then
    v_distance := app.restaurant_distance_m(v_geo.lat, v_geo.lng, p_latitude, p_longitude);
    if v_distance <= v_geo.radius_m then v_status := 'inside';
    elsif v_distance <= v_geo.radius_m * 3 then v_status := 'nearby';
    else v_status := 'far'; end if;
    if v_status = 'far' then
      raise exception 'you do not appear to be at the restaurant' using errcode = 'check_violation';
    end if;
  end if;

  v_phone := nullif(trim(coalesce(p_guest_phone, '')), '');
  if p_device_id is not null and v_phone is not null then
    insert into public.restaurant_guest_devices (organization_id, device_id, phone, last_order_at)
    values (v_org, p_device_id, v_phone, now())
    on conflict (organization_id, device_id, phone) do update set last_order_at = now();

    select (verified_at is not null) into v_verified
      from public.restaurant_guest_devices
     where organization_id = v_org and device_id = p_device_id and phone = v_phone;
  end if;

  if not coalesce(v_verified, true) then
    v_code := lpad((floor(random() * 1000000))::text, 6, '0');
  end if;

  v_number := app.next_document_number(v_org, v_branch, 'restaurant_order');

  insert into public.restaurant_orders
    (organization_id, branch_id, table_id, number, channel, type, status,
     guest_name, guest_phone, note, currency, customer_edit_until, created_by,
     device_id, guest_verified, customer_latitude, customer_longitude,
     location_distance_m, location_status, verification_code, verification_code_expires_at)
  values
    (v_org, v_branch, v_table, v_number, 'qr', 'dine_in',
     case when coalesce(v_verified, true) then 'new' else 'pending_verification' end,
     nullif(trim(coalesce(p_guest_name, '')), ''),
     v_phone,
     nullif(trim(coalesce(p_note, '')), ''),
     v_currency, now() + interval '60 seconds', null,
     p_device_id, coalesce(v_verified, true), p_latitude, p_longitude,
     case when v_distance is not null then round(v_distance)::int else null end, v_status,
     v_code, case when v_code is not null then now() + interval '10 minutes' else null end)
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

-- ---------------------------------------------------------------------------
-- restaurant_place_online_order: same 13-arg signature as 0085. Same change:
-- an untrusted device/phone starts at 'pending_verification' with a code.
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
  p_note            text default null,
  p_saved_address_id uuid default null,
  p_device_id       text default null,
  p_latitude        numeric default null,
  p_longitude       numeric default null
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
  v_customer uuid;
  v_saved_id        uuid;
  v_saved_recipient text;
  v_saved_phone     text;
  v_saved_city      text;
  v_saved_area      text;
  v_saved_address   text;
  v_saved_landmark  text;
  v_phone    text;
  v_geo      record;
  v_distance numeric;
  v_status   text := 'unknown';
  v_verified boolean := true;
  v_city     text;
  v_cities   text[];
  v_code     text;
begin
  select * into v from app.restaurant_online_branch(p_org_slug, p_branch_slug);
  if v.org_id is null then
    raise exception 'storefront not found' using errcode = 'check_violation';
  end if;
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

  if auth.uid() is not null then
    v_customer := app.customer_row_ensure(v.org_id, p_customer_name, p_customer_phone);
  end if;

  if p_saved_address_id is not null then
    if v_customer is null then
      raise exception 'sign in required to use a saved address' using errcode = 'check_violation';
    end if;
    select a.id, a.recipient_name, a.phone, a.city, a.area, a.address, a.landmark
      into v_saved_id, v_saved_recipient, v_saved_phone, v_saved_city,
           v_saved_area, v_saved_address, v_saved_landmark
      from public.customer_addresses a
     where a.id = p_saved_address_id and a.customer_id = v_customer;
    if v_saved_id is null then
      raise exception 'العنوان غير موجود' using errcode = 'check_violation';
    end if;
  end if;

  if p_fulfillment = 'delivery' and p_address is null and v_saved_id is null then
    raise exception 'a delivery order needs an address' using errcode = 'check_violation';
  end if;

  select count(*) into v_open
    from public.restaurant_orders
   where organization_id = v.org_id and channel = 'online'
     and status in ('new', 'pending_verification') and placed_at > now() - interval '1 hour';
  if v_open >= 200 then
    raise exception 'too many open online orders' using errcode = 'check_violation';
  end if;

  select * into v_geo from app.restaurant_geofence(v.org_id, v.branch_id);
  if v_geo.lat is not null and p_latitude is not null and p_longitude is not null then
    v_distance := app.restaurant_distance_m(v_geo.lat, v_geo.lng, p_latitude, p_longitude);
    if v_distance <= v_geo.radius_m then v_status := 'inside';
    elsif v_distance <= greatest(v_geo.radius_m * 3, 15000) then v_status := 'nearby';
    else v_status := 'far'; end if;
  end if;

  v_cities := app.restaurant_service_cities(v.org_id, v.branch_id);
  if p_fulfillment = 'delivery' and coalesce(array_length(v_cities, 1), 0) > 0 then
    v_city := nullif(trim(coalesce(v_saved_city, p_address ->> 'city', '')), '');
    if v_city is not null and not exists (
      select 1 from unnest(v_cities) c where lower(trim(c)) = lower(v_city)
    ) then
      v_status := 'far';
    end if;
  end if;

  v_phone := nullif(left(trim(coalesce(p_customer_phone, '')), 32), '');
  if p_device_id is not null and v_phone is not null then
    insert into public.restaurant_guest_devices (organization_id, device_id, phone, last_order_at)
    values (v.org_id, p_device_id, v_phone, now())
    on conflict (organization_id, device_id, phone) do update set last_order_at = now();

    select (verified_at is not null) into v_verified
      from public.restaurant_guest_devices
     where organization_id = v.org_id and device_id = p_device_id and phone = v_phone;
  end if;

  if not coalesce(v_verified, true) then
    v_code := lpad((floor(random() * 1000000))::text, 6, '0');
  end if;

  v_fee := case when p_fulfillment = 'delivery'
                then app.restaurant_delivery_fee(v.org_id, v.branch_id) else 0 end;

  v_number := app.next_document_number(v.org_id, v.branch_id, 'restaurant_order');

  insert into public.restaurant_orders
    (organization_id, branch_id, number, channel, type, status,
     customer_id, guest_name, guest_phone, note, currency, delivery_fee_cents,
     idempotency_key, customer_edit_until, created_by,
     device_id, guest_verified, customer_latitude, customer_longitude,
     location_distance_m, location_status, verification_code, verification_code_expires_at)
  values
    (v.org_id, v.branch_id, v_number, 'online', p_fulfillment,
     case when coalesce(v_verified, true) then 'new' else 'pending_verification' end,
     v_customer,
     left(trim(p_customer_name), 120), v_phone,
     nullif(left(trim(coalesce(p_note, '')), 500), ''),
     v.currency, v_fee, trim(p_idempotency_key),
     now() + interval '60 seconds',
     null,
     p_device_id, coalesce(v_verified, true), p_latitude, p_longitude,
     case when v_distance is not null then round(v_distance)::int else null end, v_status,
     v_code, case when v_code is not null then now() + interval '10 minutes' else null end)
  returning id into v_order;

  perform app.restaurant_build_order_lines(v.org_id, v.branch_id, v_order, p_items);

  if p_fulfillment = 'delivery' then
    insert into public.restaurant_order_deliveries
      (order_id, organization_id, branch_id, recipient_name, phone,
       city, area, address, landmark, latitude, longitude, notes)
    values (
      v_order, v.org_id, v.branch_id,
      left(trim(coalesce(v_saved_recipient, p_address ->> 'recipient_name', p_customer_name)), 120),
      left(trim(coalesce(v_saved_phone, p_address ->> 'phone', p_customer_phone)), 32),
      nullif(left(trim(coalesce(v_saved_city, p_address ->> 'city', '')), 120), ''),
      nullif(left(trim(coalesce(v_saved_area, p_address ->> 'area', '')), 120), ''),
      left(trim(coalesce(v_saved_address, p_address ->> 'address', '')), 500),
      nullif(left(trim(coalesce(v_saved_landmark, p_address ->> 'landmark', '')), 240), ''),
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
  select v.org_id, v.branch_id, auth.uid(), 'restaurant.online_order.created',
         'restaurant_order', v_order::text,
         jsonb_build_object('number', v_number, 'channel', 'online',
                            'type', p_fulfillment, 'total_cents', o.total_cents,
                            'account', v_customer is not null)
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
-- Verification info for the status-token page/sheet: what to show while the
-- order sits at 'pending_verification', read the same way the tracking page
-- already resolves its token.
-- ---------------------------------------------------------------------------
create or replace function public.restaurant_order_verification_info(p_token text)
returns table (out_status text, out_code text, out_whatsapp text, out_expires_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_order_id uuid;
begin
  select (pl.target ->> 'entity_id')::uuid into v_order_id
    from public.public_links pl
   where pl.token = p_token and pl.kind = 'order_status'
     and pl.is_active and pl.revoked_at is null
     and (pl.expires_at is null or pl.expires_at > now());
  if v_order_id is null then
    raise exception 'order not found' using errcode = 'check_violation';
  end if;

  return query
    select o.status, o.verification_code, bs.whatsapp, o.verification_code_expires_at
    from public.restaurant_orders o
    left join public.branding_settings bs on bs.organization_id = o.organization_id
    where o.id = v_order_id;
end;
$$;
revoke all on function public.restaurant_order_verification_info(text) from public;
grant execute on function public.restaurant_order_verification_info(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- The webhook's own RPC. Called only from the Next.js route after it has
-- already checked a shared secret — this function itself trusts its three
-- plain-text inputs completely, which is why it is never reachable except
-- through that gated route.
--
-- Matching is (branch_code, code, last-9-digits-of-phone) rather than an
-- exact phone match: a self-hosted gateway reports the sender in whatever
-- format WhatsApp gives it (full international, no '+'), which rarely equals
-- the string a guest typed into the checkout form byte-for-byte. `limit`-less
-- counting first, requiring exactly one match, keeps a same-branch,
-- same-minute coincidence from silently verifying the wrong order.
-- ---------------------------------------------------------------------------
create or replace function public.restaurant_whatsapp_verify_webhook(
  p_branch_code text, p_code text, p_phone text
) returns table (out_matched boolean, out_order_number text)
language plpgsql security definer set search_path = '' as $$
declare
  v_phone_digits text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  v_code         text := upper(trim(coalesce(p_code, '')));
  v_branch_code  text := upper(regexp_replace(coalesce(p_branch_code, ''), '[^a-zA-Z0-9]', '', 'g'));
  v_count    int;
  v_order_id uuid;
  v_branch_id uuid;
  v_org_id   uuid;
  v_device   text;
  v_phone    text;
  v_number   text;
begin
  if length(v_phone_digits) < 6 or length(v_code) = 0 or length(v_branch_code) = 0 then
    return query select false, null::text;
    return;
  end if;

  select count(*) into v_count
    from public.restaurant_orders o
    join public.branches b on b.id = o.branch_id
   where o.status = 'pending_verification'
     and o.verification_code = v_code
     and o.verification_code_expires_at > now()
     and upper(regexp_replace(b.slug::text, '[^a-zA-Z0-9]', '', 'g')) = v_branch_code
     and right(regexp_replace(coalesce(o.guest_phone, ''), '\D', '', 'g'), 9) = right(v_phone_digits, 9);

  if v_count <> 1 then
    return query select false, null::text;
    return;
  end if;

  select o.id, o.branch_id, o.organization_id, o.device_id, o.guest_phone, o.number
    into v_order_id, v_branch_id, v_org_id, v_device, v_phone, v_number
    from public.restaurant_orders o
    join public.branches b on b.id = o.branch_id
   where o.status = 'pending_verification'
     and o.verification_code = v_code
     and o.verification_code_expires_at > now()
     and upper(regexp_replace(b.slug::text, '[^a-zA-Z0-9]', '', 'g')) = v_branch_code
     and right(regexp_replace(coalesce(o.guest_phone, ''), '\D', '', 'g'), 9) = right(v_phone_digits, 9);

  update public.restaurant_orders
     set status = 'new', guest_verified = true
   where id = v_order_id;

  if v_device is not null and v_phone is not null then
    insert into public.restaurant_guest_devices (organization_id, device_id, phone, verified_at)
    values (v_org_id, v_device, v_phone, now())
    on conflict (organization_id, device_id, phone) do update set verified_at = now();
  end if;

  insert into public.audit_logs
    (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values (v_org_id, v_branch_id, null, 'restaurant.order.whatsapp_verified', 'restaurant_order',
    v_order_id::text, jsonb_build_object('phone', v_phone));

  return query select true, v_number;
end;
$$;
revoke all on function public.restaurant_whatsapp_verify_webhook(text, text, text) from public, authenticated;
grant execute on function public.restaurant_whatsapp_verify_webhook(text, text, text) to anon;
