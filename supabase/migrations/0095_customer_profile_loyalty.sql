-- ---------------------------------------------------------------------------
-- 0095: guest customer profile + loyalty points and staff-redeemed rewards.
--
-- There are no customer accounts (guest-first ordering). A returning guest is
-- recognised by a DEVICE that has been verified over WhatsApp for their phone
-- number (restaurant_guest_devices, 0081/0086): the profile functions return
-- data only when the (organization, device id, phone) triple is a verified
-- row. Typing someone else's number from an unverified device returns
-- nothing. The device id is a random UUID held in the guest's browser, so it
-- is the capability; the phone alone is never enough.
--
-- LOYALTY. Points are DERIVED, never stored:
--     earned  = floor(sum(total of this phone's COMPLETED orders) / cents_per_point)
--     spent   = sum(points_cost of coupons not voided)
--     balance = earned - spent
-- A guest claims a reward (reward_points → one coupon of reward_value_cents).
-- The coupon is a short code the cashier enters at settlement: the server
-- checks it belongs to the order's customer, redeems it atomically and applies
-- the discount through the existing payment path. Online order pricing is not
-- touched.
-- ---------------------------------------------------------------------------

create or replace function app.phone_key(p_phone text)
returns text language sql immutable set search_path = '' as $$
  select right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 9);
$$;

create table public.restaurant_loyalty_settings (
  organization_id    uuid primary key references public.organizations(id) on delete cascade,
  enabled            boolean not null default false,
  cents_per_point    int    not null default 1000    check (cents_per_point between 1 and 10000000),
  reward_points      int    not null default 100     check (reward_points between 1 and 1000000),
  reward_value_cents bigint not null default 2000    check (reward_value_cents between 1 and 100000000),
  coupon_valid_days  int    not null default 90      check (coupon_valid_days between 1 and 730),
  updated_by         uuid references auth.users(id),
  updated_at         timestamptz not null default now()
);

create table public.restaurant_loyalty_coupons (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations(id) on delete cascade,
  phone_key         text not null check (length(phone_key) >= 7),
  code              text not null,
  points_cost       int  not null check (points_cost > 0),
  value_cents       bigint not null check (value_cents > 0),
  status            text not null default 'active' check (status in ('active', 'redeemed', 'void')),
  expires_at        timestamptz not null,
  created_at        timestamptz not null default now(),
  redeemed_at       timestamptz,
  redeemed_by       uuid references auth.users(id),
  redeemed_order_id uuid references public.restaurant_orders(id) on delete set null,
  unique (organization_id, code)
);
create index restaurant_loyalty_coupons_customer_idx
  on public.restaurant_loyalty_coupons(organization_id, phone_key);

alter table public.restaurant_loyalty_settings enable row level security;
alter table public.restaurant_loyalty_settings force row level security;
alter table public.restaurant_loyalty_coupons enable row level security;
alter table public.restaurant_loyalty_coupons force row level security;
revoke all on public.restaurant_loyalty_settings from public, anon, authenticated;
revoke all on public.restaurant_loyalty_coupons from public, anon, authenticated;

-- Is this device verified for this phone at this organization?
create or replace function app.customer_device_verified(p_org uuid, p_device text, p_phone text)
returns boolean language sql stable security definer set search_path = '' as $$
  select length(app.phone_key(p_phone)) >= 7
     and length(coalesce(p_device, '')) >= 8
     and exists (
       select 1 from public.restaurant_guest_devices d
        where d.organization_id = p_org
          and d.device_id = p_device
          and app.phone_key(d.phone) = app.phone_key(p_phone)
          and d.verified_at is not null);
$$;

create or replace function app.loyalty_points(p_org uuid, p_key text)
returns table (out_earned int, out_spent int, out_balance int)
language sql stable security definer set search_path = '' as $$
  with s as (
    select coalesce((select cents_per_point from public.restaurant_loyalty_settings where organization_id = p_org), 1000) as cpp
  ),
  e as (
    select floor(coalesce(sum(o.total_cents), 0) / (select cpp from s))::int as v
      from public.restaurant_orders o
     where o.organization_id = p_org and o.status = 'completed'
       and app.phone_key(o.guest_phone) = p_key
  ),
  sp as (
    select coalesce(sum(c.points_cost), 0)::int as v
      from public.restaurant_loyalty_coupons c
     where c.organization_id = p_org and c.phone_key = p_key and c.status <> 'void'
  )
  select e.v, sp.v, greatest(e.v - sp.v, 0) from e, sp;
$$;

create or replace function app.customer_profile(p_org uuid, p_device text, p_phone text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_key       text := app.phone_key(p_phone);
  v_currency  text;
  v_settings  public.restaurant_loyalty_settings%rowtype;
  v_enabled   boolean;
  v_name      text;
  v_addresses jsonb;
  v_orders    jsonb;
  v_coupons   jsonb;
  v_earned    int;
  v_spent     int;
  v_balance   int;
begin
  if not app.customer_device_verified(p_org, p_device, p_phone) then
    return jsonb_build_object('verified', false);
  end if;

  select o.currency into v_currency from public.organizations o where o.id = p_org;
  select * into v_settings from public.restaurant_loyalty_settings where organization_id = p_org;
  v_enabled := coalesce(v_settings.enabled, false);

  select o.guest_name into v_name
    from public.restaurant_orders o
   where o.organization_id = p_org and app.phone_key(o.guest_phone) = v_key and o.guest_name is not null
   order by o.placed_at desc limit 1;

  select coalesce(jsonb_agg(a order by a.last_used desc), '[]'::jsonb) into v_addresses
  from (
    select * from (
      select d.recipient_name, d.phone, d.city, d.area, d.address, d.landmark, o.placed_at as last_used,
             row_number() over (
               partition by lower(trim(d.address)), lower(coalesce(d.area, '')), lower(coalesce(d.city, ''))
               order by o.placed_at desc) as rn
        from public.restaurant_order_deliveries d
        join public.restaurant_orders o on o.id = d.order_id
       where o.organization_id = p_org and app.phone_key(o.guest_phone) = v_key
    ) x where x.rn = 1
    order by x.last_used desc limit 5
  ) a;

  select coalesce(jsonb_agg(r order by r.placed_at desc), '[]'::jsonb) into v_orders
  from (
    select o.id, o.number, o.status, o.type, o.total_cents, o.placed_at,
           (select pl.token from public.public_links pl
             where pl.kind = 'order_status' and pl.target ->> 'entity_type' = 'restaurant_order'
               and (pl.target ->> 'entity_id')::uuid = o.id
               and pl.is_active and pl.revoked_at is null
               and (pl.expires_at is null or pl.expires_at > now())
             order by pl.created_at desc limit 1) as token,
           coalesce((
             select jsonb_agg(jsonb_build_object(
                      'variant_id', i.variant_id,
                      'product_name', i.product_name,
                      'variant_name', i.variant_name,
                      'quantity', i.quantity,
                      'note', i.note,
                      'modifier_ids', coalesce((
                        select jsonb_agg(m.modifier_id)
                          from public.restaurant_order_item_modifiers m
                         where m.order_item_id = i.id and m.modifier_id is not null), '[]'::jsonb))
                    order by i.position)
               from public.restaurant_order_items i where i.order_id = o.id), '[]'::jsonb) as items
      from public.restaurant_orders o
     where o.organization_id = p_org and app.phone_key(o.guest_phone) = v_key
       and o.status <> 'pending_verification'
     order by o.placed_at desc limit 15
  ) r;

  select out_earned, out_spent, out_balance into v_earned, v_spent, v_balance
    from app.loyalty_points(p_org, v_key);

  select coalesce(jsonb_agg(jsonb_build_object(
           'code', c.code, 'value_cents', c.value_cents, 'expires_at', c.expires_at) order by c.created_at desc), '[]'::jsonb)
    into v_coupons
    from public.restaurant_loyalty_coupons c
   where c.organization_id = p_org and c.phone_key = v_key and c.status = 'active' and c.expires_at > now();

  return jsonb_build_object(
    'verified', true,
    'name', v_name,
    'phone', p_phone,
    'currency', v_currency,
    'addresses', v_addresses,
    'orders', v_orders,
    'loyalty', jsonb_build_object(
      'enabled', v_enabled,
      'earned', v_earned, 'spent', v_spent, 'balance', v_balance,
      'reward_points', coalesce(v_settings.reward_points, 100),
      'reward_value_cents', coalesce(v_settings.reward_value_cents, 2000),
      'cents_per_point', coalesce(v_settings.cents_per_point, 1000)),
    'coupons', v_coupons);
end;
$$;

create or replace function app.customer_claim_reward(p_org uuid, p_device text, p_phone text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_key     text := app.phone_key(p_phone);
  v_s       public.restaurant_loyalty_settings%rowtype;
  v_balance int;
  v_code    text;
  v_expires timestamptz;
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_try     int := 0;
begin
  if not app.customer_device_verified(p_org, p_device, p_phone) then
    raise exception 'أكّد رقمك عبر واتساب أولًا' using errcode = '42501';
  end if;
  select * into v_s from public.restaurant_loyalty_settings where organization_id = p_org;
  if v_s.organization_id is null or not v_s.enabled then
    raise exception 'برنامج المكافآت غير مفعّل' using errcode = 'check_violation';
  end if;

  -- One claim at a time per customer, so two taps cannot spend the same points.
  perform pg_advisory_xact_lock(hashtextextended(p_org::text || ':' || v_key, 0));

  select out_balance into v_balance from app.loyalty_points(p_org, v_key);
  if v_balance < v_s.reward_points then
    raise exception 'رصيد النقاط غير كافٍ' using errcode = 'check_violation';
  end if;

  v_expires := now() + make_interval(days => v_s.coupon_valid_days);
  loop
    v_try := v_try + 1;
    v_code := 'LB-' || (
      select string_agg(substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1), '')
        from generate_series(1, 6));
    begin
      insert into public.restaurant_loyalty_coupons
        (organization_id, phone_key, code, points_cost, value_cents, expires_at)
      values (p_org, v_key, v_code, v_s.reward_points, v_s.reward_value_cents, v_expires);
      exit;
    exception when unique_violation then
      if v_try >= 5 then raise; end if;
    end;
  end loop;

  return jsonb_build_object('code', v_code, 'value_cents', v_s.reward_value_cents, 'expires_at', v_expires);
end;
$$;

revoke all on function app.phone_key(text) from public, anon, authenticated;
revoke all on function app.customer_device_verified(uuid, text, text) from public, anon, authenticated;
revoke all on function app.loyalty_points(uuid, text) from public, anon, authenticated;
revoke all on function app.customer_profile(uuid, text, text) from public, anon, authenticated;
revoke all on function app.customer_claim_reward(uuid, text, text) from public, anon, authenticated;

-- Public entry points: by store slug (online storefront) or table-QR token.
create or replace function public.customer_profile(p_org_slug text, p_device_id text, p_phone text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce((select app.customer_profile(o.id, p_device_id, p_phone)
                     from public.organizations o
                    where o.slug = p_org_slug and o.status = 'active' and o.deleted_at is null),
                  jsonb_build_object('verified', false));
$$;

create or replace function public.customer_profile_by_token(p_token text, p_device_id text, p_phone text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce((select app.customer_profile(o.id, p_device_id, p_phone)
                     from public.public_links pl
                     join public.organizations o on o.id = pl.organization_id
                    where pl.token = p_token and pl.kind = 'menu' and pl.is_active and pl.revoked_at is null
                      and (pl.expires_at is null or pl.expires_at > now())
                      and o.status = 'active' and o.deleted_at is null),
                  jsonb_build_object('verified', false));
$$;

create or replace function public.customer_claim_reward(p_org_slug text, p_device_id text, p_phone text)
returns jsonb language sql volatile security definer set search_path = '' as $$
  select app.customer_claim_reward(o.id, p_device_id, p_phone)
    from public.organizations o
   where o.slug = p_org_slug and o.status = 'active' and o.deleted_at is null;
$$;

create or replace function public.customer_claim_reward_by_token(p_token text, p_device_id text, p_phone text)
returns jsonb language sql volatile security definer set search_path = '' as $$
  select app.customer_claim_reward(o.id, p_device_id, p_phone)
    from public.public_links pl
    join public.organizations o on o.id = pl.organization_id
   where pl.token = p_token and pl.kind = 'menu' and pl.is_active and pl.revoked_at is null
     and (pl.expires_at is null or pl.expires_at > now())
     and o.status = 'active' and o.deleted_at is null;
$$;

revoke all on function public.customer_profile(text, text, text) from public;
revoke all on function public.customer_profile_by_token(text, text, text) from public;
revoke all on function public.customer_claim_reward(text, text, text) from public;
revoke all on function public.customer_claim_reward_by_token(text, text, text) from public;
grant execute on function public.customer_profile(text, text, text) to anon, authenticated;
grant execute on function public.customer_profile_by_token(text, text, text) to anon, authenticated;
grant execute on function public.customer_claim_reward(text, text, text) to anon, authenticated;
grant execute on function public.customer_claim_reward_by_token(text, text, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Owner settings.
-- ---------------------------------------------------------------------------
create or replace function public.restaurant_loyalty_settings_get(p_org uuid)
returns table (
  out_enabled boolean, out_cents_per_point int, out_reward_points int,
  out_reward_value_cents bigint, out_coupon_valid_days int)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not app.has_permission(p_org, 'settings.manage') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  return query
    select coalesce(s.enabled, false), coalesce(s.cents_per_point, 1000), coalesce(s.reward_points, 100),
           coalesce(s.reward_value_cents, 2000), coalesce(s.coupon_valid_days, 90)
      from (select 1) _
      left join public.restaurant_loyalty_settings s on s.organization_id = p_org;
end;
$$;

create or replace function public.restaurant_loyalty_settings_save(
  p_org uuid, p_enabled boolean, p_cents_per_point int, p_reward_points int,
  p_reward_value_cents bigint, p_coupon_valid_days int
) returns void
language plpgsql security definer set search_path = '' as $$
declare v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not app.has_permission(p_org, 'settings.manage') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  insert into public.restaurant_loyalty_settings
    (organization_id, enabled, cents_per_point, reward_points, reward_value_cents, coupon_valid_days, updated_by, updated_at)
  values (p_org, p_enabled, p_cents_per_point, p_reward_points, p_reward_value_cents, p_coupon_valid_days, v_user, now())
  on conflict (organization_id) do update
    set enabled = excluded.enabled, cents_per_point = excluded.cents_per_point,
        reward_points = excluded.reward_points, reward_value_cents = excluded.reward_value_cents,
        coupon_valid_days = excluded.coupon_valid_days, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  insert into public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, v_user, 'restaurant.loyalty_settings.updated', 'organization', p_org::text,
    jsonb_build_object('enabled', p_enabled, 'cents_per_point', p_cents_per_point,
      'reward_points', p_reward_points, 'reward_value_cents', p_reward_value_cents));
end;
$$;

revoke all on function public.restaurant_loyalty_settings_get(uuid) from public, anon;
revoke all on function public.restaurant_loyalty_settings_save(uuid, boolean, int, int, bigint, int) from public, anon;
grant execute on function public.restaurant_loyalty_settings_get(uuid) to authenticated;
grant execute on function public.restaurant_loyalty_settings_save(uuid, boolean, int, int, bigint, int) to authenticated;

-- ---------------------------------------------------------------------------
-- Cashier: check, redeem and release a coupon against a specific order.
-- The coupon must belong to the order's customer (same phone), be active and
-- unexpired, and its value is capped at the order total.
-- ---------------------------------------------------------------------------
create or replace function app.coupon_for_order(p_org uuid, p_order uuid, p_code text, p_lock boolean)
returns table (out_coupon uuid, out_value_cents bigint, out_expires_at timestamptz, out_branch uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_order  record;
  v_coupon record;
begin
  select o.branch_id, o.total_cents, o.guest_phone into v_order
    from public.restaurant_orders o where o.id = p_order and o.organization_id = p_org;
  if v_order.branch_id is null then
    raise exception 'order not found' using errcode = 'check_violation';
  end if;
  -- A coupon is a discount, and a discount is its own privilege (0054): the
  -- same permission the payment itself will demand, so a coupon is never
  -- consumed by a cashier whose payment would then be refused.
  if not app.has_branch_permission(p_org, v_order.branch_id, 'restaurant.pos.discount') then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  select c.* into v_coupon from public.restaurant_loyalty_coupons c
   where c.organization_id = p_org and c.code = upper(trim(coalesce(p_code, '')))
   for update;
  if not found then
    raise exception 'كود المكافأة غير صحيح' using errcode = 'check_violation';
  end if;
  if v_coupon.status <> 'active' then
    raise exception 'هذا الكود مستخدم بالفعل' using errcode = 'check_violation';
  end if;
  if v_coupon.expires_at <= now() then
    raise exception 'انتهت صلاحية هذا الكود' using errcode = 'check_violation';
  end if;
  if v_coupon.phone_key is distinct from app.phone_key(v_order.guest_phone) then
    raise exception 'هذا الكود يخص عميلًا آخر' using errcode = 'check_violation';
  end if;

  return query select v_coupon.id, least(v_coupon.value_cents, v_order.total_cents),
                      v_coupon.expires_at, v_order.branch_id;
end;
$$;
revoke all on function app.coupon_for_order(uuid, uuid, text, boolean) from public, anon, authenticated;

create or replace function public.restaurant_coupon_check(p_org uuid, p_order uuid, p_code text)
returns table (out_value_cents bigint, out_expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  return query select c.out_value_cents, c.out_expires_at from app.coupon_for_order(p_org, p_order, p_code, false) c;
end;
$$;

create or replace function public.restaurant_coupon_redeem(p_org uuid, p_order uuid, p_code text)
returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  c record;
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  select * into c from app.coupon_for_order(p_org, p_order, p_code, true);
  update public.restaurant_loyalty_coupons
     set status = 'redeemed', redeemed_at = now(), redeemed_by = v_user, redeemed_order_id = p_order
   where id = c.out_coupon and status = 'active';
  if not found then
    raise exception 'هذا الكود مستخدم بالفعل' using errcode = 'check_violation';
  end if;
  insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, c.out_branch, v_user, 'restaurant.loyalty_coupon.redeemed', 'restaurant_order', p_order::text,
          jsonb_build_object('value_cents', c.out_value_cents));
  return c.out_value_cents;
end;
$$;

-- Undo a redemption when the payment it was for did not go through.
create or replace function public.restaurant_coupon_release(p_org uuid, p_order uuid, p_code text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_branch uuid;
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  select branch_id into v_branch from public.restaurant_orders where id = p_order and organization_id = p_org;
  if v_branch is null or not app.has_branch_permission(p_org, v_branch, 'restaurant.pos.use') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  update public.restaurant_loyalty_coupons
     set status = 'active', redeemed_at = null, redeemed_by = null, redeemed_order_id = null
   where organization_id = p_org and code = upper(trim(coalesce(p_code, '')))
     and status = 'redeemed' and redeemed_order_id = p_order and redeemed_by = v_user;
end;
$$;

revoke all on function public.restaurant_coupon_check(uuid, uuid, text) from public, anon;
revoke all on function public.restaurant_coupon_redeem(uuid, uuid, text) from public, anon;
revoke all on function public.restaurant_coupon_release(uuid, uuid, text) from public, anon;
grant execute on function public.restaurant_coupon_check(uuid, uuid, text) to authenticated;
grant execute on function public.restaurant_coupon_redeem(uuid, uuid, text) to authenticated;
grant execute on function public.restaurant_coupon_release(uuid, uuid, text) to authenticated;
