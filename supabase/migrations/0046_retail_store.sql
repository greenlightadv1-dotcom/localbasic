-- =============================================================================
-- LOCAL BASIC — 0046 Retail online store
--
-- A shop can now sell in store (POS, 0014) and buy stock (purchasing, 0045).
-- This is the third door: a customer ordering from the storefront.
--
-- The decisions that matter, stated once:
--
--   * STOCK IS COMMITTED WHEN THE ORDER IS PLACED, through the SAME ledger the
--     POS writes. That is the whole point: 0012's row lock and non-negative
--     CHECK are what stop the till and the storefront selling the same last
--     unit, and they only work if both go through retail_stock_movements.
--     Cancelling writes a compensating movement; nothing is ever edited.
--
--   * AN ORDER IS NOT AN INVOICE. It becomes one — with a payment and a
--     treasury entry, through the same Core tables the POS uses — only when it
--     is completed. Until then no money has moved, because none has.
--
--   * NO PAYMENT PROVIDER IS INVENTED. There is no gateway in this codebase,
--     so the storefront offers what a shop can actually honour today: cash on
--     delivery, or pay on collection. An online payment method is a later
--     adapter, not a pretend column.
--
--   * PRICES COME FROM THE DATABASE. The cart names variants and quantities.
--     Unit price, tax and every total are read back and recomputed here, as in
--     retail_create_sale. A cart that says a television costs five pounds gets
--     a television at the catalog price.
--
--   * A GUEST NEEDS NO ACCOUNT. An opaque CSPRNG token follows exactly one
--     order, the same mechanism the restaurant side uses. An idempotency key
--     absorbs the double-clicked checkout button.
--
-- Everything additive.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Store settings, scoped like the restaurant's (0038): a branch value wins,
--    an organization value is the default.
-- ---------------------------------------------------------------------------
create or replace function app.retail_setting_bool(
  p_org uuid, p_branch uuid, p_key text, p_default boolean
) returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select (s.value #>> '{}')::boolean from public.settings s
      where s.organization_id = p_org and s.branch_id = p_branch and s.key = p_key),
    (select (s.value #>> '{}')::boolean from public.settings s
      where s.organization_id = p_org and s.branch_id is null and s.key = p_key),
    p_default);
$$;

create or replace function app.retail_setting_int(
  p_org uuid, p_branch uuid, p_key text, p_default bigint
) returns bigint language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select (s.value #>> '{}')::bigint from public.settings s
      where s.organization_id = p_org and s.branch_id = p_branch and s.key = p_key),
    (select (s.value #>> '{}')::bigint from public.settings s
      where s.organization_id = p_org and s.branch_id is null and s.key = p_key),
    p_default);
$$;

