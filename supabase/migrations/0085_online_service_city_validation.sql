-- ---------------------------------------------------------------------------
-- 0085: service-city/region validation for online delivery orders.
--
-- Geofencing (0081) already flags a delivery order whose reported device
-- location is far from the branch. This adds a second, independent signal:
-- a configurable list of cities/regions the branch actually delivers to,
-- read from the same 'restaurant.geofence' settings key under a new
-- 'cities' field. Like the distance check, it is advisory only for the
-- online channel — it never blocks checkout, only flags the order the same
-- way a distant location does, because the cashier-review step (not this
-- function) is where a bad address gets caught.
--
-- A separate function rather than reshaping app.restaurant_geofence's
-- existing return columns: changing a function's OUT-parameter shape needs
-- a DROP first, which this project's current tooling could not complete
-- reliably — adding a function has no such requirement.
-- ---------------------------------------------------------------------------

create or replace function app.restaurant_service_cities(p_org uuid, p_branch uuid)
returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select array(select jsonb_array_elements_text(s.value -> 'cities')) from public.settings s
      where s.organization_id = p_org and s.branch_id = p_branch and s.key = 'restaurant.geofence'),
    (select array(select jsonb_array_elements_text(s.value -> 'cities')) from public.settings s
      where s.organization_id = p_org and s.branch_id is null and s.key = 'restaurant.geofence'),
    array[]::text[]
  );
$$;
revoke all on function app.restaurant_service_cities(uuid, uuid) from public, anon, authenticated;

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
     and status = 'new' and placed_at > now() - interval '1 hour';
  if v_open >= 200 then
    raise exception 'too many open online orders' using errcode = 'check_violation';
  end if;

  -- Advisory only, same as before: never raises. A pickup order placed from
  -- home, or a delivery address across town, is the normal case here.
  select * into v_geo from app.restaurant_geofence(v.org_id, v.branch_id);
  if v_geo.lat is not null and p_latitude is not null and p_longitude is not null then
    v_distance := app.restaurant_distance_m(v_geo.lat, v_geo.lng, p_latitude, p_longitude);
    if v_distance <= v_geo.radius_m then v_status := 'inside';
    elsif v_distance <= greatest(v_geo.radius_m * 3, 15000) then v_status := 'nearby';
    else v_status := 'far'; end if;
  end if;

  -- Service-city check (0085): a second, independent advisory signal. A
  -- delivery address outside the configured cities is flagged 'far' for the
  -- cashier even when the distance check above found nothing to say (no
  -- device coordinates, or a branch that only configured cities).
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

  v_fee := case when p_fulfillment = 'delivery'
                then app.restaurant_delivery_fee(v.org_id, v.branch_id) else 0 end;

  v_number := app.next_document_number(v.org_id, v.branch_id, 'restaurant_order');

  insert into public.restaurant_orders
    (organization_id, branch_id, number, channel, type, status,
     customer_id, guest_name, guest_phone, note, currency, delivery_fee_cents,
     idempotency_key, customer_edit_until, created_by,
     device_id, guest_verified, customer_latitude, customer_longitude,
     location_distance_m, location_status)
  values
    (v.org_id, v.branch_id, v_number, 'online', p_fulfillment, 'new',
     v_customer,
     left(trim(p_customer_name), 120), v_phone,
     nullif(left(trim(coalesce(p_note, '')), 500), ''),
     v.currency, v_fee, trim(p_idempotency_key),
     now() + interval '60 seconds',
     null,
     p_device_id, coalesce(v_verified, true), p_latitude, p_longitude,
     case when v_distance is not null then round(v_distance)::int else null end, v_status)
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
