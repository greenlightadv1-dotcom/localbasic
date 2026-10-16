-- =============================================================================
-- 0107: CRM — loyalty rewards and adjustments, a promotions engine, and house
-- (credit) accounts with a ledger and statements.
--
-- LOYALTY (builds on 0095, where points are derived from completed orders):
--   * a rewards catalog — a discount, or an item free — redeemed by staff for
--     a caller or a guest at the till into the same single-use coupon codes;
--   * manual point adjustments (a goodwill bonus, a correction), each with a
--     manager PIN, counted into the derived balance.
--
-- PROMOTIONS (restaurant_promotions):
--   happy_hour  a percentage off chosen items, on chosen days, between times
--   bogo        buy X get Y (free or at a percentage off) among chosen items
--   code        a promo code: percentage or fixed amount, minimum order,
--               validity window and a use limit
-- restaurant_promotions_apply(order, code) prices them against the order's
-- lines in the organization's own time zone, records what applied
-- (restaurant_order_promotions) and sets the order's discount to coupons +
-- promotions. Those are not "manual" discounts: the 0103 guard now counts
-- them as approved, so only a discount BEYOND them needs a manager's PIN.
--
-- HOUSE ACCOUNTS (restaurant_house_accounts + restaurant_account_entries):
-- a corporate or VIP customer with a credit limit. An order charged to the
-- account is invoiced to the customer and left unpaid (a receivable); a
-- payment received is allocated to their oldest open invoices; a manual
-- adjustment (a credit note, a write-off) needs a manager's PIN, and so does
-- a charge that would take the account over its limit. The ledger is
-- append-only; a statement is the ledger with a running balance.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------------
insert into public.permissions (key, group_key, module_key, description, is_elevated) values
  ('restaurant.promotion.manage', 'restaurant', 'restaurant', 'Create and manage promotions and promo codes', false),
  ('restaurant.loyalty.manage',   'restaurant', 'restaurant', 'Manage loyalty rewards and adjust points',      false),
  ('restaurant.account.manage',   'restaurant', 'restaurant', 'Manage house accounts: limits, payments, statements', true),
  ('restaurant.account.charge',   'restaurant', 'restaurant', 'Charge an order to a house account',            false)
on conflict (key) do update
  set description = excluded.description, group_key = excluded.group_key, module_key = excluded.module_key;

with grants(role_key, permission_key) as (values
  ('cashier', 'restaurant.account.charge'), ('main_cashier', 'restaurant.account.charge'),
  ('manager', 'restaurant.promotion.manage'), ('manager', 'restaurant.loyalty.manage'),
  ('manager', 'restaurant.account.manage'), ('manager', 'restaurant.account.charge'),
  ('admin', 'restaurant.promotion.manage'), ('admin', 'restaurant.loyalty.manage'),
  ('admin', 'restaurant.account.manage'), ('admin', 'restaurant.account.charge')
)
insert into public.role_permissions (role_id, permission_key)
select r.id, g.permission_key
  from grants g
  join public.roles r on r.organization_id is null and r.key = g.role_key
                     and (r.module_key is null or r.module_key = 'restaurant')
on conflict do nothing;

insert into public.role_permissions (role_id, permission_key)
select org_role.id, tp.permission_key
  from public.roles org_role
  join public.roles tpl on tpl.organization_id is null and tpl.is_system and tpl.key = org_role.key
                       and tpl.module_key is not distinct from org_role.module_key
  join public.role_permissions tp on tp.role_id = tpl.id
 where org_role.organization_id is not null
   and tp.permission_key in ('restaurant.promotion.manage', 'restaurant.loyalty.manage',
                             'restaurant.account.manage', 'restaurant.account.charge')
on conflict do nothing;

insert into public.role_permissions (role_id, permission_key)
select r.id, p.key from public.roles r cross join public.permissions p
 where r.is_owner and r.organization_id is not null
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Loyalty: rewards catalog and point adjustments
-- ---------------------------------------------------------------------------
create table public.restaurant_loyalty_rewards (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  name             text not null check (length(trim(name)) between 1 and 80),
  points_cost      int not null check (points_cost between 1 and 1000000),
  kind             text not null check (kind in ('discount', 'free_item')),
  value_cents      bigint check (value_cents between 1 and 100000000),
  variant_id       uuid references public.restaurant_variants(id) on delete cascade,
  is_active        boolean not null default true,
  sort_order       int not null default 0,
  created_at       timestamptz not null default now(),
  check ((kind = 'discount' and value_cents is not null) or (kind = 'free_item' and variant_id is not null))
);

create table public.restaurant_loyalty_adjustments (
  id               bigint generated always as identity primary key,
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  phone_key        text not null check (length(phone_key) >= 7),
  points           int not null check (points <> 0 and abs(points) <= 1000000),
  note             text not null check (length(trim(note)) between 1 and 300),
  actor_id         uuid,
  approved_by      uuid,
  created_at       timestamptz not null default now()
);
create index restaurant_loyalty_adjustments_key_idx on public.restaurant_loyalty_adjustments(organization_id, phone_key);

alter table public.restaurant_loyalty_coupons
  add column if not exists reward_id uuid references public.restaurant_loyalty_rewards(id) on delete set null,
  add column if not exists reward_name text check (length(reward_name) <= 80);

-- 0095's balance, with manual adjustments: positive ones earn, negative ones spend.
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
  ),
  adj as (
    select coalesce(sum(greatest(points, 0)), 0)::int as plus, coalesce(sum(greatest(-points, 0)), 0)::int as minus
      from public.restaurant_loyalty_adjustments
     where organization_id = p_org and phone_key = p_key
  )
  select e.v + adj.plus, sp.v + adj.minus, greatest(e.v + adj.plus - sp.v - adj.minus, 0) from e, sp, adj;
$$;

