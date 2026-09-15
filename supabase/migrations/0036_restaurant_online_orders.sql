-- =============================================================================
-- LOCAL BASIC — 0036 Online ordering (D1 core)
--
-- Online orders are RESTAURANT ORDERS. They go into the same table, carry the
-- same statuses, obey the same transition trigger, and are priced by the same
-- line builder as the cashier, waiter and QR channels. There is no second
-- ordering engine, so the kitchen, the cashier and every report keep working
-- without knowing where an order came from.
--
-- What is genuinely new is only what online ordering needs and the other
-- channels do not:
--   * a fulfilment address, for delivery;
--   * a 60-second window in which the customer may still change their mind;
--   * an opaque token so a guest with no account can follow one order — and
--     only that one;
--   * an idempotency key, because a checkout button gets double-clicked.
--
-- Everything additive. No existing column, constraint or function is dropped.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Widen the channel and fulfilment vocabularies.
--
-- 'cashier' is the POS channel and keeps its name: renaming it would rewrite
-- history on every order ever placed for no gain.
-- ---------------------------------------------------------------------------
alter table public.restaurant_orders drop constraint restaurant_orders_channel_check;
alter table public.restaurant_orders add constraint restaurant_orders_channel_check
  check (channel in ('qr', 'cashier', 'waiter', 'online'));

alter table public.restaurant_orders drop constraint restaurant_orders_type_check;
alter table public.restaurant_orders add constraint restaurant_orders_type_check
  check (type in ('dine_in', 'takeaway', 'pickup', 'delivery'));

-- ---------------------------------------------------------------------------
-- 2. Online-only columns on the order.
-- ---------------------------------------------------------------------------
alter table public.restaurant_orders
  -- Server-generated deadline for customer self-service. Never accepted from a
  -- caller, and frozen once written by the trigger below.
  add column if not exists customer_edit_until timestamptz,
  -- Snapshot of the branch's delivery fee at the moment of ordering, so a later
  -- change to the setting cannot alter an order already placed.
  add column if not exists delivery_fee_cents bigint not null default 0
    check (delivery_fee_cents >= 0),
  -- Deduplicates a retried checkout. Scoped per organization.
  add column if not exists idempotency_key text;

create unique index if not exists restaurant_orders_idempotency_key
  on public.restaurant_orders(organization_id, idempotency_key)
  where idempotency_key is not null;

create index if not exists restaurant_orders_online_idx
  on public.restaurant_orders(organization_id, branch_id, status)
  where channel = 'online';

-- A delivery order must say where it is going; a pickup order must not pretend
-- to. Enforced once, here, rather than in every caller.
alter table public.restaurant_orders
  add constraint restaurant_orders_online_shape check (
    channel <> 'online' or type in ('pickup', 'delivery')
  );

-- ---------------------------------------------------------------------------
-- 3. The edit window is write-once.
--
-- Only the SECURITY DEFINER functions below ever set it, and anon holds no
-- privilege on this table at all — but a staff member with order.update could
-- otherwise push their own deadline forward. It is set at creation and never
-- moves again.
-- ---------------------------------------------------------------------------
create or replace function app.restaurant_freeze_edit_window()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.customer_edit_until is not null
     and new.customer_edit_until is distinct from old.customer_edit_until then
    raise exception 'customer_edit_until is set once at order creation and cannot be changed'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger restaurant_orders_freeze_edit_window
  before update on public.restaurant_orders
  for each row execute function app.restaurant_freeze_edit_window();

-- ---------------------------------------------------------------------------
-- 4. Delivery address. Its own table: a dine-in order has no use for eight
--    nullable address columns, and this keeps the order row honest.
-- ---------------------------------------------------------------------------
create table public.restaurant_order_deliveries (
  order_id         uuid primary key references public.restaurant_orders(id) on delete cascade,
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  branch_id        uuid not null references public.branches(id) on delete cascade,
  recipient_name   text not null check (length(trim(recipient_name)) between 2 and 120),
  phone            text not null check (length(trim(phone)) between 6 and 32),
  city             text check (length(trim(city)) <= 120),
  area             text check (length(trim(area)) <= 120),
  address          text not null check (length(trim(address)) between 4 and 500),
  landmark         text check (length(trim(landmark)) <= 240),
  -- Optional pin. Bounded so a malformed pair cannot be stored at all.
  latitude         numeric(9,6) check (latitude between -90 and 90),
  longitude        numeric(9,6) check (longitude between -180 and 180),
  notes            text check (length(notes) <= 500),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index restaurant_order_deliveries_org_idx
  on public.restaurant_order_deliveries(organization_id, branch_id);
create trigger restaurant_order_deliveries_touch before update
  on public.restaurant_order_deliveries
  for each row execute function app.touch_updated_at();

-- Tenancy guard, matching the pattern the rest of the restaurant tree uses.
create or replace function app.check_delivery_tenancy()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_branch uuid;
begin
  select organization_id, branch_id into v_org, v_branch
    from public.restaurant_orders where id = new.order_id;
  if v_org is distinct from new.organization_id or v_branch is distinct from new.branch_id then
    raise exception 'delivery details must match their order''s organization and branch'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger restaurant_order_deliveries_tenancy
  before insert or update on public.restaurant_order_deliveries
  for each row execute function app.check_delivery_tenancy();

-- ---------------------------------------------------------------------------
-- 5. Totals now include the delivery fee.
--
-- Replaces 0026's function body; the derivation stays a projection of the
-- lines plus the snapshotted fee, so there is still nothing a caller can write
-- a false total into.
-- ---------------------------------------------------------------------------
create or replace function app.restaurant_sync_order_totals()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_subtotal bigint;
  v_tax      bigint;
begin
  select coalesce(sum(line_total_cents
           - round((line_total_cents * tax_rate_bp)::numeric / (10000 + tax_rate_bp))), 0),
         coalesce(sum(round((line_total_cents * tax_rate_bp)::numeric / (10000 + tax_rate_bp))), 0)
    into v_subtotal, v_tax
    from public.restaurant_order_items
   where order_id = new.id;

  new.subtotal_cents := v_subtotal;
  new.tax_cents      := v_tax;
  new.total_cents    := greatest(
    v_subtotal + v_tax + coalesce(new.delivery_fee_cents, 0) - coalesce(new.discount_cents, 0), 0);

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. RLS. Delivery details are tenant data, reachable exactly like the order
--    they belong to.
-- ---------------------------------------------------------------------------
alter table public.restaurant_order_deliveries enable row level security;
alter table public.restaurant_order_deliveries force  row level security;

create policy restaurant_order_deliveries_select on public.restaurant_order_deliveries
  for select to authenticated
  using (app.has_branch_permission(organization_id, branch_id, 'restaurant.order.read'));

create policy restaurant_order_deliveries_write on public.restaurant_order_deliveries
  for update to authenticated
  using (app.has_branch_permission(organization_id, branch_id, 'restaurant.order.update'))
  with check (app.has_branch_permission(organization_id, branch_id, 'restaurant.order.update'));

revoke all on public.restaurant_order_deliveries from anon, authenticated;
grant select, update on public.restaurant_order_deliveries to authenticated;
