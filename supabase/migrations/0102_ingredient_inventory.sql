-- =============================================================================
-- 0102: raw-material inventory — recipes, a per-location ledger, automatic
-- consumption, warehouse → kitchen/bar custody, replenishment requests, waste,
-- and low-stock alarms.
--
-- Design: docs/RESTAURANT_INVENTORY_CONTROLS.md. The pattern is retail's
-- (0012/0052): an APPEND-ONLY movement ledger is the truth, and the balance
-- table is a projection written only by a trigger on it.
--
-- QUANTITIES are numeric(14,3) in each item's base unit: grams, millilitres or
-- pieces. The screens accept kg / L and convert before calling.
--
-- LOCATIONS, one of each per branch, created on first use:
--     warehouse   the store room                 (never negative)
--     kitchen     the kitchen's own stock        (may go negative: see below)
--     bar         the bar's own stock            (may go negative)
--     transit     issued, not yet confirmed      (never negative; no one's)
--     waste       the sink for helek (هالك)
-- A kitchen or bar balance may go below zero: book stock is a model, and
-- refusing to send a dish because the books are off by 20 g would stop
-- service. A negative balance is an alarm and a variance, never a block.
--
-- CONSUMPTION happens when an order is CONFIRMED (sent to its station), in the
-- same transaction as the status change: every recipe line × quantity leaves
-- the station the line was routed to. Cancelling before preparation starts
-- puts it back; cancelling after (preparing/ready/served) does not — the food
-- exists — and the loss is recorded as waste against the order.
--
-- CUSTODY: the warehouse issues → stock sits in TRANSIT → the kitchen or bar
-- confirms what it physically received, line by line, and only then does it
-- become theirs. The receiver must be a different person from the issuer.
-- A short receipt leaves the difference in transit as a dispute that needs a
-- manager (0103) to resolve.
--
-- ACCESS: every table has RLS forced. Staff READ through SELECT policies
-- (needed for the realtime alarms, like 0073); every WRITE goes through the
-- SECURITY DEFINER functions below. The movement ledger has no UPDATE or
-- DELETE path at all.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------------
insert into public.permissions (key, group_key, module_key, description, is_elevated) values
  ('inventory.read',     'inventory', 'restaurant', 'View raw-material stock, recipes and stock alarms', false),
  ('inventory.manage',   'inventory', 'restaurant', 'Manage raw materials, recipes and safety levels',  false),
  ('inventory.stock_in', 'inventory', 'restaurant', 'Receive purchased stock into the warehouse',        false),
  ('inventory.issue',    'inventory', 'restaurant', 'Issue stock from the warehouse to the kitchen or bar', false),
  ('inventory.receive',  'inventory', 'restaurant', 'Confirm receipt of issued stock at the kitchen or bar', false),
  ('inventory.request',  'inventory', 'restaurant', 'Request replenishment from the warehouse',          false),
  ('inventory.waste',    'inventory', 'restaurant', 'Record waste (helek)',                              false),
  ('inventory.adjust',   'inventory', 'restaurant', 'Manual stock adjustments and transfer disputes (manager approval)', true)
on conflict (key) do update
  set description = excluded.description, group_key = excluded.group_key, module_key = excluded.module_key;

-- ---------------------------------------------------------------------------
-- Items, locations, safety levels
-- ---------------------------------------------------------------------------
create table public.inventory_items (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  name             text not null check (length(trim(name)) between 1 and 120),
  unit             text not null check (unit in ('g', 'ml', 'pc')),
  -- Moving average cost per base unit (cents), maintained on stock-in.
  avg_cost_cents   numeric(14, 4) not null default 0 check (avg_cost_cents >= 0),
  is_active        boolean not null default true,
  created_by       uuid references auth.users(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create unique index inventory_items_name_uq on public.inventory_items(organization_id, lower(trim(name)));

create table public.inventory_locations (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  branch_id        uuid not null references public.branches(id) on delete cascade,
  kind             text not null check (kind in ('warehouse', 'kitchen', 'bar', 'transit', 'waste')),
  created_at       timestamptz not null default now(),
  unique (branch_id, kind)
);

create table public.inventory_par_levels (
  location_id      uuid not null references public.inventory_locations(id) on delete cascade,
  item_id          uuid not null references public.inventory_items(id) on delete cascade,
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  -- The alarm fires when the balance drops to or below this.
  min_qty          numeric(14, 3) not null check (min_qty >= 0),
  updated_by       uuid references auth.users(id),
  updated_at       timestamptz not null default now(),
  primary key (location_id, item_id)
);

-- ---------------------------------------------------------------------------
-- The ledger and its projection
-- ---------------------------------------------------------------------------
create table public.inventory_movements (
  id               bigint generated always as identity primary key,
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  branch_id        uuid not null references public.branches(id) on delete cascade,
  location_id      uuid not null references public.inventory_locations(id) on delete cascade,
  item_id          uuid not null references public.inventory_items(id) on delete cascade,
  qty              numeric(14, 3) not null check (qty <> 0),
  unit_cost_cents  numeric(14, 4) not null default 0,
  reason           text not null check (reason in (
                     'stock_in', 'issue', 'receive', 'transfer_cancel', 'dispute_found', 'dispute_lost',
                     'consumption', 'consumption_reversal', 'waste', 'adjustment')),
  doc_type         text,
  doc_id           uuid,
  -- For consumption: the order line it was used for.
  ref_line         uuid,
  note             text check (length(note) <= 300),
  actor_id         uuid,
  approved_by      uuid,
  created_at       timestamptz not null default now()
);
create index inventory_movements_loc_idx on public.inventory_movements(location_id, item_id, created_at desc);
create index inventory_movements_doc_idx on public.inventory_movements(doc_type, doc_id);
-- A line is consumed at most once, and given back at most once.
create unique index inventory_movements_consumed_uq
  on public.inventory_movements(ref_line, item_id) where reason = 'consumption';
create unique index inventory_movements_reversed_uq
  on public.inventory_movements(ref_line, item_id) where reason = 'consumption_reversal';

create table public.inventory_levels (
  location_id      uuid not null references public.inventory_locations(id) on delete cascade,
  item_id          uuid not null references public.inventory_items(id) on delete cascade,
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  branch_id        uuid not null references public.branches(id) on delete cascade,
  qty              numeric(14, 3) not null default 0,
  updated_at       timestamptz not null default now(),
  primary key (location_id, item_id)
);
create index inventory_levels_branch_idx on public.inventory_levels(branch_id);

create table public.inventory_alerts (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  branch_id        uuid not null references public.branches(id) on delete cascade,
  location_id      uuid not null references public.inventory_locations(id) on delete cascade,
  item_id          uuid not null references public.inventory_items(id) on delete cascade,
  kind             text not null check (kind in ('low', 'out')),
  qty              numeric(14, 3) not null,
  min_qty          numeric(14, 3) not null,
  opened_at        timestamptz not null default now(),
  resolved_at      timestamptz,
  acknowledged_by  uuid references auth.users(id),
  acknowledged_at  timestamptz
);
-- One open alarm per item per location: a busy night does not flood the screen.
create unique index inventory_alerts_open_uq on public.inventory_alerts(location_id, item_id) where resolved_at is null;
create index inventory_alerts_branch_idx on public.inventory_alerts(branch_id, resolved_at);

-- ---------------------------------------------------------------------------
-- Recipes
-- ---------------------------------------------------------------------------
create table public.restaurant_recipe_lines (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  variant_id       uuid not null references public.restaurant_variants(id) on delete cascade,
  item_id          uuid not null references public.inventory_items(id),
  -- Base units for ONE portion of this variant.
  qty              numeric(14, 3) not null check (qty > 0 and qty <= 100000),
  -- Where it comes from when not the line's own station (e.g. a garnish the bar keeps).
  location_kind    text check (location_kind in ('kitchen', 'bar')),
  updated_by       uuid references auth.users(id),
  updated_at       timestamptz not null default now(),
  unique (variant_id, item_id)
);
create index restaurant_recipe_lines_variant_idx on public.restaurant_recipe_lines(variant_id);

-- ---------------------------------------------------------------------------
-- Custody: transfers and replenishment requests
-- ---------------------------------------------------------------------------
create table public.inventory_requests (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  branch_id        uuid not null references public.branches(id) on delete cascade,
  location_id      uuid not null references public.inventory_locations(id),
  status           text not null default 'open' check (status in ('open', 'fulfilled', 'cancelled')),
  note             text check (length(note) <= 300),
  requested_by     uuid not null references auth.users(id),
  created_at       timestamptz not null default now(),
  closed_at        timestamptz,
  closed_by        uuid references auth.users(id)
);
create index inventory_requests_branch_idx on public.inventory_requests(branch_id, status);

create table public.inventory_request_lines (
  request_id       uuid not null references public.inventory_requests(id) on delete cascade,
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  item_id          uuid not null references public.inventory_items(id),
  qty              numeric(14, 3) not null check (qty > 0),
  primary key (request_id, item_id)
);

create table public.inventory_transfers (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  branch_id        uuid not null references public.branches(id) on delete cascade,
  number           text not null,
  from_location_id uuid not null references public.inventory_locations(id),
  to_location_id   uuid not null references public.inventory_locations(id),
  status           text not null check (status in ('issued', 'received', 'disputed', 'resolved', 'cancelled')),
  request_id       uuid references public.inventory_requests(id),
  note             text check (length(note) <= 300),
  issued_by        uuid not null references auth.users(id),
  issued_at        timestamptz not null default now(),
  received_by      uuid references auth.users(id),
  received_at      timestamptz,
  resolved_by      uuid references auth.users(id),
  resolved_at      timestamptz,
  resolution       text check (resolution in ('found', 'lost')),
  check (from_location_id <> to_location_id)
);
create index inventory_transfers_branch_idx on public.inventory_transfers(branch_id, status, issued_at desc);

create table public.inventory_transfer_lines (
  id               uuid primary key default gen_random_uuid(),
  transfer_id      uuid not null references public.inventory_transfers(id) on delete cascade,
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  item_id          uuid not null references public.inventory_items(id),
  issued_qty       numeric(14, 3) not null check (issued_qty > 0),
  received_qty     numeric(14, 3) check (received_qty >= 0),
  unique (transfer_id, item_id)
);

create table public.inventory_waste (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  branch_id        uuid not null references public.branches(id) on delete cascade,
  location_id      uuid not null references public.inventory_locations(id),
  item_id          uuid not null references public.inventory_items(id),
  qty              numeric(14, 3) not null check (qty > 0),
  cost_cents       numeric(14, 2) not null default 0,
  reason           text not null check (reason in (
                     'expired', 'spoiled', 'dropped', 'overcooked', 'returned_by_guest',
                     'staff_meal', 'order_cancelled', 'transit_loss', 'other')),
  note             text check (length(note) <= 300),
  order_id         uuid references public.restaurant_orders(id) on delete set null,
  recorded_by      uuid references auth.users(id),
  -- Whether this record moved stock itself (manual waste) or only documents
  -- food that had already been consumed (an order cancelled mid-preparation).
  moved_stock      boolean not null default true,
  created_at       timestamptz not null default now()
);
create index inventory_waste_branch_idx on public.inventory_waste(branch_id, created_at desc);

-- ---------------------------------------------------------------------------
-- RLS: forced everywhere; reads by policy, writes only via the functions.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'inventory_items', 'inventory_locations', 'inventory_par_levels', 'inventory_movements',
    'inventory_levels', 'inventory_alerts', 'restaurant_recipe_lines', 'inventory_requests',
    'inventory_request_lines', 'inventory_transfers', 'inventory_transfer_lines', 'inventory_waste'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;

-- Who may READ stock information: inventory staff and the kitchen/bar crews.
create or replace function app.inventory_can_read(p_org uuid, p_branch uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select case when p_branch is null then
           app.has_permission(p_org, 'inventory.read')
         else
           app.has_branch_permission(p_org, p_branch, 'inventory.read')
         end;
$$;

create policy inventory_items_select on public.inventory_items for select to authenticated
  using (app.inventory_can_read(organization_id, null));
create policy inventory_recipe_lines_select on public.restaurant_recipe_lines for select to authenticated
  using (app.inventory_can_read(organization_id, null));
create policy inventory_locations_select on public.inventory_locations for select to authenticated
  using (app.inventory_can_read(organization_id, branch_id));
create policy inventory_levels_select on public.inventory_levels for select to authenticated
  using (app.inventory_can_read(organization_id, branch_id));
create policy inventory_alerts_select on public.inventory_alerts for select to authenticated
  using (app.inventory_can_read(organization_id, branch_id));
create policy inventory_movements_select on public.inventory_movements for select to authenticated
  using (app.inventory_can_read(organization_id, branch_id));
create policy inventory_requests_select on public.inventory_requests for select to authenticated
  using (app.inventory_can_read(organization_id, branch_id));
create policy inventory_transfers_select on public.inventory_transfers for select to authenticated
  using (app.inventory_can_read(organization_id, branch_id));
create policy inventory_waste_select on public.inventory_waste for select to authenticated
  using (app.inventory_can_read(organization_id, branch_id));
create policy inventory_par_levels_select on public.inventory_par_levels for select to authenticated
  using (exists (select 1 from public.inventory_locations l
                  where l.id = location_id and app.inventory_can_read(l.organization_id, l.branch_id)));
create policy inventory_request_lines_select on public.inventory_request_lines for select to authenticated
  using (exists (select 1 from public.inventory_requests r
                  where r.id = request_id and app.inventory_can_read(r.organization_id, r.branch_id)));
-- Receiving is BLIND: the issued quantity is not shown to the receiving
-- station until the transfer has been received. Warehouse and managers
-- (inventory.issue / inventory.adjust) see it; the kitchen sees item names
-- through inventory_transfer_items() below until they have counted.
create policy inventory_transfer_lines_select on public.inventory_transfer_lines for select to authenticated
  using (exists (select 1 from public.inventory_transfers t
                  where t.id = transfer_id
                    and (app.has_branch_permission(t.organization_id, t.branch_id, 'inventory.issue')
                         or app.has_branch_permission(t.organization_id, t.branch_id, 'inventory.adjust')
                         or (t.status <> 'issued' and app.inventory_can_read(t.organization_id, t.branch_id)))));

-- Live alarms and requests reach staff screens through postgres_changes,
-- which delivers a row only to a subscriber whose own session can SELECT it.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.inventory_alerts;
    alter publication supabase_realtime add table public.inventory_requests;
    alter publication supabase_realtime add table public.inventory_transfers;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function app.inventory_location(p_org uuid, p_branch uuid, p_kind text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  select id into v_id from public.inventory_locations where branch_id = p_branch and kind = p_kind;
  if v_id is null then
    if not exists (select 1 from public.branches b where b.id = p_branch and b.organization_id = p_org) then
      raise exception 'الفرع غير موجود' using errcode = 'check_violation';
    end if;
    insert into public.inventory_locations (organization_id, branch_id, kind)
    values (p_org, p_branch, p_kind)
    on conflict (branch_id, kind) do nothing;
    select id into v_id from public.inventory_locations where branch_id = p_branch and kind = p_kind;
  end if;
  return v_id;
end;
$$;

-- Who may act ON a location. The kitchen crew acts on the kitchen, the bar on
-- the bar, the warehouse on the warehouse; managers (inventory.adjust) on all.
create or replace function app.inventory_can_act(p_org uuid, p_branch uuid, p_kind text)
returns boolean language sql stable security definer set search_path = '' as $$
  select app.has_branch_permission(p_org, p_branch, 'inventory.adjust')
      or case p_kind
           when 'kitchen'   then app.has_branch_permission(p_org, p_branch, 'restaurant.kitchen.use')
           when 'bar'       then app.has_branch_permission(p_org, p_branch, 'restaurant.bar.use')
           when 'warehouse' then app.has_branch_permission(p_org, p_branch, 'inventory.issue')
                              or app.has_branch_permission(p_org, p_branch, 'inventory.stock_in')
           else false
         end;
$$;

create or replace function app.inventory_require(p_org uuid, p_branch uuid, p_perm text)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not app.has_branch_permission(p_org, p_branch, p_perm) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
end;
$$;

-- An item must belong to the organization: an id from another store is "not found".
create or replace function app.inventory_item_check(p_org uuid, p_item uuid)
returns public.inventory_items language plpgsql stable security definer set search_path = '' as $$
declare v public.inventory_items%rowtype;
begin
  select * into v from public.inventory_items where id = p_item and organization_id = p_org;
  if v.id is null then
    raise exception 'الخامة غير موجودة' using errcode = 'check_violation';
  end if;
  return v;
end;
$$;

-- ---------------------------------------------------------------------------
-- The projection trigger: balance, never-negative rule, alarms.
-- ---------------------------------------------------------------------------
create or replace function app.inventory_apply_movement()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_kind text;
  v_qty  numeric(14, 3);
  v_min  numeric(14, 3);
  v_open public.inventory_alerts%rowtype;
begin
  select kind into v_kind from public.inventory_locations where id = new.location_id;

  insert into public.inventory_levels as l (location_id, item_id, organization_id, branch_id, qty, updated_at)
  values (new.location_id, new.item_id, new.organization_id, new.branch_id, new.qty, now())
  on conflict (location_id, item_id) do update set qty = l.qty + excluded.qty, updated_at = now()
  returning l.qty into v_qty;

  if v_kind in ('warehouse', 'transit') and v_qty < 0 then
    raise exception 'الرصيد غير كافٍ في المخزن' using errcode = 'check_violation';
  end if;

  -- Alarms: kitchen, bar and warehouse, against the location's safety level.
  if v_kind in ('warehouse', 'kitchen', 'bar') then
    select min_qty into v_min from public.inventory_par_levels
     where location_id = new.location_id and item_id = new.item_id;
    if v_min is not null then
      select * into v_open from public.inventory_alerts
       where location_id = new.location_id and item_id = new.item_id and resolved_at is null;
      if v_qty <= v_min then
        if v_open.id is null then
          insert into public.inventory_alerts (organization_id, branch_id, location_id, item_id, kind, qty, min_qty)
          values (new.organization_id, new.branch_id, new.location_id, new.item_id,
                  case when v_qty <= 0 then 'out' else 'low' end, v_qty, v_min);
        else
          -- Both ways: below zero is "out", back above zero but still under
          -- the level is "low" again.
          update public.inventory_alerts
             set qty = v_qty, kind = case when v_qty <= 0 then 'out' else 'low' end
           where id = v_open.id;
        end if;
      elsif v_open.id is not null then
        update public.inventory_alerts set resolved_at = now(), qty = v_qty where id = v_open.id;
      end if;
    end if;
  end if;
  return new;
end;
$$;

create trigger inventory_movements_apply
  after insert on public.inventory_movements
  for each row execute function app.inventory_apply_movement();

-- Append-only, even for the table owner's own functions. The one exception is
-- a cascade: deleting a whole organization (or branch) removes its ledger with
-- it, which is the only moment the parent rows are already gone.
create or replace function app.inventory_movements_immutable()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE'
     and (not exists (select 1 from public.inventory_locations where id = old.location_id)
          or not exists (select 1 from public.organizations where id = old.organization_id)) then
    return old;
  end if;
  raise exception 'inventory movements are append-only; record a correcting movement instead'
    using errcode = 'check_violation';
end;
$$;
create trigger inventory_movements_no_update before update or delete on public.inventory_movements
  for each row execute function app.inventory_movements_immutable();

create or replace function app.inventory_move(
  p_org uuid, p_branch uuid, p_location uuid, p_item uuid, p_qty numeric, p_reason text,
  p_doc_type text default null, p_doc_id uuid default null, p_note text default null,
  p_approved_by uuid default null, p_ref_line uuid default null
) returns void language plpgsql security definer set search_path = '' as $$
declare v_cost numeric(14, 4);
begin
  if p_qty = 0 then return; end if;
  select avg_cost_cents into v_cost from public.inventory_items where id = p_item;
  insert into public.inventory_movements
    (organization_id, branch_id, location_id, item_id, qty, unit_cost_cents, reason,
     doc_type, doc_id, ref_line, note, actor_id, approved_by)
  values (p_org, p_branch, p_location, p_item, p_qty, coalesce(v_cost, 0), p_reason,
          p_doc_type, p_doc_id, p_ref_line, p_note, auth.uid(), p_approved_by);
end;
$$;

-- ---------------------------------------------------------------------------
-- Consumption: confirm an order → each line's recipe leaves its station.
-- ---------------------------------------------------------------------------
create or replace function app.inventory_consume_line(p_line uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_line record;
  r      record;
  v_loc  uuid;
  v_cost numeric(14, 4);
begin
  select i.id, i.order_id, i.organization_id, i.variant_id, i.quantity, i.station_kind, o.branch_id
    into v_line
    from public.restaurant_order_items i
    join public.restaurant_orders o on o.id = i.order_id
   where i.id = p_line;
  if v_line.id is null or v_line.variant_id is null then
    return;
  end if;

  for r in
    select rl.item_id, rl.qty, coalesce(rl.location_kind, v_line.station_kind, 'kitchen') as kind
      from public.restaurant_recipe_lines rl
     where rl.variant_id = v_line.variant_id
  loop
    v_loc := app.inventory_location(v_line.organization_id, v_line.branch_id, r.kind);
    select avg_cost_cents into v_cost from public.inventory_items where id = r.item_id;
    insert into public.inventory_movements
      (organization_id, branch_id, location_id, item_id, qty, unit_cost_cents, reason,
       doc_type, doc_id, ref_line, actor_id)
    values (v_line.organization_id, v_line.branch_id, v_loc, r.item_id,
            -(r.qty * v_line.quantity), coalesce(v_cost, 0), 'consumption',
            'restaurant_order', v_line.order_id, v_line.id, auth.uid())
    on conflict (ref_line, item_id) where reason = 'consumption' do nothing;
  end loop;
end;
$$;

create or replace function app.inventory_on_order_status()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  r record;
  v_line uuid;
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  -- Sent to its station (or past it without having been consumed): consume.
  if new.status in ('confirmed', 'preparing', 'ready', 'served', 'completed')
     and old.status in ('new', 'pending_verification') then
    for v_line in select id from public.restaurant_order_items where order_id = new.id loop
      perform app.inventory_consume_line(v_line);
    end loop;

  -- Cancelled before preparation began: the ingredients go back.
  elsif new.status = 'cancelled' and old.status = 'confirmed' then
    for r in
      select m.* from public.inventory_movements m
       where m.doc_type = 'restaurant_order' and m.doc_id = new.id and m.reason = 'consumption'
    loop
      insert into public.inventory_movements
        (organization_id, branch_id, location_id, item_id, qty, unit_cost_cents, reason,
         doc_type, doc_id, ref_line, actor_id, note)
      values (r.organization_id, r.branch_id, r.location_id, r.item_id, -r.qty, r.unit_cost_cents,
              'consumption_reversal', 'restaurant_order', new.id, r.ref_line, auth.uid(), 'إلغاء قبل التحضير')
      on conflict (ref_line, item_id) where reason = 'consumption_reversal' do nothing;
    end loop;

  -- Cancelled after preparation began: the food exists. Nothing goes back;
  -- what was used is documented as waste against the order.
  elsif new.status = 'cancelled' and old.status in ('preparing', 'ready', 'served') then
    insert into public.inventory_waste
      (organization_id, branch_id, location_id, item_id, qty, cost_cents, reason, note, order_id,
       recorded_by, moved_stock)
    select m.organization_id, m.branch_id, m.location_id, m.item_id, sum(-m.qty),
           sum(-m.qty * m.unit_cost_cents), 'order_cancelled', left(new.cancel_reason, 300), new.id,
           auth.uid(), false
      from public.inventory_movements m
     where m.doc_type = 'restaurant_order' and m.doc_id = new.id and m.reason = 'consumption'
     group by m.organization_id, m.branch_id, m.location_id, m.item_id;
  end if;
  return new;
end;
$$;

create trigger restaurant_orders_inventory
  after update of status on public.restaurant_orders
  for each row execute function app.inventory_on_order_status();

-- A line added to an order that is already at its station is consumed at once.
create or replace function app.inventory_on_order_item()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.restaurant_orders o
              where o.id = new.order_id and o.status in ('confirmed', 'preparing', 'ready', 'served')) then
    perform app.inventory_consume_line(new.id);
  end if;
  return new;
end;
$$;
create trigger restaurant_order_items_inventory
  after insert on public.restaurant_order_items
  for each row execute function app.inventory_on_order_item();

-- ---------------------------------------------------------------------------
-- Master data: items, safety levels, recipes
-- ---------------------------------------------------------------------------
create or replace function public.inventory_item_save(
  p_org uuid, p_id uuid, p_name text, p_unit text, p_is_active boolean default true
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_name text := trim(coalesce(p_name, ''));
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_permission(p_org, 'inventory.manage') then raise exception 'not permitted' using errcode = '42501'; end if;
  if length(v_name) not between 1 and 120 then raise exception 'اسم الخامة مطلوب' using errcode = '22023'; end if;
  if p_unit not in ('g', 'ml', 'pc') then raise exception 'وحدة غير معروفة' using errcode = '22023'; end if;

  if p_id is null then
    begin
      insert into public.inventory_items (organization_id, name, unit, created_by)
      values (p_org, v_name, p_unit, auth.uid()) returning id into v_id;
    exception when unique_violation then
      raise exception 'توجد خامة بنفس الاسم' using errcode = '23505';
    end;
  else
    -- The unit is fixed once the item has moved: changing it would rescale history.
    if exists (select 1 from public.inventory_movements where item_id = p_id)
       and exists (select 1 from public.inventory_items where id = p_id and unit <> p_unit) then
      raise exception 'لا يمكن تغيير وحدة خامة لها حركات' using errcode = 'check_violation';
    end if;
    update public.inventory_items
       set name = v_name, unit = p_unit, is_active = coalesce(p_is_active, true), updated_at = now()
     where id = p_id and organization_id = p_org
    returning id into v_id;
    if v_id is null then raise exception 'الخامة غير موجودة' using errcode = 'check_violation'; end if;
  end if;

  insert into public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, auth.uid(), 'inventory.item.saved', 'inventory_item', v_id::text,
          jsonb_build_object('name', v_name, 'unit', p_unit, 'is_active', p_is_active));
  return v_id;
end;
$$;

create or replace function public.inventory_par_level_save(
  p_org uuid, p_branch uuid, p_kind text, p_item uuid, p_min_qty numeric
) returns void language plpgsql security definer set search_path = '' as $$
declare v_loc uuid; v_level numeric(14, 3);
begin
  perform app.inventory_require(p_org, p_branch, 'inventory.manage');
  perform app.inventory_item_check(p_org, p_item);
  if p_kind not in ('warehouse', 'kitchen', 'bar') then raise exception 'موقع غير معروف' using errcode = '22023'; end if;
  v_loc := app.inventory_location(p_org, p_branch, p_kind);

  if p_min_qty is null then
    delete from public.inventory_par_levels where location_id = v_loc and item_id = p_item;
    update public.inventory_alerts set resolved_at = now()
     where location_id = v_loc and item_id = p_item and resolved_at is null;
  else
    if p_min_qty < 0 then raise exception 'الحد الأدنى غير صالح' using errcode = '22023'; end if;
    insert into public.inventory_par_levels (location_id, item_id, organization_id, min_qty, updated_by, updated_at)
    values (v_loc, p_item, p_org, p_min_qty, auth.uid(), now())
    on conflict (location_id, item_id) do update set min_qty = excluded.min_qty, updated_by = excluded.updated_by, updated_at = now();

    -- Re-evaluate against the current balance straight away.
    select qty into v_level from public.inventory_levels where location_id = v_loc and item_id = p_item;
    v_level := coalesce(v_level, 0);
    if v_level <= p_min_qty then
      insert into public.inventory_alerts (organization_id, branch_id, location_id, item_id, kind, qty, min_qty)
      values (p_org, p_branch, v_loc, p_item, case when v_level <= 0 then 'out' else 'low' end, v_level, p_min_qty)
      on conflict (location_id, item_id) where resolved_at is null
        do update set min_qty = excluded.min_qty, qty = excluded.qty, kind = excluded.kind;
    else
      update public.inventory_alerts set resolved_at = now()
       where location_id = v_loc and item_id = p_item and resolved_at is null;
    end if;
  end if;
end;
$$;

-- Replaces a variant's whole recipe. Audited with before and after, so a
-- quietly shrunk recipe is a dated, named change.
create or replace function public.restaurant_recipe_save(
  p_org uuid, p_variant uuid, p_lines jsonb
) returns void language plpgsql security definer set search_path = '' as $$
declare
  v_before jsonb;
  v_line   jsonb;
  v_kind   text;
  v_n      int := 0;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_permission(p_org, 'inventory.manage') then raise exception 'not permitted' using errcode = '42501'; end if;
  if not exists (select 1 from public.restaurant_variants v join public.restaurant_products p on p.id = v.product_id
                  where v.id = p_variant and p.organization_id = p_org) then
    raise exception 'الصنف غير موجود' using errcode = 'check_violation';
  end if;
  if jsonb_typeof(coalesce(p_lines, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_lines, '[]'::jsonb)) > 60 then
    raise exception 'مكونات الوصفة غير صالحة' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('item_id', item_id, 'qty', qty, 'location_kind', location_kind) order by item_id), '[]'::jsonb)
    into v_before from public.restaurant_recipe_lines where variant_id = p_variant;

  delete from public.restaurant_recipe_lines where variant_id = p_variant;
  for v_line in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    perform app.inventory_item_check(p_org, (v_line ->> 'item_id')::uuid);
    v_kind := nullif(v_line ->> 'location_kind', '');
    if v_kind is not null and v_kind not in ('kitchen', 'bar') then
      raise exception 'مكان الصرف غير صالح' using errcode = '22023';
    end if;
    if (v_line ->> 'qty')::numeric <= 0 then
      raise exception 'الكمية يجب أن تكون أكبر من صفر' using errcode = '22023';
    end if;
    insert into public.restaurant_recipe_lines (organization_id, variant_id, item_id, qty, location_kind, updated_by)
    values (p_org, p_variant, (v_line ->> 'item_id')::uuid, (v_line ->> 'qty')::numeric, v_kind, auth.uid());
    v_n := v_n + 1;
  end loop;

  insert into public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, before, after)
  values (p_org, auth.uid(), 'inventory.recipe.saved', 'restaurant_variant', p_variant::text, v_before,
          (select coalesce(jsonb_agg(jsonb_build_object('item_id', item_id, 'qty', qty, 'location_kind', location_kind) order by item_id), '[]'::jsonb)
             from public.restaurant_recipe_lines where variant_id = p_variant));
end;
$$;

-- ---------------------------------------------------------------------------
-- Stock in (purchases into the warehouse), with moving-average cost.
-- ---------------------------------------------------------------------------
create or replace function public.inventory_stock_in(
  p_org uuid, p_branch uuid, p_lines jsonb, p_note text default null
) returns void language plpgsql security definer set search_path = '' as $$
declare
  v_loc  uuid;
  v_line jsonb;
  v_item public.inventory_items%rowtype;
  v_qty  numeric(14, 3);
  v_cost numeric(14, 4);
  v_on_hand numeric;
  v_doc  uuid := gen_random_uuid();
begin
  perform app.inventory_require(p_org, p_branch, 'inventory.stock_in');
  if jsonb_typeof(coalesce(p_lines, 'null')) <> 'array' or jsonb_array_length(p_lines) = 0 or jsonb_array_length(p_lines) > 100 then
    raise exception 'أضف خامة واحدة على الأقل' using errcode = '22023';
  end if;
  v_loc := app.inventory_location(p_org, p_branch, 'warehouse');

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_item := app.inventory_item_check(p_org, (v_line ->> 'item_id')::uuid);
    v_qty  := (v_line ->> 'qty')::numeric;
    v_cost := coalesce((v_line ->> 'unit_cost_cents')::numeric, v_item.avg_cost_cents);
    if v_qty is null or v_qty <= 0 or v_qty > 100000000 then
      raise exception 'الكمية غير صالحة' using errcode = '22023';
    end if;
    if v_cost < 0 then raise exception 'التكلفة غير صالحة' using errcode = '22023'; end if;

    select coalesce(sum(greatest(qty, 0)), 0) into v_on_hand
      from public.inventory_levels where item_id = v_item.id;
    update public.inventory_items
       set avg_cost_cents = case when v_on_hand + v_qty > 0
                                 then (v_on_hand * avg_cost_cents + v_qty * v_cost) / (v_on_hand + v_qty)
                                 else v_cost end,
           updated_at = now()
     where id = v_item.id;

    insert into public.inventory_movements
      (organization_id, branch_id, location_id, item_id, qty, unit_cost_cents, reason, doc_type, doc_id, note, actor_id)
    values (p_org, p_branch, v_loc, v_item.id, v_qty, v_cost, 'stock_in', 'stock_in', v_doc, left(p_note, 300), auth.uid());
  end loop;

  insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, p_branch, auth.uid(), 'inventory.stock_in', 'stock_in', v_doc::text,
          jsonb_build_object('lines', p_lines, 'note', p_note));
end;
$$;

-- ---------------------------------------------------------------------------
-- Replenishment requests (kitchen / bar → warehouse)
-- ---------------------------------------------------------------------------
create or replace function public.inventory_request_create(
  p_org uuid, p_branch uuid, p_kind text, p_lines jsonb, p_note text default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_line jsonb; v_loc uuid;
begin
  perform app.inventory_require(p_org, p_branch, 'inventory.request');
  if p_kind not in ('kitchen', 'bar') or not app.inventory_can_act(p_org, p_branch, p_kind) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if jsonb_typeof(coalesce(p_lines, 'null')) <> 'array' or jsonb_array_length(p_lines) = 0 or jsonb_array_length(p_lines) > 60 then
    raise exception 'أضف خامة واحدة على الأقل' using errcode = '22023';
  end if;
  v_loc := app.inventory_location(p_org, p_branch, p_kind);
  insert into public.inventory_requests (organization_id, branch_id, location_id, note, requested_by)
  values (p_org, p_branch, v_loc, left(nullif(trim(p_note), ''), 300), auth.uid()) returning id into v_id;
  for v_line in select * from jsonb_array_elements(p_lines) loop
    perform app.inventory_item_check(p_org, (v_line ->> 'item_id')::uuid);
    if (v_line ->> 'qty')::numeric <= 0 then raise exception 'الكمية غير صالحة' using errcode = '22023'; end if;
    insert into public.inventory_request_lines (request_id, organization_id, item_id, qty)
    values (v_id, p_org, (v_line ->> 'item_id')::uuid, (v_line ->> 'qty')::numeric);
  end loop;
  insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, p_branch, auth.uid(), 'inventory.request.created', 'inventory_request', v_id::text,
          jsonb_build_object('kind', p_kind, 'lines', p_lines));
  return v_id;
end;
$$;

create or replace function public.inventory_request_cancel(p_org uuid, p_request uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v record;
begin
  select r.*, l.kind into v from public.inventory_requests r join public.inventory_locations l on l.id = r.location_id
   where r.id = p_request and r.organization_id = p_org;
  if v.id is null then raise exception 'الطلب غير موجود' using errcode = 'check_violation'; end if;
  if not (v.requested_by = auth.uid() or app.has_branch_permission(p_org, v.branch_id, 'inventory.issue')
          or app.has_branch_permission(p_org, v.branch_id, 'inventory.adjust')) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v.status <> 'open' then raise exception 'الطلب مغلق بالفعل' using errcode = 'check_violation'; end if;
  update public.inventory_requests set status = 'cancelled', closed_at = now(), closed_by = auth.uid() where id = p_request;
end;
$$;

-- ---------------------------------------------------------------------------
-- Issue (warehouse → transit), receive (transit → station), cancel.
-- ---------------------------------------------------------------------------
create or replace function public.inventory_issue(
  p_org uuid, p_branch uuid, p_to_kind text, p_lines jsonb,
  p_request uuid default null, p_note text default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id     uuid;
  v_from   uuid;
  v_transit uuid;
  v_to     uuid;
  v_line   jsonb;
  v_item   uuid;
  v_qty    numeric(14, 3);
begin
  perform app.inventory_require(p_org, p_branch, 'inventory.issue');
  if p_to_kind not in ('kitchen', 'bar') then raise exception 'جهة الصرف غير صالحة' using errcode = '22023'; end if;
  if jsonb_typeof(coalesce(p_lines, 'null')) <> 'array' or jsonb_array_length(p_lines) = 0 or jsonb_array_length(p_lines) > 100 then
    raise exception 'أضف خامة واحدة على الأقل' using errcode = '22023';
  end if;
  v_from    := app.inventory_location(p_org, p_branch, 'warehouse');
  v_transit := app.inventory_location(p_org, p_branch, 'transit');
  v_to      := app.inventory_location(p_org, p_branch, p_to_kind);

  if p_request is not null and not exists (
       select 1 from public.inventory_requests
        where id = p_request and organization_id = p_org and branch_id = p_branch
          and location_id = v_to and status = 'open') then
    raise exception 'طلب الصرف غير موجود أو مغلق' using errcode = 'check_violation';
  end if;

  insert into public.inventory_transfers
    (organization_id, branch_id, number, from_location_id, to_location_id, status, request_id, note, issued_by)
  values (p_org, p_branch, 'ISS-' || app.next_document_number(p_org, p_branch, 'inventory_issue'),
          v_from, v_to, 'issued', p_request, left(nullif(trim(p_note), ''), 300), auth.uid())
  returning id into v_id;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_item := (v_line ->> 'item_id')::uuid;
    v_qty  := (v_line ->> 'qty')::numeric;
    perform app.inventory_item_check(p_org, v_item);
    if v_qty is null or v_qty <= 0 then raise exception 'الكمية غير صالحة' using errcode = '22023'; end if;
    insert into public.inventory_transfer_lines (transfer_id, organization_id, item_id, issued_qty) values (v_id, p_org, v_item, v_qty);
    perform app.inventory_move(p_org, p_branch, v_from,    v_item, -v_qty, 'issue', 'inventory_transfer', v_id);
    perform app.inventory_move(p_org, p_branch, v_transit, v_item,  v_qty, 'issue', 'inventory_transfer', v_id);
  end loop;

  if p_request is not null then
    update public.inventory_requests set status = 'fulfilled', closed_at = now(), closed_by = auth.uid()
     where id = p_request;
  end if;

  insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, p_branch, auth.uid(), 'inventory.transfer.issued', 'inventory_transfer', v_id::text,
          jsonb_build_object('to', p_to_kind, 'lines', p_lines, 'request_id', p_request));
  return v_id;
end;
$$;

-- What the receiving station sees while counting: names and units only.
create or replace function public.inventory_transfer_items(p_org uuid, p_transfer uuid)
returns table (out_line_id uuid, out_item_id uuid, out_name text, out_unit text)
language plpgsql stable security definer set search_path = '' as $$
declare v record;
begin
  select t.*, l.kind as to_kind into v from public.inventory_transfers t
    join public.inventory_locations l on l.id = t.to_location_id
   where t.id = p_transfer and t.organization_id = p_org;
  if v.id is null or not app.inventory_can_read(p_org, v.branch_id) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  return query
    select tl.id, i.id, i.name, i.unit
      from public.inventory_transfer_lines tl join public.inventory_items i on i.id = tl.item_id
     where tl.transfer_id = p_transfer order by i.name;
end;
$$;

-- The receiving department confirms what it physically has. p_lines:
-- [{ "line_id": ..., "received_qty": ... }] — every line, counted blind.
create or replace function public.inventory_receive(p_org uuid, p_transfer uuid, p_lines jsonb)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v        record;
  v_line   record;
  v_given  numeric(14, 3);
  v_transit uuid;
  v_short  boolean := false;
  v_n      int;
begin
  select t.*, l.kind as to_kind into v from public.inventory_transfers t
    join public.inventory_locations l on l.id = t.to_location_id
   where t.id = p_transfer and t.organization_id = p_org
   for update of t;
  if v.id is null then raise exception 'التحويل غير موجود' using errcode = 'check_violation'; end if;
  perform app.inventory_require(p_org, v.branch_id, 'inventory.receive');
  if not app.inventory_can_act(p_org, v.branch_id, v.to_kind) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v.status <> 'issued' then raise exception 'تم استلام هذا التحويل بالفعل' using errcode = 'check_violation'; end if;
  -- Two people: whoever issued it cannot also accept it.
  if v.issued_by = auth.uid() then
    raise exception 'لا يمكن لنفس الشخص الصرف والاستلام' using errcode = '42501';
  end if;

  select count(*) into v_n from public.inventory_transfer_lines where transfer_id = p_transfer;
  if jsonb_typeof(coalesce(p_lines, 'null')) <> 'array' or jsonb_array_length(p_lines) <> v_n then
    raise exception 'أدخل الكمية المستلمة لكل خامة' using errcode = '22023';
  end if;

  v_transit := app.inventory_location(p_org, v.branch_id, 'transit');
  for v_line in select * from public.inventory_transfer_lines where transfer_id = p_transfer for update loop
    select (e ->> 'received_qty')::numeric into v_given
      from jsonb_array_elements(p_lines) e where (e ->> 'line_id')::uuid = v_line.id;
    if v_given is null or v_given < 0 then
      raise exception 'أدخل الكمية المستلمة لكل خامة' using errcode = '22023';
    end if;
    if v_given > v_line.issued_qty then
      raise exception 'الكمية المستلمة أكبر من المصروفة — راجع المخزن' using errcode = 'check_violation';
    end if;
    update public.inventory_transfer_lines set received_qty = v_given where id = v_line.id;
    if v_given > 0 then
      perform app.inventory_move(p_org, v.branch_id, v_transit,        v_line.item_id, -v_given, 'receive', 'inventory_transfer', p_transfer);
      perform app.inventory_move(p_org, v.branch_id, v.to_location_id, v_line.item_id,  v_given, 'receive', 'inventory_transfer', p_transfer);
    end if;
    if v_given < v_line.issued_qty then v_short := true; end if;
  end loop;

  update public.inventory_transfers
     set status = case when v_short then 'disputed' else 'received' end,
         received_by = auth.uid(), received_at = now()
   where id = p_transfer;

  insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, v.branch_id, auth.uid(),
          case when v_short then 'inventory.transfer.disputed' else 'inventory.transfer.received' end,
          'inventory_transfer', p_transfer::text, jsonb_build_object('lines', p_lines));
  return case when v_short then 'disputed' else 'received' end;
end;
$$;

-- An issue nobody has accepted yet can be pulled back by its issuer or a manager.
create or replace function public.inventory_transfer_cancel(p_org uuid, p_transfer uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v record; v_line record; v_transit uuid;
begin
  select * into v from public.inventory_transfers where id = p_transfer and organization_id = p_org for update;
  if v.id is null then raise exception 'التحويل غير موجود' using errcode = 'check_violation'; end if;
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not ((v.issued_by = auth.uid() and app.has_branch_permission(p_org, v.branch_id, 'inventory.issue'))
          or app.has_branch_permission(p_org, v.branch_id, 'inventory.adjust')) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v.status <> 'issued' then raise exception 'لا يمكن إلغاء تحويل تم استلامه' using errcode = 'check_violation'; end if;
  v_transit := app.inventory_location(p_org, v.branch_id, 'transit');
  for v_line in select * from public.inventory_transfer_lines where transfer_id = p_transfer loop
    perform app.inventory_move(p_org, v.branch_id, v_transit,          v_line.item_id, -v_line.issued_qty, 'transfer_cancel', 'inventory_transfer', p_transfer);
    perform app.inventory_move(p_org, v.branch_id, v.from_location_id, v_line.item_id,  v_line.issued_qty, 'transfer_cancel', 'inventory_transfer', p_transfer);
  end loop;
  update public.inventory_transfers set status = 'cancelled', resolved_by = auth.uid(), resolved_at = now() where id = p_transfer;
  insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id)
  values (p_org, v.branch_id, auth.uid(), 'inventory.transfer.cancelled', 'inventory_transfer', p_transfer::text);
end;
$$;

-- ---------------------------------------------------------------------------
-- Waste (helek), recorded by the location that owns the stock.
-- ---------------------------------------------------------------------------
create or replace function public.inventory_record_waste(
  p_org uuid, p_branch uuid, p_kind text, p_item uuid, p_qty numeric, p_reason text, p_note text default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_loc   uuid;
  v_sink  uuid;
  v_item  public.inventory_items%rowtype;
  v_id    uuid;
begin
  perform app.inventory_require(p_org, p_branch, 'inventory.waste');
  if p_kind not in ('warehouse', 'kitchen', 'bar') or not app.inventory_can_act(p_org, p_branch, p_kind) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  v_item := app.inventory_item_check(p_org, p_item);
  if p_qty is null or p_qty <= 0 or p_qty > 100000000 then raise exception 'الكمية غير صالحة' using errcode = '22023'; end if;
  if p_reason not in ('expired', 'spoiled', 'dropped', 'overcooked', 'returned_by_guest', 'staff_meal', 'other') then
    raise exception 'سبب الهالك غير معروف' using errcode = '22023';
  end if;
  if p_reason = 'other' and nullif(trim(coalesce(p_note, '')), '') is null then
    raise exception 'اكتب سبب الهالك' using errcode = '22023';
  end if;

  v_loc  := app.inventory_location(p_org, p_branch, p_kind);
  v_sink := app.inventory_location(p_org, p_branch, 'waste');
  insert into public.inventory_waste (organization_id, branch_id, location_id, item_id, qty, cost_cents, reason, note, recorded_by)
  values (p_org, p_branch, v_loc, p_item, p_qty, p_qty * v_item.avg_cost_cents, p_reason, left(nullif(trim(p_note), ''), 300), auth.uid())
  returning id into v_id;
  perform app.inventory_move(p_org, p_branch, v_loc,  p_item, -p_qty, 'waste', 'inventory_waste', v_id, left(p_note, 300));
  perform app.inventory_move(p_org, p_branch, v_sink, p_item,  p_qty, 'waste', 'inventory_waste', v_id);

  insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, p_branch, auth.uid(), 'inventory.waste.recorded', 'inventory_waste', v_id::text,
          jsonb_build_object('kind', p_kind, 'item_id', p_item, 'qty', p_qty, 'reason', p_reason));
  return v_id;
end;
$$;

-- Acknowledging an alarm silences it on screens; it stays open until restocked.
create or replace function public.inventory_alert_ack(p_org uuid, p_alert uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v record;
begin
  select a.*, l.kind into v from public.inventory_alerts a join public.inventory_locations l on l.id = a.location_id
   where a.id = p_alert and a.organization_id = p_org;
  if v.id is null then raise exception 'التنبيه غير موجود' using errcode = 'check_violation'; end if;
  if auth.uid() is null or not (app.inventory_can_act(p_org, v.branch_id, v.kind)) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  update public.inventory_alerts set acknowledged_by = auth.uid(), acknowledged_at = now() where id = p_alert;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'app.inventory_can_read(uuid, uuid)', 'app.inventory_location(uuid, uuid, text)',
    'app.inventory_can_act(uuid, uuid, text)', 'app.inventory_require(uuid, uuid, text)',
    'app.inventory_item_check(uuid, uuid)', 'app.inventory_apply_movement()',
    'app.inventory_movements_immutable()',
    'app.inventory_move(uuid, uuid, uuid, uuid, numeric, text, text, uuid, text, uuid, uuid)',
    'app.inventory_consume_line(uuid)', 'app.inventory_on_order_status()', 'app.inventory_on_order_item()'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
  end loop;
  -- Policies call inventory_can_read as the reading user.
  grant execute on function app.inventory_can_read(uuid, uuid) to authenticated;
  foreach f in array array[
    'app.inventory_location(uuid, uuid, text)', 'app.inventory_can_act(uuid, uuid, text)',
    'app.inventory_require(uuid, uuid, text)', 'app.inventory_item_check(uuid, uuid)',
    'app.inventory_move(uuid, uuid, uuid, uuid, numeric, text, text, uuid, text, uuid, uuid)',
    'app.inventory_consume_line(uuid)'
  ] loop
    execute format('revoke execute on function %s from authenticated', f);
  end loop;

  foreach f in array array[
    'public.inventory_item_save(uuid, uuid, text, text, boolean)',
    'public.inventory_par_level_save(uuid, uuid, text, uuid, numeric)',
    'public.restaurant_recipe_save(uuid, uuid, jsonb)',
    'public.inventory_stock_in(uuid, uuid, jsonb, text)',
    'public.inventory_request_create(uuid, uuid, text, jsonb, text)',
    'public.inventory_request_cancel(uuid, uuid)',
    'public.inventory_issue(uuid, uuid, text, jsonb, uuid, text)',
    'public.inventory_transfer_items(uuid, uuid)',
    'public.inventory_receive(uuid, uuid, jsonb)',
    'public.inventory_transfer_cancel(uuid, uuid)',
    'public.inventory_record_waste(uuid, uuid, text, uuid, numeric, text, text)',
    'public.inventory_alert_ack(uuid, uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