-- ---------------------------------------------------------------------------
-- Promotions
-- ---------------------------------------------------------------------------
create table public.restaurant_promotions (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  branch_id        uuid references public.branches(id) on delete cascade,   -- null = every branch
  name             text not null check (length(trim(name)) between 1 and 120),
  kind             text not null check (kind in ('happy_hour', 'bogo', 'code')),
  is_active        boolean not null default true,
  starts_at        timestamptz,
  ends_at          timestamptz,
  days_of_week     smallint[] check (days_of_week <@ array[0, 1, 2, 3, 4, 5, 6]::smallint[]),  -- 0 = Sunday
  start_time       time,
  end_time         time,
  percent_bp       int check (percent_bp between 1 and 10000),
  amount_cents     bigint check (amount_cents between 1 and 100000000),
  product_ids      uuid[] not null default '{}',
  category_ids     uuid[] not null default '{}',
  buy_qty          int check (buy_qty between 1 and 50),
  get_qty          int check (get_qty between 1 and 50),
  get_percent_bp   int check (get_percent_bp between 1 and 10000),
  code             text check (code ~ '^[A-Za-z0-9_-]{3,32}$'),
  min_order_cents  bigint not null default 0 check (min_order_cents >= 0),
  max_uses         int check (max_uses >= 1),
  created_by       uuid references auth.users(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (ends_at is null or starts_at is null or ends_at > starts_at),
  check (kind <> 'happy_hour' or (percent_bp is not null and start_time is not null and end_time is not null)),
  check (kind <> 'bogo' or (buy_qty is not null and get_qty is not null and get_percent_bp is not null)),
  check (kind <> 'code' or (code is not null and (percent_bp is not null or amount_cents is not null)))
);
create unique index restaurant_promotions_code_uq on public.restaurant_promotions(organization_id, upper(code)) where code is not null;

create table public.restaurant_order_promotions (
  order_id         uuid not null references public.restaurant_orders(id) on delete cascade,
  promotion_id     uuid not null references public.restaurant_promotions(id) on delete cascade,
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  amount_cents     bigint not null check (amount_cents > 0),
  code             text,
  applied_by       uuid references auth.users(id),
  applied_at       timestamptz not null default now(),
  primary key (order_id, promotion_id)
);
create index restaurant_order_promotions_promo_idx on public.restaurant_order_promotions(promotion_id);

-- Is the promotion on right now, in the organization's own time zone?
create or replace function app.promotion_live(p public.restaurant_promotions, p_tz text)
returns boolean language plpgsql stable set search_path = '' as $$
declare v_local timestamp := (now() at time zone coalesce(nullif(p_tz, ''), 'Africa/Cairo'));
begin
  if not p.is_active then return false; end if;
  if p.starts_at is not null and now() < p.starts_at then return false; end if;
  if p.ends_at is not null and now() >= p.ends_at then return false; end if;
  if p.days_of_week is not null and cardinality(p.days_of_week) > 0
     and not (extract(dow from v_local)::smallint = any(p.days_of_week)) then
    return false;
  end if;
  if p.start_time is not null and p.end_time is not null then
    if p.start_time <= p.end_time then
      if not (v_local::time >= p.start_time and v_local::time < p.end_time) then return false; end if;
    else  -- across midnight, e.g. 22:00–02:00
      if not (v_local::time >= p.start_time or v_local::time < p.end_time) then return false; end if;
    end if;
  end if;
  return true;
end;
$$;

-- Price every applicable promotion against the order, record them, and set
-- the order's discount to redeemed loyalty coupons + promotions.
create or replace function public.restaurant_promotions_apply(p_org uuid, p_order uuid, p_code text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  o         record;
  p         public.restaurant_promotions%rowtype;
  v_tz      text;
  v_lines   bigint;
  v_amount  bigint;
  v_total   bigint := 0;
  v_applied jsonb := '[]'::jsonb;
  v_coupons bigint;
  v_code    text := upper(nullif(trim(coalesce(p_code, '')), ''));
  v_found   boolean := false;
  v_uses    int;
  v_group   int;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select id, branch_id, status, invoice_id into o from public.restaurant_orders
   where id = p_order and organization_id = p_org for update;
  if o.id is null then raise exception 'الطلب غير موجود' using errcode = 'check_violation'; end if;
  if not (app.has_branch_permission(p_org, o.branch_id, 'restaurant.pos.use')
          or app.has_branch_permission(p_org, o.branch_id, 'restaurant.callcenter.use')) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if o.invoice_id is not null or o.status in ('completed', 'cancelled', 'pending_verification') then
    raise exception 'لا يمكن تطبيق العروض على هذا الطلب' using errcode = 'check_violation';
  end if;
  select timezone into v_tz from public.organizations where id = p_org;
  select coalesce(sum(line_total_cents), 0) into v_lines from public.restaurant_order_items where order_id = p_order;

  delete from public.restaurant_order_promotions where order_id = p_order;

  for p in
    select * from public.restaurant_promotions
     where organization_id = p_org and is_active and (branch_id is null or branch_id = o.branch_id)
       and (kind <> 'code' or upper(code) = v_code)
     order by kind, created_at
  loop
    if p.kind = 'code' then v_found := true; end if;
    continue when not app.promotion_live(p, v_tz);
    v_amount := 0;

    if p.kind = 'happy_hour' then
      select coalesce(round(sum(i.line_total_cents) * p.percent_bp / 10000.0), 0) into v_amount
        from public.restaurant_order_items i
        join public.restaurant_variants rv on rv.id = i.variant_id
        join public.restaurant_products rp on rp.id = rv.product_id
       where i.order_id = p_order
         and ((cardinality(p.product_ids) = 0 and cardinality(p.category_ids) = 0)
              or rp.id = any(p.product_ids) or rp.category_id = any(p.category_ids));

    elsif p.kind = 'bogo' then
      -- Every eligible unit, dearest first, in groups of buy+get: in each
      -- COMPLETE group the last `get` units (the cheapest of it) are
      -- discounted. A partial group earns nothing.
      v_group := p.buy_qty + p.get_qty;
      select coalesce(round(sum(x.unit_price) * p.get_percent_bp / 10000.0), 0) into v_amount
        from (
          select u.unit_price, row_number() over (order by u.unit_price desc) as rn, count(*) over () as n
            from (
              select (i.line_total_cents::numeric / i.quantity) as unit_price
                from public.restaurant_order_items i
                join public.restaurant_variants rv on rv.id = i.variant_id
                join public.restaurant_products rp on rp.id = rv.product_id
                cross join lateral generate_series(1, floor(i.quantity)::int)
               where i.order_id = p_order
                 and ((cardinality(p.product_ids) = 0 and cardinality(p.category_ids) = 0)
                      or rp.id = any(p.product_ids) or rp.category_id = any(p.category_ids))
            ) u
        ) x
       where ((x.rn - 1) % v_group) >= p.buy_qty
         and ((x.rn - 1) / v_group) < (x.n / v_group);

    else -- code
      if v_lines < p.min_order_cents then
        raise exception 'الحد الأدنى للطلب لاستخدام هذا الكود %', p.min_order_cents using errcode = 'check_violation';
      end if;
      if p.max_uses is not null then
        select count(*) into v_uses from public.restaurant_order_promotions op
          join public.restaurant_orders ro on ro.id = op.order_id
         where op.promotion_id = p.id and ro.status <> 'cancelled' and op.order_id <> p_order;
        if v_uses >= p.max_uses then raise exception 'انتهت مرات استخدام هذا الكود' using errcode = 'check_violation'; end if;
      end if;
      v_amount := coalesce(round(v_lines * p.percent_bp / 10000.0), 0) + coalesce(p.amount_cents, 0);
    end if;

    v_amount := least(v_amount, greatest(v_lines - v_total, 0));
    continue when v_amount <= 0;
    insert into public.restaurant_order_promotions (order_id, promotion_id, organization_id, amount_cents, code, applied_by)
    values (p_order, p.id, p_org, v_amount, case when p.kind = 'code' then v_code end, auth.uid());
    v_total := v_total + v_amount;
    v_applied := v_applied || jsonb_build_object('promotion_id', p.id, 'name', p.name, 'kind', p.kind, 'amount_cents', v_amount);
  end loop;

  if v_code is not null and not v_found then
    raise exception 'كود الخصم غير صالح' using errcode = 'check_violation';
  end if;
  if v_code is not null and not exists (select 1 from public.restaurant_order_promotions op
                                          join public.restaurant_promotions pr on pr.id = op.promotion_id
                                         where op.order_id = p_order and pr.kind = 'code') then
    raise exception 'كود الخصم غير متاح الآن' using errcode = 'check_violation';
  end if;

  select coalesce(sum(value_cents), 0) into v_coupons from public.restaurant_loyalty_coupons
   where redeemed_order_id = p_order and status = 'redeemed';
  update public.restaurant_orders set discount_cents = least(v_coupons + v_total, v_lines) where id = p_order;

  insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, o.branch_id, auth.uid(), 'restaurant.promotions.applied', 'restaurant_order', p_order::text,
          jsonb_build_object('promotions', v_applied, 'total', v_total, 'code', v_code));
  return jsonb_build_object('promotions_cents', v_total, 'coupons_cents', v_coupons,
                            'discount_cents', least(v_coupons + v_total, v_lines), 'applied', v_applied);
end;
$$;

create or replace function public.restaurant_promotion_save(p_org uuid, p_id uuid, p_data jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_branch uuid := nullif(p_data ->> 'branch_id', '')::uuid;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_permission(p_org, 'restaurant.promotion.manage') then raise exception 'not permitted' using errcode = '42501'; end if;
  if v_branch is not null and not exists (select 1 from public.branches where id = v_branch and organization_id = p_org) then
    raise exception 'الفرع غير موجود' using errcode = 'check_violation';
  end if;
  begin
    if p_id is null then
      insert into public.restaurant_promotions
        (organization_id, branch_id, name, kind, is_active, starts_at, ends_at, days_of_week, start_time, end_time,
         percent_bp, amount_cents, product_ids, category_ids, buy_qty, get_qty, get_percent_bp, code,
         min_order_cents, max_uses, created_by)
      values (p_org, v_branch, trim(p_data ->> 'name'), p_data ->> 'kind', coalesce((p_data ->> 'is_active')::boolean, true),
              nullif(p_data ->> 'starts_at', '')::timestamptz, nullif(p_data ->> 'ends_at', '')::timestamptz,
              (select array_agg(x::smallint) from jsonb_array_elements_text(coalesce(p_data -> 'days_of_week', '[]'::jsonb)) x),
              nullif(p_data ->> 'start_time', '')::time, nullif(p_data ->> 'end_time', '')::time,
              nullif(p_data ->> 'percent_bp', '')::int, nullif(p_data ->> 'amount_cents', '')::bigint,
              coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(coalesce(p_data -> 'product_ids', '[]'::jsonb)) x), '{}'),
              coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(coalesce(p_data -> 'category_ids', '[]'::jsonb)) x), '{}'),
              nullif(p_data ->> 'buy_qty', '')::int, nullif(p_data ->> 'get_qty', '')::int, nullif(p_data ->> 'get_percent_bp', '')::int,
              upper(nullif(trim(coalesce(p_data ->> 'code', '')), '')), coalesce(nullif(p_data ->> 'min_order_cents', '')::bigint, 0),
              nullif(p_data ->> 'max_uses', '')::int, auth.uid())
      returning id into v_id;
    else
      update public.restaurant_promotions
         set branch_id = v_branch, name = trim(p_data ->> 'name'), is_active = coalesce((p_data ->> 'is_active')::boolean, true),
             starts_at = nullif(p_data ->> 'starts_at', '')::timestamptz, ends_at = nullif(p_data ->> 'ends_at', '')::timestamptz,
             days_of_week = (select array_agg(x::smallint) from jsonb_array_elements_text(coalesce(p_data -> 'days_of_week', '[]'::jsonb)) x),
             start_time = nullif(p_data ->> 'start_time', '')::time, end_time = nullif(p_data ->> 'end_time', '')::time,
             percent_bp = nullif(p_data ->> 'percent_bp', '')::int, amount_cents = nullif(p_data ->> 'amount_cents', '')::bigint,
             product_ids = coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(coalesce(p_data -> 'product_ids', '[]'::jsonb)) x), '{}'),
             category_ids = coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(coalesce(p_data -> 'category_ids', '[]'::jsonb)) x), '{}'),
             buy_qty = nullif(p_data ->> 'buy_qty', '')::int, get_qty = nullif(p_data ->> 'get_qty', '')::int,
             get_percent_bp = nullif(p_data ->> 'get_percent_bp', '')::int,
             code = upper(nullif(trim(coalesce(p_data ->> 'code', '')), '')),
             min_order_cents = coalesce(nullif(p_data ->> 'min_order_cents', '')::bigint, 0),
             max_uses = nullif(p_data ->> 'max_uses', '')::int, updated_at = now()
       where id = p_id and organization_id = p_org returning id into v_id;
      if v_id is null then raise exception 'العرض غير موجود' using errcode = 'check_violation'; end if;
    end if;
  exception
    when unique_violation then raise exception 'هذا الكود مستخدم في عرض آخر' using errcode = '23505';
    when check_violation then raise exception 'بيانات العرض غير مكتملة لهذا النوع' using errcode = '22023';
    when invalid_text_representation then raise exception 'بيانات العرض غير صالحة' using errcode = '22023';
  end;
  -- Items named must be this store's.
  if exists (select 1 from public.restaurant_promotions pr, unnest(pr.product_ids) x
              where pr.id = v_id and not exists (select 1 from public.restaurant_products rp where rp.id = x and rp.organization_id = p_org))
     or exists (select 1 from public.restaurant_promotions pr, unnest(pr.category_ids) x
              where pr.id = v_id and not exists (select 1 from public.restaurant_categories rc where rc.id = x and rc.organization_id = p_org)) then
    raise exception 'صنف أو قسم غير موجود' using errcode = 'check_violation';
  end if;
  insert into public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, auth.uid(), 'restaurant.promotion.saved', 'restaurant_promotion', v_id::text, p_data);
  return v_id;
