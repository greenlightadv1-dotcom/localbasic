-- ---------------------------------------------------------------------------
-- 0081: mandatory cashier review + geofencing + zero-cost WhatsApp device
-- verification for QR and online orders.
--
-- WHAT ALREADY EXISTED (0018/0021/0022/0037/0040/0071/0080) AND IS UNCHANGED:
--   * every order — QR, online, staff — is created at status = 'new' and only
--     reaches the kitchen/bar boards (which query confirmed/preparing/ready)
--     once a cashier moves it to 'confirmed'. That IS the mandatory review
--     gate; this migration feeds it two new signals rather than replacing it.
--   * station routing (chef vs. barista) is automatic per item, from each
--     category's default_station_kind. Confirming an order is what dispatches
--     it to the right board(s); nothing here changes that.
--
-- WHAT THIS MIGRATION ADDS:
--   1. restaurant_guest_devices — a (organization, device_id, phone) trust
--      store. A device/phone pair with verified_at set is "recognised" and
--      skips verification on every later order; one without it is flagged to
--      the cashier.
--   2. Geofencing, read from the existing public.settings key/value table
--      (key 'restaurant.geofence', branch-then-organization, exactly the
--      resolution app.restaurant_delivery_fee already uses) — no branches
--      schema change needed. QR orders hard-fail outside the radius *only
--      when a branch has actually configured one*; online orders only ever
--      get an advisory flag, never a block, since a delivery address or an
--      ahead-of-time pickup is routinely far from the till.
--   3. Verification is a human check, not a fake auto-verify: there is no
--      paid WhatsApp Business API here, so no inbound message is ever read
--      by this database. A 6-digit code is generated and the guest is given
--      a wa.me click-to-chat link preaddressed to the branch's own WhatsApp
--      number (branding_settings.whatsapp, already public) with that code in
--      the prefilled text. The real verification step is the cashier reading
--      their own WhatsApp and tapping "verified" in the review queue
--      (restaurant_guest_verify_order) — which is also what flips the device
--      to "recognised" for every later order.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Device trust store.
-- ---------------------------------------------------------------------------
create table public.restaurant_guest_devices (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations(id) on delete cascade,
  device_id          text not null check (length(device_id) between 8 and 128),
  phone              text not null check (length(trim(phone)) between 6 and 32),
  verification_code  text,
  code_expires_at    timestamptz,
  attempts           int not null default 0,
  verified_at        timestamptz,
  last_order_at      timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (organization_id, device_id, phone)
);
create index restaurant_guest_devices_lookup_idx
  on public.restaurant_guest_devices(organization_id, device_id, phone);
create trigger restaurant_guest_devices_touch before update on public.restaurant_guest_devices
  for each row execute function app.touch_updated_at();

-- No policies. Every access goes through the SECURITY DEFINER functions
-- below, owned by a role that bypasses RLS entirely — the same pattern
-- restaurant_orders' own anonymous writes already rely on (0022/0037).
alter table public.restaurant_guest_devices enable row level security;

-- ---------------------------------------------------------------------------
-- 2. Order-level verification and location columns. Defaulting
--    guest_verified to true means every existing row, and every row a staff
--    channel (cashier/waiter/pos) inserts through restaurant_create_order,
--    is unaffected — the flag only ever turns false inside the two guest
--    placement functions below, for a device/phone this organization has
--    not yet seen verified.
-- ---------------------------------------------------------------------------
alter table public.restaurant_orders
  add column device_id            text,
  add column guest_verified       boolean not null default true,
  add column customer_latitude    numeric(9,6) check (customer_latitude between -90 and 90),
  add column customer_longitude   numeric(9,6) check (customer_longitude between -180 and 180),
  add column location_distance_m  integer check (location_distance_m >= 0),
  add column location_status      text not null default 'unknown'
                                   check (location_status in ('inside','nearby','far','unknown'));