create or replace function app.retail_store_enabled(p_org uuid, p_branch uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select app.retail_setting_bool(p_org, p_branch, 'retail.store_enabled', false);
$$;

/**
 * Is this fulfilment type on sale at this branch?
 *
 * Both default to true, so switching the store on yields a working storefront
 * without hunting for two more keys; a shop that does not deliver says so.
 */
create or replace function app.retail_fulfillment_enabled(
  p_org uuid, p_branch uuid, p_type text
) returns boolean language sql stable security definer set search_path = '' as $$
  select case p_type
    when 'pickup'   then app.retail_setting_bool(p_org, p_branch, 'retail.pickup_enabled', true)
    when 'delivery' then app.retail_setting_bool(p_org, p_branch, 'retail.delivery_enabled', true)
    else false
  end;
$$;

-- Validation of what may be stored, mirroring 0038: RLS decides who may write
-- a setting, this decides what a setting may say.
create or replace function app.check_retail_setting()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.key in (
    'retail.store_enabled', 'retail.pickup_enabled', 'retail.delivery_enabled'
  ) then
    if jsonb_typeof(new.value) <> 'boolean' then
      raise exception '% must be true or false', new.key using errcode = 'check_violation';
    end if;
  elsif new.key in ('retail.delivery_fee_cents', 'retail.min_order_cents') then
    if jsonb_typeof(new.value) <> 'number'
       or (new.value #>> '{}')::numeric < 0
       or (new.value #>> '{}')::numeric <> floor((new.value #>> '{}')::numeric) then
      raise exception '% must be a whole number of minor units, not negative', new.key
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

create trigger settings_retail_validate
  before insert or update on public.settings
  for each row execute function app.check_retail_setting();

-- ---------------------------------------------------------------------------
-- 2. The order.
-- ---------------------------------------------------------------------------
create table public.retail_orders (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations(id) on delete cascade,
  branch_id         uuid not null references public.branches(id) on delete restrict,
  number            text not null,
  -- 'online' today. The column exists so a future channel is a value, not a
  -- migration.
  channel           text not null default 'online' check (channel in ('online')),
  status            text not null default 'placed'
                    check (status in ('placed','confirmed','packed','fulfilled','completed','cancelled')),
  fulfillment_type  text not null check (fulfillment_type in ('pickup','delivery')),
  customer_id       uuid references public.customers(id) on delete set null,
  contact_name      text not null check (length(trim(contact_name)) between 2 and 120),
  contact_phone     text not null check (length(trim(contact_phone)) between 6 and 30),
  currency          char(3) not null,
  -- All derived from the lines and the fee by trigger. Never written directly.
  subtotal_cents    bigint not null default 0 check (subtotal_cents >= 0),
  tax_cents         bigint not null default 0 check (tax_cents >= 0),
  delivery_fee_cents bigint not null default 0 check (delivery_fee_cents >= 0),
  total_cents       bigint not null default 0 check (total_cents >= 0),
  -- What the shop can actually honour today. An online gateway is a later
  -- adapter; naming one here would be a promise the code cannot keep.
  payment_method    text not null default 'cash_on_delivery'
                    check (payment_method in ('cash_on_delivery','pay_on_collection')),
  -- Opaque, CSPRNG. Follows exactly one order and nothing else.
  public_token      text not null unique,
  -- Absorbs the double-clicked checkout button.
  idempotency_key   text,
  note              text,
  placed_at         timestamptz not null default now(),
  confirmed_at      timestamptz,
  fulfilled_at      timestamptz,
  completed_at      timestamptz,
  cancelled_at      timestamptz,
  cancel_reason     text,
  -- Set when the order becomes an invoice, which is the moment money exists.
  invoice_id        uuid references public.invoices(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create unique index retail_orders_number_unique
  on public.retail_orders(organization_id, branch_id, number);
create unique index retail_orders_idempotency_unique
  on public.retail_orders(organization_id, idempotency_key)
  where idempotency_key is not null;
create index retail_orders_branch_idx
  on public.retail_orders(organization_id, branch_id, placed_at desc);
create index retail_orders_status_idx
  on public.retail_orders(organization_id, branch_id, status, placed_at desc);
create index retail_orders_customer_idx on public.retail_orders(customer_id);
create trigger retail_orders_touch before update on public.retail_orders
  for each row execute function app.touch_updated_at();

create table public.retail_order_items (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  order_id         uuid not null references public.retail_orders(id) on delete cascade,
  variant_id       uuid not null references public.retail_variants(id) on delete restrict,
  -- Snapshots: the document still reads correctly after the catalog moves on.
  product_name     text not null,
  variant_name     text not null,
  quantity         numeric(14,3) not null check (quantity > 0),
  -- Read back from the catalog at checkout, never sent by the browser.
  unit_price_cents bigint not null check (unit_price_cents >= 0),
  tax_rate_bp      int not null default 0 check (tax_rate_bp between 0 and 10000),
  line_total_cents bigint not null default 0 check (line_total_cents >= 0),
  tax_total_cents  bigint not null default 0 check (tax_total_cents >= 0),
  position         int not null default 0,
  created_at       timestamptz not null default now()
);
create index retail_order_items_order_idx on public.retail_order_items(order_id, position);
create index retail_order_items_variant_idx on public.retail_order_items(variant_id);

-- A delivery order says where it is going. Its own table, so a pickup order
-- does not carry seven nullable address columns.
create table public.retail_order_deliveries (
  order_id         uuid primary key references public.retail_orders(id) on delete cascade,
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  recipient_name   text not null check (length(trim(recipient_name)) between 2 and 120),
  phone            text not null check (length(trim(phone)) between 6 and 30),
  city             text not null check (length(trim(city)) between 2 and 80),
  area             text,
  address_line     text not null check (length(trim(address_line)) between 5 and 400),
  landmark         text,
  created_at       timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 3. Tenancy guards.
-- ---------------------------------------------------------------------------
create or replace function app.check_retail_order_tenancy()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_org uuid;
begin
  select organization_id into v_org from public.branches where id = new.branch_id;
  if v_org is distinct from new.organization_id then
    raise exception 'order crosses organizations' using errcode = 'check_violation';
  end if;

  if new.customer_id is not null then
    select organization_id into v_org from public.customers where id = new.customer_id;
    if v_org is distinct from new.organization_id then
      raise exception 'customer belongs to another organization'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

create trigger retail_orders_tenancy
  before insert or update on public.retail_orders
  for each row execute function app.check_retail_order_tenancy();

create or replace function app.check_retail_order_item_tenancy()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_org uuid;
begin
  select organization_id into v_org from public.retail_orders where id = new.order_id;
  if v_org is distinct from new.organization_id then
    raise exception 'order line crosses organizations' using errcode = 'check_violation';
  end if;

  select organization_id into v_org from public.retail_variants where id = new.variant_id;
  if v_org is distinct from new.organization_id then
    raise exception 'variant belongs to another organization'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger retail_order_items_tenancy
  before insert or update on public.retail_order_items
  for each row execute function app.check_retail_order_item_tenancy();

-- ---------------------------------------------------------------------------
-- 4. Derived totals.
--
-- Tax is computed per line, on the line's own rate, and the fee is added once.
-- Same reasoning as restaurant order totals (0026) and purchase orders (0045):
-- a number that can be written directly eventually is written wrongly.
-- ---------------------------------------------------------------------------
create or replace function app.derive_retail_order_line_total()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.line_total_cents := round(new.quantity * new.unit_price_cents)::bigint;
  new.tax_total_cents  := round(new.line_total_cents * new.tax_rate_bp / 10000.0)::bigint;
  return new;
end;
$$;

create trigger retail_order_items_total
  before insert or update on public.retail_order_items
  for each row execute function app.derive_retail_order_line_total();

create or replace function app.derive_retail_order_total()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_order uuid := coalesce(new.order_id, old.order_id);
  v_sub   bigint;
  v_tax   bigint;
begin
  select coalesce(sum(line_total_cents), 0), coalesce(sum(tax_total_cents), 0)
    into v_sub, v_tax
    from public.retail_order_items where order_id = v_order;

  update public.retail_orders
     set subtotal_cents = v_sub,
         tax_cents      = v_tax,
         total_cents    = v_sub + v_tax + delivery_fee_cents
   where id = v_order;
  return null;
end;
$$;

create trigger retail_order_items_rollup
  after insert or update or delete on public.retail_order_items
  for each row execute function app.derive_retail_order_total();

-- ---------------------------------------------------------------------------
-- 5. The state machine.
--
-- placed → confirmed → packed → fulfilled → completed, and anything before
-- completed may be cancelled. Completed and cancelled are final.
-- ---------------------------------------------------------------------------
create or replace function app.check_retail_order_transition()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.organization_id <> old.organization_id or new.branch_id <> old.branch_id then
    raise exception 'an order cannot move between tenants' using errcode = 'check_violation';
  end if;
  if new.public_token <> old.public_token then
    raise exception 'an order token cannot be rewritten' using errcode = 'check_violation';
  end if;

  if new.status = old.status then return new; end if;

  if not (
       (old.status = 'placed'    and new.status in ('confirmed','cancelled'))
    or (old.status = 'confirmed' and new.status in ('packed','cancelled'))
    or (old.status = 'packed'    and new.status in ('fulfilled','cancelled'))
    or (old.status = 'fulfilled' and new.status in ('completed','cancelled'))
  ) then
    raise exception 'cannot move an order from % to %', old.status, new.status
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger retail_orders_transition
  before update on public.retail_orders
  for each row execute function app.check_retail_order_transition();

-- ---------------------------------------------------------------------------
-- 6. RLS.
--
-- Staff read and act through `retail.order.read` / `retail.order.manage`.
-- The storefront is anonymous and reads NOTHING from these tables directly:
-- every public answer comes from a SECURITY DEFINER function below, which is
-- why anon holds no privilege here at all.
-- ---------------------------------------------------------------------------
alter table public.retail_orders            enable row level security;
alter table public.retail_orders            force row level security;
alter table public.retail_order_items       enable row level security;
alter table public.retail_order_items       force row level security;
alter table public.retail_order_deliveries  enable row level security;
alter table public.retail_order_deliveries  force row level security;

create policy retail_orders_select on public.retail_orders for select to authenticated
  using (app.has_branch_permission(organization_id, branch_id, 'retail.order.read'));

create policy retail_order_items_select
  on public.retail_order_items for select to authenticated
  using (exists (
    select 1 from public.retail_orders o
     where o.id = order_id
       and app.has_branch_permission(o.organization_id, o.branch_id, 'retail.order.read')
  ));

create policy retail_order_deliveries_select
  on public.retail_order_deliveries for select to authenticated
  using (exists (
    select 1 from public.retail_orders o
     where o.id = order_id
       and app.has_branch_permission(o.organization_id, o.branch_id, 'retail.order.read')
  ));

grant select on public.retail_orders           to authenticated;
grant select on public.retail_order_items      to authenticated;
grant select on public.retail_order_deliveries to authenticated;
revoke all on public.retail_orders           from anon;
revoke all on public.retail_order_items      from anon;
revoke all on public.retail_order_deliveries from anon;

-- ---------------------------------------------------------------------------
-- 7. The public storefront: what an anonymous visitor may see.
--
-- Projections, not tables. A visitor learns the catalog and whether something
-- is in stock — never cost, never a supplier, never another branch's figures,
-- and never anything about a shop whose store is switched off.
-- ---------------------------------------------------------------------------
create or replace function public.retail_store_context(
  p_org_slug    text,
  p_branch_slug text default null
)
returns table (
  out_organization_id uuid,
  out_branch_id       uuid,
  out_branch_slug     text,
  out_name            text,
  out_currency        char(3),
  out_pickup          boolean,
  out_delivery        boolean,
  out_delivery_fee    bigint,
  out_min_order       bigint
)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_org    uuid;
  v_branch uuid;
  v_slug   text;
begin
  select o.id into v_org
    from public.organizations o
    join public.organization_modules m
      on m.organization_id = o.id and m.module_key = 'retail' and m.enabled
   where lower(o.slug::text) = lower(trim(p_org_slug))
     and o.status = 'active' and o.deleted_at is null;
  if v_org is null then return; end if;

  if p_branch_slug is null then
    select b.id, b.slug::text into v_branch, v_slug
      from public.branches b
     where b.organization_id = v_org and b.is_active and b.deleted_at is null
     order by b.created_at limit 1;
  else
    select b.id, b.slug::text into v_branch, v_slug
      from public.branches b
     where b.organization_id = v_org and lower(b.slug::text) = lower(trim(p_branch_slug))
       and b.is_active and b.deleted_at is null;
  end if;
  if v_branch is null then return; end if;

  -- The switch is the gate. A shop that has not opened its store is, to an
  -- anonymous visitor, indistinguishable from one that does not exist.
  if not app.retail_store_enabled(v_org, v_branch) then return; end if;

  return query
  select v_org, v_branch, v_slug, o.name::text, o.currency,
         app.retail_fulfillment_enabled(v_org, v_branch, 'pickup'),
         app.retail_fulfillment_enabled(v_org, v_branch, 'delivery'),
         app.retail_setting_int(v_org, v_branch, 'retail.delivery_fee_cents', 0),
         app.retail_setting_int(v_org, v_branch, 'retail.min_order_cents', 0)
    from public.organizations o where o.id = v_org;
end;
$$;

/**
 * The storefront catalog.
 *
 * Only products flagged `is_online`, only active variants, and only what this
 * branch actually has on the shelf. `cost_cents` is never selected: what the
 * shop paid is not the customer's business.
 */
create or replace function public.retail_store_catalog(
  p_org_slug    text,
  p_branch_slug text default null,
  p_search      text default null
)
returns table (
  out_variant_id   uuid,
  out_product_id   uuid,
  out_product_name text,
  out_variant_name text,
  out_description  text,
  out_image_url    text,
  out_category     text,
  out_price_cents  bigint,
  out_tax_rate_bp  int,
  out_in_stock     boolean,
  out_quantity     numeric
)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_ctx record;
begin
  select * into v_ctx from public.retail_store_context(p_org_slug, p_branch_slug);
  if v_ctx.out_organization_id is null then return; end if;

  return query
  select v.id, p.id, p.name::text, v.name::text, p.description, p.image_url,
         c.name::text,
         v.price_cents, p.tax_rate_bp,
         coalesce(sl.quantity, 0) > 0,
         coalesce(sl.quantity, 0)
    from public.retail_variants v
    join public.retail_products p on p.id = v.product_id
    left join public.retail_categories c on c.id = p.category_id
    left join public.retail_stock_levels sl
      on sl.variant_id = v.id and sl.branch_id = v_ctx.out_branch_id
   where v.organization_id = v_ctx.out_organization_id
     and v.is_active and v.deleted_at is null
     and p.is_active and p.deleted_at is null and p.is_online
     and (p_search is null or trim(p_search) = ''
          or p.name ilike '%' || app.like_literal(trim(p_search)) || '%'
          or v.sku ilike '%' || app.like_literal(trim(p_search)) || '%')
   order by p.name, v.name
   limit 500;
end;
$$;

/**
 * Price a cart without placing it.
 *
 * The checkout page needs a total before the customer commits, and it must be
 * the SAME total the order will get — so it is computed here, from the catalog,
 * by the same arithmetic the order uses. The cart contributes ids and
 * quantities and nothing else.
 */
create or replace function public.retail_price_cart(
  p_org_slug    text,
  p_branch_slug text,
  p_items       jsonb,
  p_fulfillment text default 'pickup'
)
returns table (
  out_subtotal_cents bigint,
  out_tax_cents      bigint,
  out_fee_cents      bigint,
  out_total_cents    bigint,
  out_currency       char(3),
  out_min_order      bigint
)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_ctx   record;
  v_item  jsonb;
  v_row   record;
  v_qty   numeric(14,3);
  v_line  bigint;
  v_sub   bigint := 0;
  v_tax   bigint := 0;
  v_fee   bigint := 0;
begin
  select * into v_ctx from public.retail_store_context(p_org_slug, p_branch_slug);
  if v_ctx.out_organization_id is null then return; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then return; end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    select v.price_cents, p.tax_rate_bp into v_row
      from public.retail_variants v
      join public.retail_products p on p.id = v.product_id
     where v.id = (v_item ->> 'variant_id')::uuid
       and v.organization_id = v_ctx.out_organization_id
       and v.is_active and v.deleted_at is null
       and p.is_active and p.deleted_at is null and p.is_online;
    continue when v_row.price_cents is null;

    v_qty  := greatest(coalesce((v_item ->> 'quantity')::numeric, 0), 0);
    continue when v_qty = 0;

    v_line := round(v_qty * v_row.price_cents)::bigint;
    v_sub  := v_sub + v_line;
    v_tax  := v_tax + round(v_line * v_row.tax_rate_bp / 10000.0)::bigint;
  end loop;

  if p_fulfillment = 'delivery' and v_ctx.out_delivery then
    v_fee := v_ctx.out_delivery_fee;
  end if;

  return query select v_sub, v_tax, v_fee, v_sub + v_tax + v_fee,
                      v_ctx.out_currency, v_ctx.out_min_order;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Checkout.
--
-- The only place an anonymous visitor writes anything. It commits stock
-- through retail_stock_movements, so the storefront and the till contend for
-- the same last unit on the same row lock and the loser is refused rather than
-- overselling.
--
-- p_items: [{"variant_id": "...", "quantity": 2}, ...]
-- ---------------------------------------------------------------------------
create or replace function public.retail_place_order(
  p_org_slug        text,
  p_branch_slug     text,
  p_items           jsonb,
  p_fulfillment     text,
  p_contact_name    text,
  p_contact_phone   text,
  p_payment_method  text default 'cash_on_delivery',
  p_note            text default null,
  p_idempotency_key text default null,
  p_recipient_name  text default null,
  p_address_phone   text default null,
  p_city            text default null,
  p_area            text default null,
  p_address_line    text default null,
  p_landmark        text default null
)
returns table (out_order_id uuid, out_number text, out_token text, out_total_cents bigint)
language plpgsql security definer set search_path = '' as $$
declare
  v_ctx      record;
  v_existing record;
  v_order    uuid;
  v_number   text;
  v_token    text;
  v_item     jsonb;
  v_row      record;
  v_qty      numeric(14,3);
  v_position int := 0;
  v_fee      bigint := 0;
  v_total    bigint;
  v_min      bigint;
begin
  select * into v_ctx from public.retail_store_context(p_org_slug, p_branch_slug);
  if v_ctx.out_organization_id is null then
    raise exception 'store not found' using errcode = 'check_violation';
  end if;

  if p_fulfillment not in ('pickup','delivery')
     or not app.retail_fulfillment_enabled(
              v_ctx.out_organization_id, v_ctx.out_branch_id, p_fulfillment) then
    raise exception 'this fulfilment type is not available' using errcode = 'check_violation';
  end if;

  if p_payment_method not in ('cash_on_delivery','pay_on_collection') then
    raise exception 'unknown payment method' using errcode = '22023';
  end if;

  -- The double-clicked button. Returning the original order is the correct
  -- answer to "place this order again": it was already placed.
  if p_idempotency_key is not null and trim(p_idempotency_key) <> '' then
    select o.id, o.number, o.public_token, o.total_cents into v_existing
      from public.retail_orders o
     where o.organization_id = v_ctx.out_organization_id
       and o.idempotency_key = trim(p_idempotency_key);
    if v_existing.id is not null then
      return query select v_existing.id, v_existing.number,
                          v_existing.public_token, v_existing.total_cents;
      return;
    end if;
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'the basket is empty' using errcode = 'check_violation';
  end if;

  if p_fulfillment = 'delivery' then
    if p_address_line is null or trim(p_address_line) = ''
       or p_city is null or trim(p_city) = '' then
      raise exception 'a delivery order needs an address' using errcode = 'check_violation';
    end if;
    v_fee := v_ctx.out_delivery_fee;
  end if;

  v_number := app.next_document_number(
                v_ctx.out_organization_id, v_ctx.out_branch_id, 'retail_order');
  v_token  := app.new_public_token();

  insert into public.retail_orders
    (organization_id, branch_id, number, status, fulfillment_type,
     contact_name, contact_phone, currency, delivery_fee_cents,
     payment_method, public_token, idempotency_key, note)
  values
    (v_ctx.out_organization_id, v_ctx.out_branch_id, v_number, 'placed', p_fulfillment,
     trim(p_contact_name), trim(p_contact_phone), v_ctx.out_currency, v_fee,
     p_payment_method, v_token, nullif(trim(coalesce(p_idempotency_key, '')), ''), p_note)
  returning id into v_order;

  for v_item in select * from jsonb_array_elements(p_items) loop
    -- PRICES COME FROM HERE, NOT FROM THE CART.
    select v.id, v.name as variant_name, v.price_cents,
           p.name as product_name, p.tax_rate_bp
      into v_row
      from public.retail_variants v
      join public.retail_products p on p.id = v.product_id
     where v.id = (v_item ->> 'variant_id')::uuid
       and v.organization_id = v_ctx.out_organization_id
       and v.is_active and v.deleted_at is null
       and p.is_active and p.deleted_at is null and p.is_online;

    if v_row.id is null then
      raise exception 'an item in the basket is no longer available'
        using errcode = 'check_violation';
    end if;

    v_qty := coalesce((v_item ->> 'quantity')::numeric, 0);
    if v_qty <= 0 then
      raise exception 'an item needs a positive quantity' using errcode = 'check_violation';
    end if;

    v_position := v_position + 1;
    insert into public.retail_order_items
      (organization_id, order_id, variant_id, product_name, variant_name,
       quantity, unit_price_cents, tax_rate_bp, position)
    values
      (v_ctx.out_organization_id, v_order, v_row.id, v_row.product_name, v_row.variant_name,
       v_qty, v_row.price_cents, v_row.tax_rate_bp, v_position);

    -- Commit the stock. Same ledger as the till, same row lock, same
    -- non-negative CHECK: an oversell aborts the whole checkout.
    insert into public.retail_stock_movements
      (organization_id, branch_id, variant_id, quantity_delta, reason,
       ref_type, ref_id, note)
    values
      (v_ctx.out_organization_id, v_ctx.out_branch_id, v_row.id, -v_qty, 'sale',
       'retail_order', v_order, 'طلب أونلاين ' || v_number);
  end loop;

  if p_fulfillment = 'delivery' then
    insert into public.retail_order_deliveries
      (order_id, organization_id, recipient_name, phone, city, area, address_line, landmark)
    values
      (v_order, v_ctx.out_organization_id,
       trim(coalesce(p_recipient_name, p_contact_name)),
       trim(coalesce(p_address_phone, p_contact_phone)),
       trim(p_city), nullif(trim(coalesce(p_area, '')), ''),
       trim(p_address_line), nullif(trim(coalesce(p_landmark, '')), ''));
  end if;

  select total_cents into v_total from public.retail_orders where id = v_order;

  -- The minimum is checked against the total the DATABASE computed, after the
  -- lines are in — a cart that under-reports its own value cannot slip under.
  v_min := v_ctx.out_min_order;
  if v_min > 0 and v_total < v_min then
    raise exception 'order below the minimum' using errcode = 'check_violation';
  end if;

  insert into public.audit_logs
    (organization_id, branch_id, actor_label, action, entity_type, entity_id, after)
  values
    (v_ctx.out_organization_id, v_ctx.out_branch_id, trim(p_contact_name),
     'retail.order.placed', 'retail_order', v_order::text,
     jsonb_build_object('number', v_number, 'total_cents', v_total,
                        'fulfillment', p_fulfillment));

  return query select v_order, v_number, v_token, v_total;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Following one order, as a guest.
--
-- The token authorises exactly this order. It reveals status and lines — never
-- another order, never the customer list, never anything about the shop's
-- finances.
-- ---------------------------------------------------------------------------
create or replace function public.retail_order_status(p_token text)
returns table (
  out_number        text,
  out_status        text,
  out_fulfillment   text,
  out_total_cents   bigint,
  out_currency      char(3),
  out_placed_at     timestamptz,
  out_payment_method text,
  out_organization  text
)
language sql stable security definer set search_path = '' as $$
  select o.number, o.status, o.fulfillment_type, o.total_cents, o.currency,
         o.placed_at, o.payment_method, g.name::text
    from public.retail_orders o
    join public.organizations g on g.id = o.organization_id
   where o.public_token = p_token;
$$;

create or replace function public.retail_order_lines(p_token text)
returns table (
  out_product_name text,
  out_variant_name text,
  out_quantity     numeric,
  out_unit_price_cents bigint,
  out_line_total_cents bigint
)
language sql stable security definer set search_path = '' as $$
  select i.product_name, i.variant_name, i.quantity, i.unit_price_cents, i.line_total_cents
    from public.retail_order_items i
    join public.retail_orders o on o.id = i.order_id
   where o.public_token = p_token
   order by i.position;
$$;

-- ---------------------------------------------------------------------------
-- 10. Staff: move an order along.
-- ---------------------------------------------------------------------------
create or replace function public.retail_order_set_status(
  p_org    uuid,
  p_branch uuid,
  p_order  uuid,
  p_status text
)
returns void language plpgsql security definer set search_path = '' as $$
declare v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not app.has_branch_permission(p_org, p_branch, 'retail.order.manage') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if p_status not in ('confirmed','packed','fulfilled') then
    raise exception 'use the dedicated function for % ', p_status using errcode = '22023';
  end if;

  update public.retail_orders
     set status = p_status,
         confirmed_at = case when p_status = 'confirmed' then now() else confirmed_at end,
         fulfilled_at = case when p_status = 'fulfilled' then now() else fulfilled_at end
   where id = p_order and organization_id = p_org and branch_id = p_branch;

  if not found then
    raise exception 'order not found' using errcode = 'check_violation';
  end if;

  insert into public.audit_logs
    (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values
    (p_org, p_branch, v_user, 'retail.order.' || p_status, 'retail_order',
     p_order::text, jsonb_build_object('status', p_status));
end;
$$;

-- ---------------------------------------------------------------------------
-- 11. Cancel: the stock comes back.
--
-- A compensating movement, not an edit — the ledger keeps both facts, that the
-- order took the stock and that it gave it back.
-- ---------------------------------------------------------------------------
create or replace function public.retail_order_cancel(
  p_org    uuid,
  p_branch uuid,
  p_order  uuid,
  p_reason text default null
)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_row  record;
  v_line record;
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not app.has_branch_permission(p_org, p_branch, 'retail.order.manage') then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  select * into v_row from public.retail_orders
   where id = p_order and organization_id = p_org and branch_id = p_branch
   for update;
  if v_row.id is null then
    raise exception 'order not found' using errcode = 'check_violation';
  end if;
  if v_row.status in ('completed','cancelled') then
    raise exception 'a % order cannot be cancelled', v_row.status
      using errcode = 'check_violation';
  end if;

  for v_line in select * from public.retail_order_items where order_id = p_order loop
    insert into public.retail_stock_movements
      (organization_id, branch_id, variant_id, quantity_delta, reason,
       ref_type, ref_id, note, created_by)
    values
      (p_org, p_branch, v_line.variant_id, v_line.quantity, 'return',
       'retail_order', p_order, 'إلغاء طلب ' || v_row.number, v_user);
  end loop;

  update public.retail_orders
     set status = 'cancelled', cancelled_at = now(), cancel_reason = p_reason
   where id = p_order;

  insert into public.audit_logs
    (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values
    (p_org, p_branch, v_user, 'retail.order.cancelled', 'retail_order',
     p_order::text, jsonb_build_object('reason', p_reason));
end;
$$;

-- ---------------------------------------------------------------------------
-- 12. Complete the order: this is where money starts existing.
--
-- Up to here nothing financial has happened, because nothing financial HAD
-- happened — the goods were committed, not paid for. Completion produces a
-- Core invoice, its lines, a payment and a treasury entry, through exactly the
-- tables the POS writes, so every existing report, the treasury screen and the
-- customer's document history keep working without knowing this order came
-- from the storefront.
--
-- Stock is NOT touched here. It left the shelf when the order was placed;
-- moving it again would double-count.
--
-- Note on wording: what the customer receives is a RECEIPT (إيصال), not an
-- Egyptian e-invoice. That distinction is the application's to present; this
-- function only records the transaction.
-- ---------------------------------------------------------------------------
create or replace function public.retail_order_complete(
  p_org     uuid,
  p_branch  uuid,
  p_order   uuid,
  p_method  text default 'cash',
  p_account uuid default null
)
returns table (out_invoice_id uuid, out_invoice_number text, out_total_cents bigint)
language plpgsql security definer set search_path = '' as $$
declare
  v_user    uuid := auth.uid();
  v_row     record;
  v_line    record;
  v_invoice uuid;
  v_number  text;
  v_account uuid;
  v_position int := 0;
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  -- Three privileges, because this is three things: closing an order, issuing
  -- a document, and taking money.
  if not app.has_branch_permission(p_org, p_branch, 'retail.order.manage') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if not app.has_branch_permission(p_org, p_branch, 'invoice.create') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if not app.has_branch_permission(p_org, p_branch, 'payment.create') then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  if p_method not in ('cash','card','transfer','wallet','online','other') then
    raise exception 'unknown payment method %', p_method using errcode = '22023';
  end if;

  select * into v_row from public.retail_orders
   where id = p_order and organization_id = p_org and branch_id = p_branch
   for update;
  if v_row.id is null then
    raise exception 'order not found' using errcode = 'check_violation';
  end if;
  if v_row.status <> 'fulfilled' then
    raise exception 'only a fulfilled order can be completed, this one is %', v_row.status
      using errcode = 'check_violation';
  end if;

  v_number := app.next_document_number(p_org, p_branch, 'invoice');

  insert into public.invoices
    (organization_id, branch_id, number, customer_id, status, source, currency,
     subtotal_cents, discount_cents, tax_cents, total_cents, notes, issued_at, created_by)
  values
    (p_org, p_branch, v_number, v_row.customer_id, 'draft', 'online', v_row.currency,
     0, 0, 0, 0, 'طلب أونلاين ' || v_row.number, now(), v_user)
  returning id into v_invoice;

  for v_line in
    select * from public.retail_order_items where order_id = p_order order by position
  loop
    v_position := v_position + 1;
    insert into public.invoice_items
      (invoice_id, organization_id, ref_type, ref_id, description, quantity,
       unit_price_cents, discount_cents, tax_rate_bp, total_cents, position)
    values
      (v_invoice, p_org, 'retail_variant', v_line.variant_id,
       v_line.product_name ||
         case when v_line.variant_name = 'default' then ''
              else ' — ' || v_line.variant_name end,
       v_line.quantity, v_line.unit_price_cents, 0, v_line.tax_rate_bp,
       v_line.line_total_cents + v_line.tax_total_cents, v_position);
  end loop;

  -- The delivery fee is a line too, so the receipt adds up to what was charged
  -- rather than carrying a silent difference.
  if v_row.delivery_fee_cents > 0 then
    v_position := v_position + 1;
    insert into public.invoice_items
      (invoice_id, organization_id, ref_type, description, quantity,
       unit_price_cents, discount_cents, tax_rate_bp, total_cents, position)
    values
      (v_invoice, p_org, 'delivery_fee', 'رسوم التوصيل', 1,
       v_row.delivery_fee_cents, 0, 0, v_row.delivery_fee_cents, v_position);
  end if;

  update public.invoices
     set subtotal_cents = v_row.subtotal_cents + v_row.delivery_fee_cents,
         tax_cents      = v_row.tax_cents,
         total_cents    = v_row.total_cents,
         status         = 'issued'
   where id = v_invoice;

  v_account := p_account;
  if v_account is null then
    select id into v_account from public.treasury_accounts
     where organization_id = p_org and branch_id = p_branch and is_default and is_active
     limit 1;
  end if;
  if v_account is not null and not exists (
    select 1 from public.treasury_accounts a
     where a.id = v_account and a.organization_id = p_org and a.branch_id = p_branch
  ) then
    raise exception 'treasury account does not belong to this branch'
      using errcode = 'check_violation';
  end if;

  insert into public.payments
    (organization_id, branch_id, invoice_id, customer_id, kind, method,
     amount_cents, currency, status, treasury_account_id, created_by)
  values
    (p_org, p_branch, v_invoice, v_row.customer_id, 'payment', p_method,
     v_row.total_cents, v_row.currency, 'completed', v_account, v_user);

  if v_account is not null then
    insert into public.treasury_transactions
      (organization_id, branch_id, account_id, direction, amount_cents, currency,
       category, reason, ref_type, ref_id, created_by)
    values
      (p_org, p_branch, v_account, 'in', v_row.total_cents, v_row.currency,
       'sale', 'طلب أونلاين ' || v_row.number, 'invoice', v_invoice, v_user);
  end if;

  update public.retail_orders
     set status = 'completed', completed_at = now(), invoice_id = v_invoice
   where id = p_order;

  insert into public.audit_logs
    (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values
    (p_org, p_branch, v_user, 'retail.order.completed', 'retail_order', p_order::text,
     jsonb_build_object('invoice_number', v_number, 'total_cents', v_row.total_cents));

  return query select v_invoice, v_number, v_row.total_cents;
end;
$$;

-- ---------------------------------------------------------------------------
-- 13. Grants.
--
-- PostgreSQL grants EXECUTE to PUBLIC on creation, so every revoke comes
-- before its grant — the lesson of 0028.
--
-- The storefront functions reach `anon` deliberately: they are the ONLY way an
-- anonymous visitor touches this schema, and each one is a narrow projection
-- gated on the store switch.
-- ---------------------------------------------------------------------------
do $$
declare fn text;
begin
  foreach fn in array array[
    'public.retail_store_context(text, text)',
    'public.retail_store_catalog(text, text, text)',
    'public.retail_price_cart(text, text, jsonb, text)',
    'public.retail_place_order(text, text, jsonb, text, text, text, text, text, text, text, text, text, text, text, text)',
    'public.retail_order_status(text)',
    'public.retail_order_lines(text)'
  ]
  loop
    execute format('revoke all on function %s from public', fn);
    execute format('grant execute on function %s to anon, authenticated', fn);
  end loop;

  foreach fn in array array[
    'public.retail_order_set_status(uuid, uuid, uuid, text)',
    'public.retail_order_cancel(uuid, uuid, uuid, text)',
    'public.retail_order_complete(uuid, uuid, uuid, text, uuid)'
  ]
  loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end $$;

revoke all on function app.retail_setting_bool(uuid, uuid, text, boolean)
  from public, anon, authenticated;
revoke all on function app.retail_setting_int(uuid, uuid, text, bigint)
  from public, anon, authenticated;
revoke all on function app.retail_store_enabled(uuid, uuid)
  from public, anon, authenticated;
revoke all on function app.retail_fulfillment_enabled(uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function app.check_retail_order_tenancy()      from public, anon, authenticated;
revoke all on function app.check_retail_order_item_tenancy() from public, anon, authenticated;
revoke all on function app.derive_retail_order_total()       from public, anon, authenticated;
revoke all on function app.derive_retail_order_line_total()  from public, anon, authenticated;
revoke all on function app.check_retail_order_transition()   from public, anon, authenticated;
-- The settings validator is a plain trigger that runs as whoever writes the
-- setting, and it only inspects its own input, so it needs no elevation — but
-- the writer must be able to execute it.
revoke all on function app.check_retail_setting() from public, anon;
grant execute on function app.check_retail_setting() to authenticated;