end;
$$;

-- The 0105 order guard, counting promotions with loyalty coupons as approved discounts.
create or replace function app.restaurant_order_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_by       uuid;
  v_coupons  bigint := 0;
  v_excess   bigint;
begin
  if auth.uid() is null then return new; end if;

  if not app.order_in_my_zone(new.organization_id, new.table_id, new.channel)
     or (tg_op = 'UPDATE' and not app.order_in_my_zone(old.organization_id, old.table_id, old.channel)) then
    raise exception 'هذا الطلب خارج منطقتك' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then return new; end if;

  if new.status = 'cancelled' and old.status in ('confirmed', 'preparing', 'ready', 'served')
     and exists (select 1 from public.restaurant_order_items where order_id = new.id) then
    v_by := app.require_approval(new.organization_id, new.branch_id, 'order.cancel', new.id);
    insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
    values (new.organization_id, new.branch_id, auth.uid(), 'restaurant.order.cancel_approved', 'restaurant_order',
            new.id::text, jsonb_build_object('approved_by', v_by, 'from_status', old.status));
  end if;

  if coalesce(new.discount_cents, 0) > coalesce(old.discount_cents, 0) then
    select coalesce(sum(value_cents), 0) into v_coupons from public.restaurant_loyalty_coupons
     where redeemed_order_id = new.id and status = 'redeemed';
    v_coupons := v_coupons + coalesce((select sum(amount_cents) from public.restaurant_order_promotions where order_id = new.id), 0);
    v_excess := coalesce(new.discount_cents, 0) - greatest(coalesce(old.discount_cents, 0), v_coupons);
    if v_excess > 0 then
      v_by := app.require_approval(new.organization_id, new.branch_id, 'order.discount', new.id, v_excess);
      insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
      values (new.organization_id, new.branch_id, auth.uid(), 'restaurant.order.discount_approved', 'restaurant_order',
              new.id::text, jsonb_build_object('approved_by', v_by, 'discount_cents', new.discount_cents));
    end if;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Loyalty functions