-- ---------------------------------------------------------------------------
-- 3. Haversine distance in metres. Null in, null out — a caller missing
--    either point simply gets no distance, never an error.
-- ---------------------------------------------------------------------------
create or replace function app.restaurant_distance_m(
  p_lat1 numeric, p_lng1 numeric, p_lat2 numeric, p_lng2 numeric
) returns numeric
language sql immutable as $$
  select 6371000 * acos(
    greatest(-1, least(1,
      cos(radians(p_lat1)) * cos(radians(p_lat2)) * cos(radians(p_lng2) - radians(p_lng1))
      + sin(radians(p_lat1)) * sin(radians(p_lat2))
    ))
  );
$$;

-- ---------------------------------------------------------------------------
-- 4. The branch's configured geofence, resolved branch-then-organization —
--    the exact fallback app.restaurant_delivery_fee already uses. Every
--    field is null when nothing has been configured, which is the signal
--    callers use to skip geofencing entirely rather than block on a branch
--    that never set one up.
-- ---------------------------------------------------------------------------
create or replace function app.restaurant_geofence(p_org uuid, p_branch uuid)
returns table(lat numeric, lng numeric, radius_m int)
language sql stable security definer set search_path = '' as $$
  select
    coalesce(
      (select (s.value ->> 'lat')::numeric from public.settings s
        where s.organization_id = p_org and s.branch_id = p_branch and s.key = 'restaurant.geofence'),
      (select (s.value ->> 'lat')::numeric from public.settings s
        where s.organization_id = p_org and s.branch_id is null and s.key = 'restaurant.geofence')
    ) as lat,
    coalesce(
      (select (s.value ->> 'lng')::numeric from public.settings s
        where s.organization_id = p_org and s.branch_id = p_branch and s.key = 'restaurant.geofence'),
      (select (s.value ->> 'lng')::numeric from public.settings s
        where s.organization_id = p_org and s.branch_id is null and s.key = 'restaurant.geofence')
    ) as lng,
    coalesce(
      (select (s.value ->> 'radiusM')::int from public.settings s
        where s.organization_id = p_org and s.branch_id = p_branch and s.key = 'restaurant.geofence'),
      (select (s.value ->> 'radiusM')::int from public.settings s
        where s.organization_id = p_org and s.branch_id is null and s.key = 'restaurant.geofence'),
      300
    ) as radius_m;
$$;
revoke all on function app.restaurant_geofence(uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Device trust check, shared by both channels' "already recognised?"
--    probe so the guest UI can skip the verification step entirely.
-- ---------------------------------------------------------------------------
create or replace function app.restaurant_guest_device_trusted(
  p_org uuid, p_device_id text, p_phone text
) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.restaurant_guest_devices
     where organization_id = p_org and device_id = p_device_id
       and phone = trim(coalesce(p_phone, '')) and verified_at is not null
  );
$$;
revoke all on function app.restaurant_guest_device_trusted(uuid, text, text) from public, anon, authenticated;

create or replace function public.restaurant_guest_device_status_by_token(
  p_token text, p_device_id text, p_phone text
) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid;
begin
  select pl.organization_id into v_org from public.public_links pl
   where pl.token = p_token and pl.kind = 'menu'
     and pl.is_active and pl.revoked_at is null
     and (pl.expires_at is null or pl.expires_at > now());
  if v_org is null then return false; end if;
  return app.restaurant_guest_device_trusted(v_org, p_device_id, p_phone);
end;
$$;
revoke all on function public.restaurant_guest_device_status_by_token(text, text, text) from public, anon, authenticated;
grant execute on function public.restaurant_guest_device_status_by_token(text, text, text) to anon, authenticated;

create or replace function public.restaurant_guest_device_status(
  p_org_slug text, p_branch_slug text, p_device_id text, p_phone text
) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare v record;
begin
  select * into v from app.restaurant_online_branch(p_org_slug, p_branch_slug);
  if v.org_id is null then return false; end if;
  return app.restaurant_guest_device_trusted(v.org_id, p_device_id, p_phone);
