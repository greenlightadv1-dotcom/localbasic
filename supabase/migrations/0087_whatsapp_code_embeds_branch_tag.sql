-- ---------------------------------------------------------------------------
-- 0087: simplifies 0086's branch/code matching.
--
-- The client-side checkout components only ever hold a status token, never
-- the branch's own slug — so asking them to construct "VERIFY-<BRANCH>-<code>"
-- themselves meant plumbing the slug through an extra RPC return column,
-- which (like app.restaurant_geofence's cities column, 0085) would need a
-- DROP FUNCTION first since it reshapes a RETURNS TABLE.
--
-- Simpler: the branch tag is embedded into verification_code itself at
-- order-creation time (where the branch slug is already in scope), e.g.
-- 'MAIN-483921'. The client just displays whatever restaurant_order_
-- verification_info hands back — same RPC, same shape, nothing to change
-- there. The webhook's own signature is unchanged too (still p_branch_code,
-- p_code, p_phone) since the regex still captures two groups out of
-- "VERIFY-MAIN-483921"; it just reassembles them and matches the order's
-- verification_code directly, with no join back to branches needed.
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
  v_branch_slug text;
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
  select pl.organization_id, pl.branch_id, t.id, o.currency, b.slug::text
    into v_org, v_branch, v_table, v_currency, v_branch_slug
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
    v_code := upper(regexp_replace(v_branch_slug, '[^a-zA-Z0-9]', '', 'g'))
      || '-' || lpad((floor(random() * 1000000))::text, 6, '0');
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
    v_code := upper(regexp_replace(p_branch_slug, '[^a-zA-Z0-9]', '', 'g'))
      || '-' || lpad((floor(random() * 1000000))::text, 6, '0');
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

-- Matches the order's already-fully-tagged verification_code directly —
-- p_branch_code and p_code are reassembled into one string instead of
-- driving a join back to branches. Signature unchanged from 0086.
create or replace function public.restaurant_whatsapp_verify_webhook(
  p_branch_code text, p_code text, p_phone text
) returns table (out_matched boolean, out_order_number text)
language plpgsql security definer set search_path = '' as $$
declare
  v_phone_digits text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  v_full_code    text := upper(trim(coalesce(p_branch_code, ''))) || '-' || upper(trim(coalesce(p_code, '')));
  v_count    int;
  v_order_id uuid;
  v_branch_id uuid;
  v_org_id   uuid;
  v_device   text;
  v_phone    text;
  v_number   text;
begin
  if length(v_phone_digits) < 6 or length(trim(coalesce(p_branch_code,''))) = 0
     or length(trim(coalesce(p_code,''))) = 0 then
    return query select false, null::text;
    return;
  end if;

  select count(*) into v_count
    from public.restaurant_orders o
   where o.status = 'pending_verification'
     and o.verification_code = v_full_code
     and o.verification_code_expires_at > now()
     and right(regexp_replace(coalesce(o.guest_phone, ''), '\D', '', 'g'), 9) = right(v_phone_digits, 9);

  if v_count <> 1 then
    return query select false, null::text;
    return;
  end if;

  select o.id, o.branch_id, o.organization_id, o.device_id, o.guest_phone, o.number
    into v_order_id, v_branch_id, v_org_id, v_device, v_phone, v_number
    from public.restaurant_orders o
   where o.status = 'pending_verification'
     and o.verification_code = v_full_code
     and o.verification_code_expires_at > now()
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