-- ---------------------------------------------------------------------------
create or replace function public.restaurant_loyalty_reward_save(
  p_org uuid, p_id uuid, p_name text, p_points int, p_kind text, p_value_cents bigint, p_variant uuid, p_active boolean default true
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_permission(p_org, 'restaurant.loyalty.manage') then raise exception 'not permitted' using errcode = '42501'; end if;
  if p_kind not in ('discount', 'free_item') then raise exception 'نوع المكافأة غير معروف' using errcode = '22023'; end if;
  if p_kind = 'free_item' and not exists (select 1 from public.restaurant_variants where id = p_variant and organization_id = p_org) then
    raise exception 'الصنف غير موجود' using errcode = 'check_violation';
  end if;
  begin
    if p_id is null then
      insert into public.restaurant_loyalty_rewards (organization_id, name, points_cost, kind, value_cents, variant_id, is_active)
      values (p_org, trim(p_name), p_points, p_kind, case when p_kind = 'discount' then p_value_cents end,
              case when p_kind = 'free_item' then p_variant end, coalesce(p_active, true))
      returning id into v_id;
    else
      update public.restaurant_loyalty_rewards
         set name = trim(p_name), points_cost = p_points, kind = p_kind,
             value_cents = case when p_kind = 'discount' then p_value_cents end,
             variant_id = case when p_kind = 'free_item' then p_variant end, is_active = coalesce(p_active, true)
       where id = p_id and organization_id = p_org returning id into v_id;
      if v_id is null then raise exception 'المكافأة غير موجودة' using errcode = 'check_violation'; end if;
    end if;
  exception when check_violation then raise exception 'بيانات المكافأة غير صالحة' using errcode = '22023';
  end;
  insert into public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, auth.uid(), 'restaurant.loyalty_reward.saved', 'restaurant_loyalty_reward', v_id::text,
          jsonb_build_object('name', p_name, 'points', p_points, 'kind', p_kind, 'value', p_value_cents, 'variant', p_variant));
  return v_id;
