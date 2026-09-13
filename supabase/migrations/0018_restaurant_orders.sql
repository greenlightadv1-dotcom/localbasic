-- =============================================================================
-- LOCAL BASIC — 0018 Restaurant orders
--
-- Orders carry price SNAPSHOTS. The menu changes constantly; what a guest was
-- charged must not. Every line records the product name, variant name, unit
-- price and each modifier's price as they were when the order was placed.
--
-- Money is settled through Core: paying an order creates a Core invoice, a
-- Core payment and a Core treasury entry. There is no restaurant-specific
-- invoice or payment table.
-- =============================================================================

create table public.restaurant_orders (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  branch_id        uuid not null references public.branches(id) on delete restrict,
  table_id         uuid references public.restaurant_tables(id) on delete set null,
  -- Human reference, unique per branch, from the Core document counter.
  number           text not null,
  -- How the order arrived. 'qr' orders are placed by an anonymous guest.
  channel          text not null default 'cashier'
                   check (channel in ('qr', 'cashier', 'waiter')),
  type             text not null default 'dine_in'
                   check (type in ('dine_in', 'takeaway')),
  status           text not null default 'new' check (status in (
    'new', 'confirmed', 'preparing', 'ready', 'served', 'completed', 'cancelled'
  )),
  -- Core customer when known; a QR guest usually supplies neither.
  customer_id      uuid references public.customers(id) on delete set null,
  guest_name       text,
  guest_phone      text,
  note             text,
  currency         char(3) not null,
  subtotal_cents   bigint not null default 0 check (subtotal_cents >= 0),
  discount_cents   bigint not null default 0 check (discount_cents >= 0),
  tax_cents        bigint not null default 0 check (tax_cents >= 0),
  total_cents      bigint not null default 0 check (total_cents >= 0),
  -- The Core invoice raised when the order is paid.
  invoice_id       uuid references public.invoices(id) on delete set null,
  placed_at        timestamptz not null default now(),
  confirmed_at     timestamptz,
  ready_at         timestamptz,
  served_at        timestamptz,
  completed_at     timestamptz,
  cancelled_at     timestamptz,
  cancel_reason    text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  -- Null for an anonymous QR order: nobody signed in placed it.
  created_by       uuid references public.profiles(id),
  unique (organization_id, branch_id, number),
  constraint restaurant_orders_cancel_reason
    check (cancelled_at is null or (status = 'cancelled' and cancel_reason is not null))
);
create index restaurant_orders_branch_status_idx
  on public.restaurant_orders(organization_id, branch_id, status, placed_at desc);
create index restaurant_orders_table_idx on public.restaurant_orders(table_id);
create index restaurant_orders_invoice_idx on public.restaurant_orders(invoice_id);
-- The kitchen queue: the hot path, so it gets its own partial index.
create index restaurant_orders_kitchen_idx
  on public.restaurant_orders(branch_id, placed_at)
  where status in ('confirmed', 'preparing');
create trigger restaurant_orders_touch before update on public.restaurant_orders
  for each row execute function app.touch_updated_at();

create table public.restaurant_order_items (
  id                uuid primary key default gen_random_uuid(),
  order_id          uuid not null references public.restaurant_orders(id) on delete cascade,
  organization_id   uuid not null references public.organizations(id) on delete cascade,
  variant_id        uuid references public.restaurant_variants(id) on delete set null,
  -- Snapshots: what the guest ordered and what they were charged, frozen.
  product_name      text not null,
  variant_name      text not null default 'default',
  quantity          numeric(10,3) not null check (quantity > 0),
  unit_price_cents  bigint not null check (unit_price_cents >= 0),
  modifiers_cents   bigint not null default 0 check (modifiers_cents >= 0),
  tax_rate_bp       int not null default 0 check (tax_rate_bp between 0 and 10000),
  line_total_cents  bigint not null check (line_total_cents >= 0),
  note              text,
  position          int not null default 0,
  created_at        timestamptz not null default now()
);
create index restaurant_order_items_order_idx on public.restaurant_order_items(order_id);
create index restaurant_order_items_variant_idx on public.restaurant_order_items(variant_id);

create table public.restaurant_order_item_modifiers (
  id               uuid primary key default gen_random_uuid(),
  order_item_id    uuid not null references public.restaurant_order_items(id) on delete cascade,
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  modifier_id      uuid references public.restaurant_modifiers(id) on delete set null,
  name             text not null,
  price_cents      bigint not null default 0 check (price_cents >= 0),
  created_at       timestamptz not null default now()
);
create index restaurant_order_item_modifiers_item_idx
  on public.restaurant_order_item_modifiers(order_item_id);

-- ---------------------------------------------------------------------------
-- Order state machine.
--
--   new       → confirmed | cancelled
--   confirmed → preparing | ready | cancelled
--   preparing → ready | cancelled
--   ready     → served | cancelled
--   served    → completed
--   completed → (terminal)
--   cancelled → (terminal)
--
-- `confirmed → ready` is allowed for counter service, where there is nothing
-- to prepare. Completion is reachable only from `served`, so an order cannot
-- be closed before it reached the guest. Both terminal states are final: a
-- mistake is corrected by a Core refund, never by reopening history.
--
-- Enforced by trigger, so an invalid transition is rejected no matter which
-- screen, action or future integration attempts it.
-- ---------------------------------------------------------------------------
create or replace function app.check_order_transition()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  allowed text[];
begin
  if new.status = old.status then
    return new;
  end if;

  allowed := case old.status
    when 'new'       then array['confirmed','cancelled']
    when 'confirmed' then array['preparing','ready','cancelled']
    when 'preparing' then array['ready','cancelled']
    when 'ready'     then array['served','cancelled']
    when 'served'    then array['completed']
    else array[]::text[]     -- completed and cancelled are final
  end;

  if not (new.status = any(allowed)) then
    raise exception 'invalid order transition % → %', old.status, new.status
      using errcode = 'check_violation';
  end if;

  -- Timestamps are set here rather than by callers, so the audit trail cannot
  -- disagree with the status.
  new.confirmed_at := case when new.status = 'confirmed' then now() else new.confirmed_at end;
  new.ready_at     := case when new.status = 'ready'     then now() else new.ready_at end;
  new.served_at    := case when new.status = 'served'    then now() else new.served_at end;
  new.completed_at := case when new.status = 'completed' then now() else new.completed_at end;
  new.cancelled_at := case when new.status = 'cancelled' then now() else new.cancelled_at end;

  return new;
end;
$$;

create trigger restaurant_orders_transition
  before update of status on public.restaurant_orders
  for each row execute function app.check_order_transition();

-- An order's table and branch must belong to its own organization.
create or replace function app.check_order_tenancy()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_branch_org uuid;
  v_table_branch uuid;
begin
  select organization_id into v_branch_org from public.branches where id = new.branch_id;
  if v_branch_org is distinct from new.organization_id then
    raise exception 'order branch does not belong to the organization'
      using errcode = 'check_violation';
  end if;

  if new.table_id is not null then
    select branch_id into v_table_branch
      from public.restaurant_tables where id = new.table_id;
    if v_table_branch is distinct from new.branch_id then
      raise exception 'table belongs to a different branch' using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

create trigger restaurant_orders_tenancy
  before insert or update on public.restaurant_orders
  for each row execute function app.check_order_tenancy();
