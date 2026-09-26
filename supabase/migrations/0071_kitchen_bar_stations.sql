-- =============================================================================
-- LOCAL BASIC — 0071 Kitchen/Bar station routing
--
-- A branch can have several prep stations — more than one kitchen, a bar, a
-- dessert station — each optionally wired to its own network thermal
-- printer. A product either names a station directly (an explicit override)
-- or falls back to its category's default_station_kind ('kitchen' or
-- 'bar'); an order item snapshots whichever station that resolved to at the
-- moment the order was placed, the same "snapshot, never re-derive" pattern
-- product_name/unit_price_cents already use on this table.
--
-- Stations are branch infrastructure, like sections and tables — RLS and
-- permissions here follow that table exactly (restaurant.table.read/manage),
-- rather than introducing a new permission for two more columns and a table.
-- =============================================================================

create table public.restaurant_stations (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  branch_id        uuid not null references public.branches(id) on delete cascade,
  name             text not null check (length(trim(name)) between 1 and 80),
  kind             text not null check (kind in ('kitchen', 'bar')),
  -- A network thermal printer's LAN address. Null means "no printer wired
  -- up yet" — the station still routes tickets on screen, it just has
  -- nothing to print to.
  printer_ip       text,
  printer_port     int not null default 9100 check (printer_port between 1 and 65535),
  is_active        boolean not null default true,
  sort_order       int not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid references public.profiles(id),
  unique (branch_id, name)
);
create index restaurant_stations_branch_idx
  on public.restaurant_stations(branch_id) where is_active;
create trigger restaurant_stations_touch before update on public.restaurant_stations
  for each row execute function app.touch_updated_at();

alter table public.restaurant_stations enable row level security;
alter table public.restaurant_stations force row level security;
revoke all on public.restaurant_stations from anon;

create policy stations_select on public.restaurant_stations for select to authenticated
  using (app.has_branch_permission(organization_id, branch_id, 'restaurant.table.read'));
create policy stations_write on public.restaurant_stations for all to authenticated
  using (app.has_branch_permission(organization_id, branch_id, 'restaurant.table.manage'))
  with check (app.has_branch_permission(organization_id, branch_id, 'restaurant.table.manage'));

grant select, insert, update, delete on public.restaurant_stations to authenticated;

-- ---------------------------------------------------------------------------
-- Auto-routing rule: a category's default, a product's optional override.
-- ---------------------------------------------------------------------------
alter table public.restaurant_categories
  add column if not exists default_station_kind text not null default 'kitchen'
    check (default_station_kind in ('kitchen', 'bar'));

alter table public.restaurant_products
  add column if not exists station_id uuid references public.restaurant_stations(id) on delete set null;

-- ---------------------------------------------------------------------------
-- The snapshot on the order line itself — resolved once, at order time, by
-- restaurant_build_order_lines() below. station_id is the concrete station
-- (for the kitchen board and for printer dispatch); station_kind is kept
-- even when no matching station row exists yet, so the board can still
-- group "food" apart from "drinks" before any station has been configured.
-- ---------------------------------------------------------------------------
alter table public.restaurant_order_items
  add column if not exists station_id uuid references public.restaurant_stations(id) on delete set null,
  add column if not exists station_kind text check (station_kind in ('kitchen', 'bar'));

-- ---------------------------------------------------------------------------
-- Manual cashier override, after the fact: reassign one order item to a
-- different station of the branch's choosing (e.g. auto-routing guessed
-- wrong, or a kitchen is overloaded and bar can plate a cold item).
-- ---------------------------------------------------------------------------
create or replace function public.restaurant_set_order_item_station(
  p_org        uuid,
  p_order_item uuid,
  p_station    uuid
)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_branch uuid;
  v_kind   text;
begin
  if not app.has_permission(p_org, 'restaurant.menu.manage') then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  select o.branch_id into v_branch
    from public.restaurant_order_items oi
    join public.restaurant_orders o on o.id = oi.order_id
   where oi.id = p_order_item and oi.organization_id = p_org;
  if v_branch is null then
    raise exception 'order item not found' using errcode = '22023';
  end if;

  select kind into v_kind
    from public.restaurant_stations
   where id = p_station and organization_id = p_org and branch_id = v_branch and is_active;
  if v_kind is null then
    raise exception 'unknown station for this branch' using errcode = '22023';
  end if;

  update public.restaurant_order_items
     set station_id = p_station, station_kind = v_kind
   where id = p_order_item and organization_id = p_org;
end;
$$;