end;
$$;

create or replace function public.restaurant_loyalty_adjust(p_org uuid, p_phone text, p_points int, p_note text)
returns int language plpgsql security definer set search_path = '' as $$
declare v_key text := app.phone_key(p_phone); v_by uuid; v_bal int;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_permission(p_org, 'restaurant.loyalty.manage') then raise exception 'not permitted' using errcode = '42501'; end if;
  if length(v_key) < 7 then raise exception 'رقم الهاتف غير صالح' using errcode = '22023'; end if;
  if p_points is null or p_points = 0 or abs(p_points) > 1000000 then raise exception 'عدد النقاط غير صالح' using errcode = '22023'; end if;
  if nullif(trim(coalesce(p_note, '')), '') is null then raise exception 'اكتب سبب التعديل' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_org::text || ':' || v_key, 0));
  select out_balance into v_bal from app.loyalty_points(p_org, v_key);
  if v_bal + p_points < 0 then raise exception 'الرصيد لا يكفي لهذا الخصم' using errcode = 'check_violation'; end if;
  -- An organization-wide decision: approved against the caller's first branch.
  v_by := app.require_approval(p_org,
            (select b.id from public.branches b where b.organization_id = p_org and b.deleted_at is null
               and app.has_branch_permission(p_org, b.id, 'restaurant.loyalty.manage') order by b.created_at limit 1),
            'loyalty.adjust', p_org, abs(p_points));
  insert into public.restaurant_loyalty_adjustments (organization_id, phone_key, points, note, actor_id, approved_by)
  values (p_org, v_key, p_points, left(trim(p_note), 300), auth.uid(), v_by);
  insert into public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, auth.uid(), 'restaurant.loyalty.adjusted', 'loyalty_phone', v_key,
          jsonb_build_object('points', p_points, 'note', p_note, 'approved_by', v_by));
  return v_bal + p_points;
end;
$$;

-- Staff redeem a catalog reward for a phone (at the till, or on the phone).
create or replace function public.restaurant_loyalty_staff_redeem(p_org uuid, p_branch uuid, p_phone text, p_reward uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_key text := app.phone_key(p_phone);
  v_s public.restaurant_loyalty_settings%rowtype;
  rw public.restaurant_loyalty_rewards%rowtype;
  v_value bigint; v_bal int; v_code text; v_expires timestamptz; v_try int := 0;
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not (app.has_branch_permission(p_org, p_branch, 'restaurant.pos.use') or app.has_branch_permission(p_org, p_branch, 'restaurant.callcenter.use')) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if length(v_key) < 7 then raise exception 'رقم الهاتف غير صالح' using errcode = '22023'; end if;
  select * into v_s from public.restaurant_loyalty_settings where organization_id = p_org;
  if v_s.organization_id is null or not v_s.enabled then raise exception 'برنامج المكافآت غير مفعّل' using errcode = 'check_violation'; end if;
  select * into rw from public.restaurant_loyalty_rewards where id = p_reward and organization_id = p_org and is_active;
  if rw.id is null then raise exception 'المكافأة غير موجودة' using errcode = 'check_violation'; end if;
  v_value := case when rw.kind = 'discount' then rw.value_cents
                  else (select price_cents from public.restaurant_variants where id = rw.variant_id) end;
  if coalesce(v_value, 0) <= 0 then raise exception 'المكافأة غير صالحة' using errcode = 'check_violation'; end if;

  perform pg_advisory_xact_lock(hashtextextended(p_org::text || ':' || v_key, 0));
  select out_balance into v_bal from app.loyalty_points(p_org, v_key);
  if v_bal < rw.points_cost then raise exception 'رصيد النقاط غير كافٍ' using errcode = 'check_violation'; end if;

  v_expires := now() + make_interval(days => v_s.coupon_valid_days);
  loop
    v_try := v_try + 1;
    v_code := 'LB-' || (select string_agg(substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1), '')
                          from generate_series(1, 6));
    begin
      insert into public.restaurant_loyalty_coupons
        (organization_id, phone_key, code, points_cost, value_cents, expires_at, reward_id, reward_name)
      values (p_org, v_key, v_code, rw.points_cost, v_value, v_expires, rw.id, rw.name);
      exit;
    exception when unique_violation then
      if v_try >= 5 then raise; end if;
    end;
  end loop;
  insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, p_branch, auth.uid(), 'restaurant.loyalty.staff_redeemed', 'loyalty_phone', v_key,
          jsonb_build_object('reward', rw.id, 'points', rw.points_cost, 'value_cents', v_value));
  return jsonb_build_object('code', v_code, 'value_cents', v_value, 'expires_at', v_expires,
                            'reward', rw.name, 'balance', v_bal - rw.points_cost);
end;
$$;