end;
$$;
revoke all on function public.restaurant_guest_device_status(text, text, text, text) from public, anon, authenticated;
grant execute on function public.restaurant_guest_device_status(text, text, text, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. Issue a verification code. Shared implementation; the two public wrappers
--    below differ only in how they resolve the organization/branch (QR goes
--    through the table's public_links token, online through its slugs).
-- ---------------------------------------------------------------------------
create or replace function app.restaurant_guest_verification_issue(
  p_org uuid, p_branch uuid, p_device_id text, p_phone text
) returns table(out_code text, out_whatsapp text, out_expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  v_phone  text := trim(coalesce(p_phone, ''));
  v_code   text;
  v_recent int;
  v_whatsapp text;
begin
  if length(trim(coalesce(p_device_id, ''))) < 8 then
    raise exception 'a device id is required' using errcode = 'check_violation';
  end if;
  if length(v_phone) < 6 then
    raise exception 'a phone number is required' using errcode = 'check_violation';
  end if;

  -- Generous but bounded: this is friction against scripted abuse, not
  -- against a guest who fat-fingered their number a few times.
  select count(*) into v_recent
    from public.restaurant_guest_devices
   where organization_id = p_org and device_id = p_device_id
     and created_at > now() - interval '1 hour';
  if v_recent >= 8 then
    raise exception 'too many verification attempts' using errcode = 'check_violation';
  end if;

  v_code := lpad((floor(random() * 1000000))::text, 6, '0');

  insert into public.restaurant_guest_devices
    (organization_id, device_id, phone, verification_code, code_expires_at, attempts)
  values (p_org, p_device_id, v_phone, v_code, now() + interval '10 minutes', 0)
  on conflict (organization_id, device_id, phone) do update
    set verification_code = excluded.verification_code,
        code_expires_at   = excluded.code_expires_at
    -- An already-trusted pair keeps its trust; this just leaves it alone
    -- rather than minting a pointless new code for someone already verified.
    where public.restaurant_guest_devices.verified_at is null;

  select bs.whatsapp into v_whatsapp
    from public.branding_settings bs where bs.organization_id = p_org;

  return query select v_code, v_whatsapp, now() + interval '10 minutes';
end;
$$;
revoke all on function app.restaurant_guest_verification_issue(uuid, uuid, text, text) from public, anon, authenticated;

create or replace function public.restaurant_guest_verification_start_by_token(
  p_token text, p_device_id text, p_phone text
) returns table(out_code text, out_whatsapp text, out_expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_branch uuid;
begin
  select pl.organization_id, pl.branch_id into v_org, v_branch
    from public.public_links pl
   where pl.token = p_token and pl.kind = 'menu'
     and pl.is_active and pl.revoked_at is null
     and (pl.expires_at is null or pl.expires_at > now());
  if v_org is null then
    raise exception 'this QR code is no longer active' using errcode = 'check_violation';
  end if;
  return query select * from app.restaurant_guest_verification_issue(v_org, v_branch, p_device_id, p_phone);
end;
$$;
revoke all on function public.restaurant_guest_verification_start_by_token(text, text, text) from public, anon, authenticated;
grant execute on function public.restaurant_guest_verification_start_by_token(text, text, text) to anon, authenticated;

create or replace function public.restaurant_guest_verification_start(
  p_org_slug text, p_branch_slug text, p_device_id text, p_phone text
) returns table(out_code text, out_whatsapp text, out_expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare v record;
begin
  select * into v from app.restaurant_online_branch(p_org_slug, p_branch_slug);
  if v.org_id is null then
    raise exception 'storefront not found' using errcode = 'check_violation';
  end if;
  return query select * from app.restaurant_guest_verification_issue(v.org_id, v.branch_id, p_device_id, p_phone);
end;
$$;
revoke all on function public.restaurant_guest_verification_start(text, text, text, text) from public, anon, authenticated;
grant execute on function public.restaurant_guest_verification_start(text, text, text, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. restaurant_place_public_order (QR/in-store): adds device/location
--    params. Geofencing is a hard stop, but only once a branch has actually
--    configured a point to check against — a branch that never set one up
--    behaves exactly as before. Signature keeps every existing parameter in
--    place so 0022/0076's grants and every existing caller still work; the
--    three new ones are optional and default to null.
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

  -- Geofencing: a hard stop, and only when the branch configured one. A
  -- customer standing in the restaurant scanning a physical QR code is the
  -- entire premise of this channel, so unlike the online path this one can
  -- afford to refuse rather than merely flag.
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

  -- Device trust. No device/phone at all means nothing to flag — a browser
  -- that blocked geolocation or a guest who left the phone field blank still
  -- gets an order, just one the cashier sees as unverified only when there
  -- actually is a phone number to check.
  v_phone := nullif(trim(coalesce(p_guest_phone, '')), '');
  if p_device_id is not null and v_phone is not null then
    insert into public.restaurant_guest_devices (organization_id, device_id, phone, last_order_at)
    values (v_org, p_device_id, v_phone, now())
    on conflict (organization_id, device_id, phone) do update set last_order_at = now();

    select (verified_at is not null) into v_verified
      from public.restaurant_guest_devices
     where organization_id = v_org and device_id = p_device_id and phone = v_phone;
  end if;

  v_number := app.next_document_number(v_org, v_branch, 'restaurant_order');

  insert into public.restaurant_orders
    (organization_id, branch_id, table_id, number, channel, type, status,
     guest_name, guest_phone, note, currency, customer_edit_until, created_by,
     device_id, guest_verified, customer_latitude, customer_longitude,
     location_distance_m, location_status)
  values
    (v_org, v_branch, v_table, v_number, 'qr', 'dine_in', 'new',
     nullif(trim(coalesce(p_guest_name, '')), ''),
     v_phone,
     nullif(trim(coalesce(p_note, '')), ''),
     v_currency, now() + interval '60 seconds', null,
     p_device_id, coalesce(v_verified, true), p_latitude, p_longitude,
     case when v_distance is not null then round(v_distance)::int else null end, v_status)
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
-- 8. restaurant_place_online_order: same two signals, but geofencing is
--    always advisory here — a delivery address or an ahead-of-time pickup
--    is routinely far from the till, so this channel only ever flags, never
--    blocks. Everything else about the function (D3's accounts/addresses,
--    idempotency, the delivery row) is unchanged.
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

  -- Advisory only: never raises. A pickup order placed from home, or a
  -- delivery address across town, is the normal case for this channel.
  select * into v_geo from app.restaurant_geofence(v.org_id, v.branch_id);
  if v_geo.lat is not null and p_latitude is not null and p_longitude is not null then
    v_distance := app.restaurant_distance_m(v_geo.lat, v_geo.lng, p_latitude, p_longitude);
    if v_distance <= v_geo.radius_m then v_status := 'inside';
    elsif v_distance <= greatest(v_geo.radius_m * 3, 15000) then v_status := 'nearby';
    else v_status := 'far'; end if;
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

-- ---------------------------------------------------------------------------
-- 9. Cashier review: mark a guest's device/phone as recognised. Reuses
--    restaurant.order.update — the same permission that already gates moving
--    an order to 'confirmed' — rather than adding a new permission key for
--    what is, in practice, one more thing a cashier checks during review.
-- ---------------------------------------------------------------------------
create or replace function public.restaurant_guest_verify_order(
  p_org uuid, p_order uuid
) returns table (out_verified boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_branch uuid;
  v_device text;
  v_phone  text;
  v_user   uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  select branch_id, device_id, guest_phone into v_branch, v_device, v_phone
    from public.restaurant_orders
   where id = p_order and organization_id = p_org;
  if v_branch is null then
    raise exception 'order not found' using errcode = 'check_violation';
  end if;

  if not app.has_branch_permission(p_org, v_branch, 'restaurant.order.update') then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  update public.restaurant_orders set guest_verified = true where id = p_order;

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
revoke all on function public.restaurant_guest_verify_order(uuid, uuid) from public, anon;
grant execute on function public.restaurant_guest_verify_order(uuid, uuid) to authenticated;