revoke all on function public.restaurant_set_order_item_station(uuid, uuid, uuid) from public, anon;
grant execute on function public.restaurant_set_order_item_station(uuid, uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- restaurant_build_order_lines(), extended to resolve and snapshot a
-- station per line. Everything above the added block is unchanged from 0021.
-- ---------------------------------------------------------------------------
create or replace function app.restaurant_build_order_lines(
  p_org uuid, p_branch uuid, p_order uuid, p_items jsonb
) returns void language plpgsql security definer set search_path = '' as $$
declare
  v_item      jsonb;
  v_variant   record;
  v_qty       numeric(10,3);
  v_mod_ids   uuid[];
  v_mod       record;
  v_mods_sum  bigint;
  v_item_id   uuid;
  v_gross     bigint;
  v_tax       bigint;
  v_subtotal  bigint := 0;
  v_tax_total bigint := 0;
  v_position  int := 0;
  v_group     record;
  v_chosen    int;
  v_station_kind text;
  v_station_id   uuid;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'an order needs at least one item' using errcode = 'check_violation';
  end if;
  if jsonb_array_length(p_items) > 100 then
    raise exception 'too many items in one order' using errcode = 'check_violation';
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    select v.id, v.price_cents, v.name as variant_name, v.product_id,
           p.name as product_name, p.tax_rate_bp, p.station_id as product_station_id,
           coalesce(c.default_station_kind, 'kitchen') as category_station_kind
      into v_variant
      from public.restaurant_variants v
      join public.restaurant_products p on p.id = v.product_id
      left join public.restaurant_categories c on c.id = p.category_id
     where v.id = (v_item ->> 'variant_id')::uuid
       and v.organization_id = p_org
       and v.is_active and v.deleted_at is null
       and p.is_active and p.deleted_at is null;

    if v_variant.id is null then
      raise exception 'unknown or unavailable menu item' using errcode = 'check_violation';
    end if;

    -- Branch availability: absence of a row means available, so a branch only
    -- has to record what it has run out of.
    if exists (
      select 1 from public.restaurant_branch_availability a
      where a.branch_id = p_branch and a.variant_id = v_variant.id and not a.is_available
    ) then
      raise exception 'item is not available at this branch' using errcode = 'check_violation';
    end if;

    v_qty := coalesce((v_item ->> 'quantity')::numeric, 0);
    if v_qty <= 0 or v_qty > 999 then
      raise exception 'invalid quantity' using errcode = 'check_violation';
    end if;

    -- Modifiers must belong to this product, be active, and satisfy each
    -- group's min/max. The guest's UI enforces this too; this is the copy
    -- that counts.
    v_mod_ids := coalesce(
      (select array_agg((value #>> '{}')::uuid)
         from jsonb_array_elements(coalesce(v_item -> 'modifier_ids', '[]'::jsonb))),
      array[]::uuid[]);

    if array_length(v_mod_ids, 1) > 30 then
      raise exception 'too many modifiers on one item' using errcode = 'check_violation';
    end if;

    for v_group in
      select g.id, g.name, g.min_select, g.max_select
      from public.restaurant_modifier_groups g
      where g.product_id = v_variant.product_id and g.is_active
    loop
      select count(*) into v_chosen
      from public.restaurant_modifiers m
      where m.group_id = v_group.id and m.id = any(v_mod_ids);

      if v_chosen < v_group.min_select or v_chosen > v_group.max_select then
        raise exception 'invalid selection for group %', v_group.name
          using errcode = 'check_violation';
      end if;
    end loop;

    v_mods_sum := 0;
    v_position := v_position + 1;

    -- Route: an explicit product-level station always wins. Otherwise, the
    -- category's default kind picks the branch's own active station of
    -- that kind (lowest sort_order first); if none is configured yet,
    -- station_id stays null but station_kind is still recorded, so the
    -- board can group by kind before any station exists.
    if v_variant.product_station_id is not null then
      select id, kind into v_station_id, v_station_kind
        from public.restaurant_stations
       where id = v_variant.product_station_id and branch_id = p_branch and is_active;
    else
      v_station_id := null;
      v_station_kind := v_variant.category_station_kind;
    end if;

    if v_station_id is null then
      select id into v_station_id
        from public.restaurant_stations
       where branch_id = p_branch and kind = v_station_kind and is_active
       order by sort_order limit 1;
    end if;

    insert into public.restaurant_order_items
      (order_id, organization_id, variant_id, product_name, variant_name,
       quantity, unit_price_cents, modifiers_cents, tax_rate_bp, line_total_cents,
       note, position, station_id, station_kind)
    values
      (p_order, p_org, v_variant.id, v_variant.product_name, v_variant.variant_name,
       v_qty, v_variant.price_cents, 0, v_variant.tax_rate_bp, 0,
       nullif(trim(coalesce(v_item ->> 'note', '')), ''), v_position,
       v_station_id, v_station_kind)
    returning id into v_item_id;

    for v_mod in
      select m.id, m.name, m.price_cents
      from public.restaurant_modifiers m
      join public.restaurant_modifier_groups g on g.id = m.group_id
      where m.id = any(v_mod_ids)
        and g.product_id = v_variant.product_id
        and m.is_active and g.is_active
        and m.organization_id = p_org
    loop
      insert into public.restaurant_order_item_modifiers
        (order_item_id, organization_id, modifier_id, name, price_cents)
      values (v_item_id, p_org, v_mod.id, v_mod.name, v_mod.price_cents);
      v_mods_sum := v_mods_sum + v_mod.price_cents;
    end loop;

    -- Integer arithmetic; one rounding per line, and one for its tax.
    v_gross := round((v_variant.price_cents + v_mods_sum) * v_qty);
    v_tax   := round((v_gross * v_variant.tax_rate_bp)::numeric / 10000);

    update public.restaurant_order_items
       set modifiers_cents = v_mods_sum,
           line_total_cents = v_gross + v_tax
     where id = v_item_id;

    v_subtotal  := v_subtotal + v_gross;
    v_tax_total := v_tax_total + v_tax;
  end loop;

  update public.restaurant_orders
     set subtotal_cents = v_subtotal,
         tax_cents      = v_tax_total,
         total_cents    = v_subtotal - discount_cents + v_tax_total
   where id = p_order;
end;
$$;