-- ---------------------------------------------------------------------------
-- House accounts
-- ---------------------------------------------------------------------------
create table public.restaurant_house_accounts (
  customer_id        uuid primary key references public.customers(id) on delete cascade,
  organization_id    uuid not null references public.organizations(id) on delete cascade,
  credit_limit_cents bigint not null default 0 check (credit_limit_cents between 0 and 100000000000),
  payment_terms_days int not null default 30 check (payment_terms_days between 0 and 365),
  contact_name       text check (length(contact_name) <= 120),
  note               text check (length(note) <= 500),
  is_active          boolean not null default true,
  created_by         uuid references auth.users(id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table public.restaurant_account_entries (
  id               bigint generated always as identity primary key,
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  branch_id        uuid references public.branches(id) on delete set null,
  customer_id      uuid not null references public.restaurant_house_accounts(customer_id) on delete cascade,
  kind             text not null check (kind in ('charge', 'payment', 'adjustment')),
  -- Signed: positive = the customer owes more.
  amount_cents     bigint not null check (amount_cents <> 0),
  order_id         uuid references public.restaurant_orders(id) on delete set null,
  invoice_id       uuid references public.invoices(id) on delete set null,
  note             text check (length(note) <= 300),
  actor_id         uuid,
  approved_by      uuid,
  created_at       timestamptz not null default now(),
  check ((kind = 'charge' and amount_cents > 0) or (kind = 'payment' and amount_cents < 0) or kind = 'adjustment')
);
create index restaurant_account_entries_customer_idx on public.restaurant_account_entries(customer_id, created_at);

create or replace function app.account_entries_immutable()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' and not exists (select 1 from public.restaurant_house_accounts where customer_id = old.customer_id) then
    return old;
  end if;
  raise exception 'the account ledger is append-only; record an adjustment' using errcode = 'check_violation';
end;
$$;
create trigger restaurant_account_entries_no_update before update or delete on public.restaurant_account_entries
  for each row execute function app.account_entries_immutable();

create or replace function app.account_balance(p_customer uuid)
returns bigint language sql stable security definer set search_path = '' as $$
  select coalesce(sum(amount_cents), 0)::bigint from public.restaurant_account_entries where customer_id = p_customer;
$$;

do $$
declare t text;
begin
  foreach t in array array['restaurant_loyalty_rewards', 'restaurant_loyalty_adjustments', 'restaurant_promotions',
                           'restaurant_order_promotions', 'restaurant_house_accounts', 'restaurant_account_entries'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;

-- Rewards and promotions are menu-like: readable by any member (the till
-- shows them); adjustments and accounts are not.
create policy loyalty_rewards_select on public.restaurant_loyalty_rewards for select to authenticated
  using (app.is_member_of(organization_id));
create policy promotions_select on public.restaurant_promotions for select to authenticated
  using (app.is_member_of(organization_id));
create policy order_promotions_select on public.restaurant_order_promotions for select to authenticated
  using (exists (select 1 from public.restaurant_orders o where o.id = order_id));
create policy loyalty_adjustments_select on public.restaurant_loyalty_adjustments for select to authenticated
  using (app.has_permission(organization_id, 'restaurant.loyalty.manage'));
create policy house_accounts_select on public.restaurant_house_accounts for select to authenticated
  using (app.has_permission(organization_id, 'restaurant.account.manage')
         or app.has_permission(organization_id, 'restaurant.account.charge'));
create policy account_entries_select on public.restaurant_account_entries for select to authenticated
  using (app.has_permission(organization_id, 'restaurant.account.manage'));

create or replace function public.restaurant_account_save(
  p_org uuid, p_customer uuid, p_limit_cents bigint, p_terms_days int, p_active boolean, p_contact text default null, p_note text default null
) returns void language plpgsql security definer set search_path = '' as $$
declare v_before jsonb;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_permission(p_org, 'restaurant.account.manage') then raise exception 'not permitted' using errcode = '42501'; end if;
  if not exists (select 1 from public.customers where id = p_customer and organization_id = p_org and deleted_at is null) then
    raise exception 'العميل غير موجود' using errcode = 'check_violation';
  end if;
  if p_limit_cents is null or p_limit_cents < 0 or coalesce(p_terms_days, -1) not between 0 and 365 then
    raise exception 'الحد أو مدة السداد غير صالحة' using errcode = '22023';
  end if;
  select to_jsonb(a) into v_before from public.restaurant_house_accounts a where customer_id = p_customer;
  insert into public.restaurant_house_accounts
    (customer_id, organization_id, credit_limit_cents, payment_terms_days, contact_name, note, is_active, created_by)
  values (p_customer, p_org, p_limit_cents, p_terms_days, nullif(trim(coalesce(p_contact, '')), ''),
          nullif(trim(coalesce(p_note, '')), ''), coalesce(p_active, true), auth.uid())
  on conflict (customer_id) do update
    set credit_limit_cents = excluded.credit_limit_cents, payment_terms_days = excluded.payment_terms_days,
        contact_name = excluded.contact_name, note = excluded.note, is_active = excluded.is_active, updated_at = now();
  insert into public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, before, after)
  values (p_org, auth.uid(), 'restaurant.account.saved', 'customer', p_customer::text, v_before,
          jsonb_build_object('limit', p_limit_cents, 'terms', p_terms_days, 'active', p_active));
end;
$$;

-- Charge an order to the customer's account: invoiced to them, left unpaid.
create or replace function public.restaurant_account_charge(p_org uuid, p_order uuid, p_customer uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  o       record;
  a       public.restaurant_house_accounts%rowtype;
  v_inv   uuid;
  v_due   bigint;
  v_bal   bigint;
  v_by    uuid;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select id, branch_id, status, table_id, invoice_id, total_cents, number into o
    from public.restaurant_orders where id = p_order and organization_id = p_org for update;
  if o.id is null then raise exception 'الطلب غير موجود' using errcode = 'check_violation'; end if;
  if not app.has_branch_permission(p_org, o.branch_id, 'restaurant.account.charge') then raise exception 'not permitted' using errcode = '42501'; end if;
  if o.status in ('cancelled', 'pending_verification', 'new') then raise exception 'أكّد الطلب أولًا' using errcode = 'check_violation'; end if;
  select * into a from public.restaurant_house_accounts where customer_id = p_customer and organization_id = p_org for update;
  if a.customer_id is null or not a.is_active then raise exception 'لا يوجد حساب آجل فعّال لهذا العميل' using errcode = 'check_violation'; end if;
  if o.invoice_id is not null and exists (select 1 from public.restaurant_account_entries where order_id = p_order and kind = 'charge') then
    raise exception 'الطلب على الحساب بالفعل' using errcode = 'check_violation';
  end if;

  v_inv := app.restaurant_issue_invoice(p_order, p_customer);
  select total_cents - paid_cents into v_due from public.invoices where id = v_inv;
  if v_due <= 0 then raise exception 'الطلب مدفوع بالكامل' using errcode = 'check_violation'; end if;
  update public.invoices set customer_id = p_customer,
         due_at = coalesce(due_at, now() + make_interval(days => a.payment_terms_days))
   where id = v_inv;

  v_bal := app.account_balance(p_customer);
  if v_bal + v_due > a.credit_limit_cents then
    v_by := app.require_approval(p_org, o.branch_id, 'account.overlimit', p_customer, v_bal + v_due - a.credit_limit_cents);
  end if;

  insert into public.restaurant_account_entries (organization_id, branch_id, customer_id, kind, amount_cents, order_id, invoice_id, actor_id, approved_by)
  values (p_org, o.branch_id, p_customer, 'charge', v_due, p_order, v_inv, auth.uid(), v_by);

  -- Settled for the restaurant's purposes: close it once served.
  update public.restaurant_orders set status = 'completed' where id = p_order and status = 'served';
  if o.table_id is not null and o.status = 'served' then
    update public.restaurant_tables set status = 'cleaning' where id = o.table_id and status in ('occupied', 'waiting_payment');
  end if;

  insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, o.branch_id, auth.uid(), 'restaurant.account.charged', 'restaurant_order', p_order::text,
          jsonb_build_object('customer', p_customer, 'amount', v_due, 'invoice', v_inv, 'over_limit_approved_by', v_by));
  return jsonb_build_object('invoice_id', v_inv, 'amount_cents', v_due, 'balance_cents', v_bal + v_due);
end;
$$;

-- Money received on account: allocated to the oldest open invoices.
create or replace function public.restaurant_account_payment(
  p_org uuid, p_branch uuid, p_customer uuid, p_amount bigint, p_method text, p_reference text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  r          record;
  v_left     bigint := p_amount;
  v_apply    bigint;
  v_account  uuid;
  v_currency char(3);
  v_bal      bigint;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_branch_permission(p_org, p_branch, 'restaurant.account.manage') then raise exception 'not permitted' using errcode = '42501'; end if;
  if p_method not in ('cash', 'card', 'transfer', 'wallet', 'other') then raise exception 'طريقة الدفع غير معروفة' using errcode = '22023'; end if;
  if p_amount is null or p_amount <= 0 or p_amount > 100000000000 then raise exception 'المبلغ غير صالح' using errcode = '22023'; end if;
  if not exists (select 1 from public.restaurant_house_accounts where customer_id = p_customer and organization_id = p_org) then
    raise exception 'لا يوجد حساب آجل لهذا العميل' using errcode = 'check_violation';
  end if;
  select currency into v_currency from public.organizations where id = p_org;
  if not exists (select 1 from public.branches where id = p_branch and organization_id = p_org) then
    raise exception 'الفرع غير موجود' using errcode = 'check_violation';
  end if;

  for r in
    select i.id, i.branch_id, i.total_cents - i.paid_cents as open_cents
      from public.invoices i
     where i.organization_id = p_org and i.customer_id = p_customer and i.status in ('issued', 'partially_paid')
       and exists (select 1 from public.restaurant_account_entries e where e.invoice_id = i.id and e.kind = 'charge')
     order by i.issued_at, i.created_at
     for update
  loop
    exit when v_left <= 0;
    v_apply := least(v_left, r.open_cents);
    continue when v_apply <= 0;
    insert into public.payments
      (organization_id, branch_id, invoice_id, customer_id, kind, method, amount_cents, currency, status, reference, created_by)
    values (p_org, r.branch_id, r.id, p_customer, 'payment', p_method, v_apply, v_currency, 'completed',
            left(nullif(trim(coalesce(p_reference, '')), ''), 120), auth.uid());
    v_left := v_left - v_apply;
  end loop;
  -- Anything beyond the open invoices stays on the account as credit.
  if v_left > 0 then
    insert into public.payments
      (organization_id, branch_id, customer_id, kind, method, amount_cents, currency, status, reference, created_by)
    values (p_org, p_branch, p_customer, 'payment', p_method, v_left, v_currency, 'completed',
            left(coalesce(nullif(trim(coalesce(p_reference, '')), ''), 'رصيد دائن'), 120), auth.uid());
  end if;

  select id into v_account from public.treasury_accounts where branch_id = p_branch and is_active and is_default limit 1;
  if v_account is not null then
    insert into public.treasury_transactions
      (organization_id, branch_id, account_id, direction, amount_cents, currency, category, reason, ref_type, ref_id, created_by)
    values (p_org, p_branch, v_account, 'in', p_amount, v_currency, 'account_payment', 'سداد حساب آجل',
            'customer', p_customer, auth.uid());
  end if;

  insert into public.restaurant_account_entries (organization_id, branch_id, customer_id, kind, amount_cents, note, actor_id)
  values (p_org, p_branch, p_customer, 'payment', -p_amount, left(nullif(trim(coalesce(p_reference, '')), ''), 300), auth.uid());
  v_bal := app.account_balance(p_customer);
  insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, p_branch, auth.uid(), 'restaurant.account.payment', 'customer', p_customer::text,
          jsonb_build_object('amount', p_amount, 'method', p_method, 'reference', p_reference, 'balance', v_bal));
  return jsonb_build_object('balance_cents', v_bal, 'unallocated_cents', v_left);
end;
$$;

create or replace function public.restaurant_account_adjust(p_org uuid, p_branch uuid, p_customer uuid, p_amount bigint, p_note text)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_by uuid; v_bal bigint;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_branch_permission(p_org, p_branch, 'restaurant.account.manage') then raise exception 'not permitted' using errcode = '42501'; end if;
  if not exists (select 1 from public.restaurant_house_accounts where customer_id = p_customer and organization_id = p_org) then
    raise exception 'لا يوجد حساب آجل لهذا العميل' using errcode = 'check_violation';
  end if;
  if p_amount is null or p_amount = 0 or abs(p_amount) > 100000000000 then raise exception 'المبلغ غير صالح' using errcode = '22023'; end if;
  if nullif(trim(coalesce(p_note, '')), '') is null then raise exception 'اكتب سبب التسوية' using errcode = '22023'; end if;
  v_by := app.require_approval(p_org, p_branch, 'account.adjust', p_customer, abs(p_amount));
  insert into public.restaurant_account_entries (organization_id, branch_id, customer_id, kind, amount_cents, note, actor_id, approved_by)
  values (p_org, p_branch, p_customer, 'adjustment', p_amount, left(trim(p_note), 300), auth.uid(), v_by);
  v_bal := app.account_balance(p_customer);
  insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, p_branch, auth.uid(), 'restaurant.account.adjusted', 'customer', p_customer::text,
          jsonb_build_object('amount', p_amount, 'note', p_note, 'approved_by', v_by, 'balance', v_bal));
  return v_bal;
end;
$$;

-- A statement: the opening balance, every entry in the period with a running
-- balance, and the closing balance.
create or replace function public.restaurant_account_statement(p_org uuid, p_customer uuid, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_tz text; v_start timestamptz; v_end timestamptz; v_open bigint; v_entries jsonb; c record; a record;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_permission(p_org, 'restaurant.account.manage') then raise exception 'not permitted' using errcode = '42501'; end if;
  select * into a from public.restaurant_house_accounts where customer_id = p_customer and organization_id = p_org;
  if a.customer_id is null then raise exception 'لا يوجد حساب آجل لهذا العميل' using errcode = 'check_violation'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then raise exception 'الفترة غير صالحة' using errcode = '22023'; end if;
  select timezone into v_tz from public.organizations where id = p_org;
  v_start := (p_from::timestamp) at time zone coalesce(nullif(v_tz, ''), 'Africa/Cairo');
  v_end := ((p_to + 1)::timestamp) at time zone coalesce(nullif(v_tz, ''), 'Africa/Cairo');
  select name, phone into c from public.customers where id = p_customer;

  select coalesce(sum(amount_cents), 0) into v_open from public.restaurant_account_entries
   where customer_id = p_customer and created_at < v_start;
  select coalesce(jsonb_agg(x order by (x ->> 'id')::bigint), '[]'::jsonb) into v_entries from (
    select jsonb_build_object('id', e.id, 'at', e.created_at, 'kind', e.kind, 'amount_cents', e.amount_cents, 'note', e.note,
             'order_number', o.number, 'invoice_number', i.number,
             'balance_cents', v_open + sum(e.amount_cents) over (order by e.id)) as x
      from public.restaurant_account_entries e
      left join public.restaurant_orders o on o.id = e.order_id
      left join public.invoices i on i.id = e.invoice_id
     where e.customer_id = p_customer and e.created_at >= v_start and e.created_at < v_end
  ) t;
  return jsonb_build_object('customer', jsonb_build_object('id', p_customer, 'name', c.name, 'phone', c.phone),
                            'credit_limit_cents', a.credit_limit_cents, 'terms_days', a.payment_terms_days,
                            'from', p_from, 'to', p_to, 'opening_cents', v_open, 'entries', v_entries,
                            'closing_cents', v_open + coalesce((select sum(amount_cents) from public.restaurant_account_entries
                                                                  where customer_id = p_customer and created_at >= v_start and created_at < v_end), 0),
                            'balance_now_cents', app.account_balance(p_customer));
end;
$$;

-- Accounts with balances, for the accounts screen and the till's picker.
create or replace function public.restaurant_accounts_list(p_org uuid)
returns table (out_customer_id uuid, out_name text, out_phone text, out_limit_cents bigint, out_balance_cents bigint,
               out_terms_days int, out_active boolean, out_contact text, out_overdue_cents bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not (app.has_permission(p_org, 'restaurant.account.manage') or app.has_permission(p_org, 'restaurant.account.charge')) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  return query
    select a.customer_id, c.name, c.phone, a.credit_limit_cents, app.account_balance(a.customer_id), a.payment_terms_days,
           a.is_active, a.contact_name,
           coalesce((select sum(i.total_cents - i.paid_cents) from public.invoices i
                      where i.customer_id = a.customer_id and i.status in ('issued', 'partially_paid')
                        and i.due_at is not null and i.due_at < now()
                        and exists (select 1 from public.restaurant_account_entries e where e.invoice_id = i.id and e.kind = 'charge')), 0)::bigint
      from public.restaurant_house_accounts a join public.customers c on c.id = a.customer_id
     where a.organization_id = p_org
     order by c.name;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'app.promotion_live(public.restaurant_promotions, text)', 'app.account_entries_immutable()', 'app.account_balance(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
  foreach f in array array[
    'public.restaurant_promotions_apply(uuid, uuid, text)',
    'public.restaurant_promotion_save(uuid, uuid, jsonb)',
    'public.restaurant_loyalty_reward_save(uuid, uuid, text, integer, text, bigint, uuid, boolean)',
    'public.restaurant_loyalty_adjust(uuid, text, integer, text)',
    'public.restaurant_loyalty_staff_redeem(uuid, uuid, text, uuid)',
    'public.restaurant_account_save(uuid, uuid, bigint, integer, boolean, text, text)',
    'public.restaurant_account_charge(uuid, uuid, uuid)',
    'public.restaurant_account_payment(uuid, uuid, uuid, bigint, text, text)',
    'public.restaurant_account_adjust(uuid, uuid, uuid, bigint, text)',
    'public.restaurant_account_statement(uuid, uuid, date, date)',
    'public.restaurant_accounts_list(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
