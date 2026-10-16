-- =============================================================================
-- LOCAL BASIC — recipe costing (BOM), wastage, automated purchasing, menu engineering
-- =============================================================================
-- BUILT ON 0102, NOT BESIDE IT. Recipes, the stock ledger, automatic BOM
-- deduction (when an order is confirmed to its station, reversed or written
-- off per line on cancel — 0102/0105), waste and minimum levels already
-- exist. A second recipe or waste table would be a second truth and could
-- deduct stock twice, so the Phase 4 names are READ VIEWS over the real tables
-- (security_invoker: the base tables' RLS applies to whoever reads):
--
--   restaurant_recipe_items          → restaurant_recipe_lines (+ unit, cost)
--   restaurant_wastage_logs          → inventory_waste (+ location, unit)
--   restaurant_inventory_thresholds  → inventory_par_levels (+ reorder_qty, on hand)
--
-- NEW HERE
--   * inventory.purchase permission (storekeeper, manager, admin, owners).
--   * Waste reasons 'burnt' and 'tasting'.
--   * inventory_par_levels.reorder_qty: how much to buy when an item hits its
--     minimum (null = refill to twice the minimum).
--   * restaurant_suppliers, inventory_items.preferred_supplier_id.
--   * restaurant_purchase_orders / restaurant_purchase_order_items:
--     draft → sent → received (or cancelled). restaurant_po_generate() turns
--     every warehouse item at or below its minimum — and not already covered
--     by an open order — into draft orders, one per preferred supplier.
--     Receiving books the stock in through inventory_stock_in (moving-average
--     cost) in the same transaction.
--   * restaurant_recipe_costs(): each menu variant's cost from its recipe at
--     current average costs.
--   * restaurant_menu_engineering(): units sold, revenue and unit cost per
--     variant over a period (completed orders), for the matrix.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Permission
-- ---------------------------------------------------------------------------
insert into public.permissions (key, group_key, module_key, description, is_elevated) values
  ('inventory.purchase', 'inventory', 'restaurant', 'Create, send and receive purchase orders; manage suppliers', false)
on conflict (key) do update
  set description = excluded.description, group_key = excluded.group_key, module_key = excluded.module_key;

insert into public.role_permissions (role_id, permission_key)
select r.id, 'inventory.purchase'
  from public.roles r
 where r.organization_id is null and r.key in ('storekeeper', 'manager', 'admin')
   and (r.module_key is null or r.module_key = 'restaurant')
on conflict do nothing;

insert into public.role_permissions (role_id, permission_key)
select org_role.id, tp.permission_key
  from public.roles org_role
  join public.roles tpl on tpl.organization_id is null and tpl.is_system and tpl.key = org_role.key
                       and tpl.module_key is not distinct from org_role.module_key
  join public.role_permissions tp on tp.role_id = tpl.id
 where org_role.organization_id is not null and tp.permission_key = 'inventory.purchase'
on conflict do nothing;

insert into public.role_permissions (role_id, permission_key)
select r.id, p.key from public.roles r cross join public.permissions p
 where r.is_owner and r.organization_id is not null
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Waste reasons
-- ---------------------------------------------------------------------------
alter table public.inventory_waste drop constraint inventory_waste_reason_check;
alter table public.inventory_waste add constraint inventory_waste_reason_check check (reason in (
  'expired', 'spoiled', 'burnt', 'dropped', 'tasting', 'overcooked', 'returned_by_guest',
  'staff_meal', 'order_cancelled', 'transit_loss', 'other'));

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
  if p_reason not in ('expired', 'spoiled', 'burnt', 'dropped', 'tasting', 'overcooked', 'returned_by_guest', 'staff_meal', 'other') then
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

-- ---------------------------------------------------------------------------
-- Thresholds: a reorder quantity next to the minimum
-- ---------------------------------------------------------------------------
alter table public.inventory_par_levels
  add column reorder_qty numeric(14, 3) check (reorder_qty is null or (reorder_qty > 0 and reorder_qty <= 100000000));

create or replace function public.inventory_threshold_save(
  p_org uuid, p_branch uuid, p_kind text, p_item uuid, p_min_qty numeric, p_reorder_qty numeric
) returns void language plpgsql security definer set search_path = '' as $$
declare v_loc uuid;
begin
  -- The minimum (and its alarm) through the 0102 function, which checks inventory.manage.
  perform public.inventory_par_level_save(p_org, p_branch, p_kind, p_item, p_min_qty);
  if p_min_qty is null then return; end if;
  if p_reorder_qty is not null and (p_reorder_qty <= 0 or p_reorder_qty > 100000000) then
    raise exception 'كمية إعادة الطلب غير صالحة' using errcode = '22023';
  end if;
  v_loc := app.inventory_location(p_org, p_branch, p_kind);
  update public.inventory_par_levels set reorder_qty = p_reorder_qty where location_id = v_loc and item_id = p_item;
end;
$$;

-- ---------------------------------------------------------------------------
-- Suppliers and purchase orders
-- ---------------------------------------------------------------------------
create table public.restaurant_suppliers (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  name             text not null check (length(trim(name)) between 1 and 160),
  phone            text check (length(phone) <= 30),
  notes            text check (length(notes) <= 500),
  is_active        boolean not null default true,
  created_by       uuid references auth.users(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create unique index restaurant_suppliers_name_uq on public.restaurant_suppliers(organization_id, lower(trim(name)));

alter table public.inventory_items
  add column preferred_supplier_id uuid references public.restaurant_suppliers(id) on delete set null;

create table public.restaurant_purchase_orders (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  branch_id        uuid not null references public.branches(id) on delete cascade,
  number           text not null,
  supplier_id      uuid references public.restaurant_suppliers(id) on delete set null,
  status           text not null default 'draft' check (status in ('draft', 'sent', 'received', 'cancelled')),
  auto_generated   boolean not null default false,
  note             text check (length(note) <= 500),
  expected_on      date,
  created_by       uuid references auth.users(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  sent_at          timestamptz,
  sent_by          uuid references auth.users(id),
  received_at      timestamptz,
  received_by      uuid references auth.users(id),
  cancelled_at     timestamptz,
  cancelled_by     uuid references auth.users(id),
  unique (branch_id, number)
);
create index restaurant_purchase_orders_branch_idx on public.restaurant_purchase_orders(branch_id, status, created_at desc);

create table public.restaurant_purchase_order_items (
  id                        uuid primary key default gen_random_uuid(),
  purchase_order_id         uuid not null references public.restaurant_purchase_orders(id) on delete cascade,
  organization_id           uuid not null references public.organizations(id) on delete cascade,
  item_id                   uuid not null references public.inventory_items(id),
  qty_ordered               numeric(14, 3) not null check (qty_ordered > 0 and qty_ordered <= 100000000),
  -- Expected cost per base unit when ordered (the item's average cost, editable).
  unit_cost_cents           numeric(14, 4) not null default 0 check (unit_cost_cents >= 0),
  qty_received              numeric(14, 3) check (qty_received >= 0),
  received_unit_cost_cents  numeric(14, 4) check (received_unit_cost_cents >= 0),
  unique (purchase_order_id, item_id)
);
create index restaurant_purchase_order_items_item_idx on public.restaurant_purchase_order_items(item_id);

do $$
declare t text;
begin
  foreach t in array array['restaurant_suppliers', 'restaurant_purchase_orders', 'restaurant_purchase_order_items'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
  -- The 0108 risk tables: read-only for staff, as their policies already intend.
  foreach t in array array['restaurant_cashier_risk_profiles', 'restaurant_cashier_risk_logs'] loop
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;

create policy restaurant_suppliers_select on public.restaurant_suppliers for select to authenticated
  using (app.has_permission(organization_id, 'inventory.read') or app.has_permission(organization_id, 'inventory.purchase'));
create policy restaurant_purchase_orders_select on public.restaurant_purchase_orders for select to authenticated
  using (app.inventory_can_read(organization_id, branch_id) or app.has_branch_permission(organization_id, branch_id, 'inventory.purchase'));
create policy restaurant_purchase_order_items_select on public.restaurant_purchase_order_items for select to authenticated
  using (exists (select 1 from public.restaurant_purchase_orders po where po.id = purchase_order_id));

-- ---------------------------------------------------------------------------
-- Phase 4 read views over the 0102 tables
-- ---------------------------------------------------------------------------
create view public.restaurant_recipe_items with (security_invoker = true) as
  select rl.id, rl.organization_id, v.product_id, rl.variant_id, rl.item_id as inventory_item_id,
         rl.qty as quantity, ii.unit, rl.location_kind,
         ii.avg_cost_cents as unit_cost_cents, round(rl.qty * ii.avg_cost_cents, 4) as line_cost_cents,
         rl.updated_at
    from public.restaurant_recipe_lines rl
    join public.inventory_items ii on ii.id = rl.item_id
    join public.restaurant_variants v on v.id = rl.variant_id;

create view public.restaurant_wastage_logs with (security_invoker = true) as
  select w.id, w.organization_id, w.branch_id, l.kind as location_kind, w.item_id as inventory_item_id,
         w.qty as quantity, ii.unit, w.cost_cents, w.reason, w.note, w.order_id, w.moved_stock,
         w.recorded_by, w.created_at
    from public.inventory_waste w
    join public.inventory_locations l on l.id = w.location_id
    join public.inventory_items ii on ii.id = w.item_id;

create view public.restaurant_inventory_thresholds with (security_invoker = true) as
  select p.location_id, l.branch_id, p.organization_id, l.kind as location_kind, p.item_id as inventory_item_id,
         p.min_qty as min_stock_qty, p.reorder_qty, coalesce(lv.qty, 0) as on_hand_qty,
         coalesce(lv.qty, 0) <= p.min_qty as below_min, p.updated_at
    from public.inventory_par_levels p
    join public.inventory_locations l on l.id = p.location_id
    left join public.inventory_levels lv on lv.location_id = p.location_id and lv.item_id = p.item_id;

revoke all on public.restaurant_recipe_items, public.restaurant_wastage_logs, public.restaurant_inventory_thresholds
  from public, anon, authenticated;
grant select on public.restaurant_recipe_items, public.restaurant_wastage_logs, public.restaurant_inventory_thresholds
  to authenticated;

-- ---------------------------------------------------------------------------
-- Reorder suggestions and automatic purchase orders
-- ---------------------------------------------------------------------------
-- Warehouse items at or below their minimum, less what open orders already
-- bring. Suggested = the reorder quantity, or (no reorder quantity) enough to
-- reach twice the minimum.
create or replace function app.reorder_suggestions(p_org uuid, p_branch uuid)
returns table (out_item_id uuid, out_name text, out_unit text, out_on_hand numeric, out_min numeric, out_reorder numeric,
               out_open_po numeric, out_suggested numeric, out_supplier_id uuid, out_unit_cost numeric)
language sql stable security definer set search_path = '' as $$
  with wh as (select id from public.inventory_locations where branch_id = p_branch and kind = 'warehouse'),
  open_po as (
    select poi.item_id, sum(poi.qty_ordered) as qty
      from public.restaurant_purchase_order_items poi
      join public.restaurant_purchase_orders po on po.id = poi.purchase_order_id
     where po.branch_id = p_branch and po.status in ('draft', 'sent')
     group by poi.item_id
  ), base as (
    select ii.id, ii.name, ii.unit, coalesce(lv.qty, 0) as on_hand, p.min_qty, p.reorder_qty,
           coalesce(op.qty, 0) as open_qty, ii.preferred_supplier_id, ii.avg_cost_cents
      from public.inventory_par_levels p
      join wh on wh.id = p.location_id
      join public.inventory_items ii on ii.id = p.item_id and ii.organization_id = p_org and ii.is_active
      left join public.inventory_levels lv on lv.location_id = p.location_id and lv.item_id = p.item_id
      left join open_po op on op.item_id = ii.id
  )
  select id, name, unit, on_hand, min_qty, reorder_qty, open_qty,
         case when reorder_qty is not null then reorder_qty
              else greatest(2 * min_qty - on_hand - open_qty, 0) end as suggested,
         preferred_supplier_id, avg_cost_cents
    from base
   where on_hand <= min_qty and on_hand + open_qty <= min_qty
     and (reorder_qty is not null or 2 * min_qty - on_hand - open_qty > 0)
   order by name;
$$;

create or replace function public.restaurant_reorder_suggestions(p_org uuid, p_branch uuid)
returns table (out_item_id uuid, out_name text, out_unit text, out_on_hand numeric, out_min numeric, out_reorder numeric,
               out_open_po numeric, out_suggested numeric, out_supplier_id uuid, out_unit_cost numeric)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not (app.inventory_can_read(p_org, p_branch) or app.has_branch_permission(p_org, p_branch, 'inventory.purchase')) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  return query select * from app.reorder_suggestions(p_org, p_branch);
end;
$$;

-- One draft order per preferred supplier (and one for items with none).
create or replace function public.restaurant_po_generate(p_org uuid, p_branch uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_sup    record;
  v_po     uuid;
  v_number text;
  v_out    jsonb := '[]'::jsonb;
  v_lines  int;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_branch_permission(p_org, p_branch, 'inventory.purchase') then raise exception 'not permitted' using errcode = '42501'; end if;
  if not exists (select 1 from public.branches where id = p_branch and organization_id = p_org) then
    raise exception 'الفرع غير موجود' using errcode = 'check_violation';
  end if;
  -- Two managers pressing the button at once must not order everything twice.
  perform pg_advisory_xact_lock(hashtextextended('po_generate:' || p_branch::text, 0));

  for v_sup in select distinct out_supplier_id as supplier_id from app.reorder_suggestions(p_org, p_branch) loop
    v_number := 'PO-' || app.next_document_number(p_org, p_branch, 'purchase_order');
    insert into public.restaurant_purchase_orders (organization_id, branch_id, number, supplier_id, status, auto_generated, note, created_by)
    values (p_org, p_branch, v_number, v_sup.supplier_id, 'draft', true, 'طلب شراء تلقائي — خامات وصلت للحد الأدنى', auth.uid())
    returning id into v_po;
    insert into public.restaurant_purchase_order_items (purchase_order_id, organization_id, item_id, qty_ordered, unit_cost_cents)
    select v_po, p_org, s.out_item_id, s.out_suggested, s.out_unit_cost
      from app.reorder_suggestions(p_org, p_branch) s
     where s.out_supplier_id is not distinct from v_sup.supplier_id;
    get diagnostics v_lines = row_count;
    v_out := v_out || jsonb_build_object('id', v_po, 'number', v_number, 'supplier_id', v_sup.supplier_id, 'lines', v_lines);
  end loop;

  if jsonb_array_length(v_out) > 0 then
    insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
    values (p_org, p_branch, auth.uid(), 'inventory.po.generated', 'branch', p_branch::text, jsonb_build_object('orders', v_out));
  end if;
  return jsonb_build_object('count', jsonb_array_length(v_out), 'orders', v_out);
end;
$$;

-- Create or edit a draft: supplier, note, expected date and the full line list.
create or replace function public.restaurant_po_save(
  p_org uuid, p_branch uuid, p_po uuid, p_supplier uuid, p_note text, p_expected date, p_lines jsonb
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_po   public.restaurant_purchase_orders%rowtype;
  v_id   uuid;
  v_line jsonb;
  v_item public.inventory_items%rowtype;
  v_qty  numeric;
  v_cost numeric;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_branch_permission(p_org, p_branch, 'inventory.purchase') then raise exception 'not permitted' using errcode = '42501'; end if;
  if p_supplier is not null and not exists (select 1 from public.restaurant_suppliers where id = p_supplier and organization_id = p_org) then
    raise exception 'المورد غير موجود' using errcode = 'check_violation';
  end if;
  if jsonb_typeof(coalesce(p_lines, 'null')) <> 'array' or jsonb_array_length(p_lines) = 0 or jsonb_array_length(p_lines) > 200 then
    raise exception 'أضف خامة واحدة على الأقل' using errcode = '22023';
  end if;

  if p_po is null then
    insert into public.restaurant_purchase_orders (organization_id, branch_id, number, supplier_id, note, expected_on, created_by)
    values (p_org, p_branch, 'PO-' || app.next_document_number(p_org, p_branch, 'purchase_order'), p_supplier,
            left(nullif(trim(p_note), ''), 500), p_expected, auth.uid())
    returning id into v_id;
  else
    select * into v_po from public.restaurant_purchase_orders where id = p_po and organization_id = p_org and branch_id = p_branch for update;
    if v_po.id is null then raise exception 'طلب الشراء غير موجود' using errcode = 'check_violation'; end if;
    if v_po.status <> 'draft' then raise exception 'لا يُعدَّل إلا طلب شراء مسودة' using errcode = 'check_violation'; end if;
    update public.restaurant_purchase_orders
       set supplier_id = p_supplier, note = left(nullif(trim(p_note), ''), 500), expected_on = p_expected, updated_at = now()
     where id = p_po;
    delete from public.restaurant_purchase_order_items where purchase_order_id = p_po;
    v_id := p_po;
  end if;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_item := app.inventory_item_check(p_org, (v_line ->> 'item_id')::uuid);
    v_qty  := (v_line ->> 'qty')::numeric;
    v_cost := coalesce((v_line ->> 'unit_cost_cents')::numeric, v_item.avg_cost_cents);
    if v_qty is null or v_qty <= 0 or v_qty > 100000000 then raise exception 'الكمية غير صالحة' using errcode = '22023'; end if;
    if v_cost < 0 then raise exception 'التكلفة غير صالحة' using errcode = '22023'; end if;
    begin
      insert into public.restaurant_purchase_order_items (purchase_order_id, organization_id, item_id, qty_ordered, unit_cost_cents)
      values (v_id, p_org, v_item.id, v_qty, v_cost);
    exception when unique_violation then
      raise exception 'الخامة مكررة في الطلب: %', v_item.name using errcode = '22023';
    end;
  end loop;

  insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, p_branch, auth.uid(), 'inventory.po.saved', 'restaurant_purchase_order', v_id::text,
          jsonb_build_object('supplier', p_supplier, 'lines', p_lines));
  return v_id;
end;
$$;

create or replace function public.restaurant_po_set_status(p_org uuid, p_po uuid, p_status text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_po public.restaurant_purchase_orders%rowtype;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into v_po from public.restaurant_purchase_orders where id = p_po and organization_id = p_org for update;
  if v_po.id is null then raise exception 'طلب الشراء غير موجود' using errcode = 'check_violation'; end if;
  if not app.has_branch_permission(p_org, v_po.branch_id, 'inventory.purchase') then raise exception 'not permitted' using errcode = '42501'; end if;
  if p_status = 'sent' and v_po.status = 'draft' then
    update public.restaurant_purchase_orders set status = 'sent', sent_at = now(), sent_by = auth.uid(), updated_at = now() where id = p_po;
  elsif p_status = 'cancelled' and v_po.status in ('draft', 'sent') then
    update public.restaurant_purchase_orders set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(), updated_at = now() where id = p_po;
  else
    raise exception 'لا يمكن نقل طلب الشراء من % إلى %', v_po.status, p_status using errcode = 'check_violation';
  end if;
  insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, v_po.branch_id, auth.uid(), 'inventory.po.' || p_status, 'restaurant_purchase_order', p_po::text,
          jsonb_build_object('from', v_po.status));
end;
$$;

-- Receive what actually arrived (any line may be short or zero; prices as invoiced).
-- The stock goes into the warehouse through inventory_stock_in, so the moving
-- average cost and the ledger follow the same path as any purchase.
create or replace function public.restaurant_po_receive(p_org uuid, p_po uuid, p_lines jsonb, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_po    public.restaurant_purchase_orders%rowtype;
  v_line  jsonb;
  v_poi   public.restaurant_purchase_order_items%rowtype;
  v_qty   numeric;
  v_cost  numeric;
  v_stock jsonb := '[]'::jsonb;
  v_total numeric := 0;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into v_po from public.restaurant_purchase_orders where id = p_po and organization_id = p_org for update;
  if v_po.id is null then raise exception 'طلب الشراء غير موجود' using errcode = 'check_violation'; end if;
  if not (app.has_branch_permission(p_org, v_po.branch_id, 'inventory.purchase')
          and app.has_branch_permission(p_org, v_po.branch_id, 'inventory.stock_in')) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_po.status not in ('draft', 'sent') then raise exception 'طلب الشراء ليس مفتوحًا' using errcode = 'check_violation'; end if;
  if jsonb_typeof(coalesce(p_lines, 'null')) <> 'array' then raise exception 'بيانات الاستلام غير صالحة' using errcode = '22023'; end if;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    select * into v_poi from public.restaurant_purchase_order_items
     where purchase_order_id = p_po and item_id = (v_line ->> 'item_id')::uuid;
    if v_poi.id is null then raise exception 'خامة ليست في طلب الشراء' using errcode = 'check_violation'; end if;
    v_qty  := coalesce((v_line ->> 'qty')::numeric, 0);
    v_cost := coalesce((v_line ->> 'unit_cost_cents')::numeric, v_poi.unit_cost_cents);
    if v_qty < 0 or v_qty > 100000000 or v_cost < 0 then raise exception 'الكمية أو التكلفة غير صالحة' using errcode = '22023'; end if;
    update public.restaurant_purchase_order_items set qty_received = v_qty, received_unit_cost_cents = v_cost where id = v_poi.id;
    if v_qty > 0 then
      v_stock := v_stock || jsonb_build_object('item_id', v_poi.item_id, 'qty', v_qty, 'unit_cost_cents', v_cost);
      v_total := v_total + v_qty * v_cost;
    end if;
  end loop;
  -- Lines not mentioned arrived as nothing.
  update public.restaurant_purchase_order_items set qty_received = 0
   where purchase_order_id = p_po and qty_received is null;

  if jsonb_array_length(v_stock) = 0 then raise exception 'لم يُستلم أي شيء — ألغِ الطلب بدلًا من ذلك' using errcode = '22023'; end if;
  perform public.inventory_stock_in(p_org, v_po.branch_id, v_stock, left(coalesce(nullif(trim(p_note), ''), 'استلام ' || v_po.number), 300));

  update public.restaurant_purchase_orders
     set status = 'received', received_at = now(), received_by = auth.uid(), updated_at = now()
   where id = p_po;
  insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, v_po.branch_id, auth.uid(), 'inventory.po.received', 'restaurant_purchase_order', p_po::text,
          jsonb_build_object('lines', v_stock, 'total_cents', round(v_total)));
  return jsonb_build_object('lines', jsonb_array_length(v_stock), 'total_cents', round(v_total));
end;
$$;

create or replace function public.restaurant_supplier_save(
  p_org uuid, p_id uuid, p_name text, p_phone text, p_notes text, p_active boolean default true
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_permission(p_org, 'inventory.purchase') then raise exception 'not permitted' using errcode = '42501'; end if;
  if length(trim(coalesce(p_name, ''))) not between 1 and 160 then raise exception 'اسم المورد مطلوب' using errcode = '22023'; end if;
  begin
    if p_id is null then
      insert into public.restaurant_suppliers (organization_id, name, phone, notes, is_active, created_by)
      values (p_org, trim(p_name), nullif(trim(p_phone), ''), nullif(trim(p_notes), ''), coalesce(p_active, true), auth.uid())
      returning id into v_id;
    else
      update public.restaurant_suppliers
         set name = trim(p_name), phone = nullif(trim(p_phone), ''), notes = nullif(trim(p_notes), ''),
             is_active = coalesce(p_active, true), updated_at = now()
       where id = p_id and organization_id = p_org
      returning id into v_id;
      if v_id is null then raise exception 'المورد غير موجود' using errcode = 'check_violation'; end if;
    end if;
  exception when unique_violation then
    raise exception 'يوجد مورد بنفس الاسم' using errcode = '23505';
  end;
  insert into public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, auth.uid(), 'inventory.supplier.saved', 'restaurant_supplier', v_id::text, jsonb_build_object('name', trim(p_name)));
  return v_id;
end;
$$;

create or replace function public.inventory_item_set_supplier(p_org uuid, p_item uuid, p_supplier uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not (app.has_permission(p_org, 'inventory.purchase') or app.has_permission(p_org, 'inventory.manage')) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  perform app.inventory_item_check(p_org, p_item);
  if p_supplier is not null and not exists (select 1 from public.restaurant_suppliers where id = p_supplier and organization_id = p_org) then
    raise exception 'المورد غير موجود' using errcode = 'check_violation';
  end if;
  update public.inventory_items set preferred_supplier_id = p_supplier, updated_at = now() where id = p_item;
end;
$$;

-- ---------------------------------------------------------------------------
-- Recipe costing and menu engineering
-- ---------------------------------------------------------------------------
-- Every active menu variant with its recipe cost at today's average costs.
-- missing_cost: a recipe line uses an item that has never been costed.
create or replace function public.restaurant_recipe_costs(p_org uuid)
returns table (out_variant_id uuid, out_product_id uuid, out_product_name text, out_variant_name text, out_category_name text,
               out_price_cents bigint, out_cost_cents numeric, out_line_count int, out_missing_cost boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not (app.has_permission(p_org, 'inventory.read') or app.has_permission(p_org, 'report.read')) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  return query
  select v.id, p.id, p.name, v.name, c.name, v.price_cents::bigint,
         coalesce(sum(rl.qty * ii.avg_cost_cents), 0)::numeric,
         count(rl.id)::int,
         coalesce(bool_or(ii.avg_cost_cents = 0), false)
    from public.restaurant_variants v
    join public.restaurant_products p on p.id = v.product_id and p.organization_id = p_org and p.deleted_at is null
    left join public.restaurant_categories c on c.id = p.category_id
    left join public.restaurant_recipe_lines rl on rl.variant_id = v.id
    left join public.inventory_items ii on ii.id = rl.item_id
   where v.organization_id = p_org and p.is_active and v.is_active and v.deleted_at is null
   group by v.id, p.id, p.name, v.name, c.name, v.price_cents
   order by c.name nulls last, p.name, v.name;
end;
$$;

-- Units sold and revenue per variant on completed orders in [from, to), with
-- the current recipe cost per unit. Revenue is menu price × quantity (before
-- order-level discounts and tax): the matrix compares dishes, not checks.
create or replace function public.restaurant_menu_engineering(p_org uuid, p_branch uuid, p_from timestamptz, p_to timestamptz)
returns table (out_variant_id uuid, out_product_name text, out_variant_name text, out_category_name text,
               out_qty_sold numeric, out_revenue_cents bigint, out_unit_cost_cents numeric, out_has_recipe boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if p_branch is null then
    if not app.has_permission(p_org, 'report.read') then raise exception 'not permitted' using errcode = '42501'; end if;
  elsif not app.has_branch_permission(p_org, p_branch, 'report.read') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > interval '400 days' then
    raise exception 'الفترة غير صالحة' using errcode = '22023';
  end if;
  return query
  with sold as (
    select i.variant_id, max(i.product_name) as product_name, max(i.variant_name) as variant_name,
           sum(i.quantity) as qty, sum(round((i.unit_price_cents + i.modifiers_cents) * i.quantity))::bigint as revenue
      from public.restaurant_order_items i
      join public.restaurant_orders o on o.id = i.order_id
     where o.organization_id = p_org and o.status = 'completed'
       and o.completed_at >= p_from and o.completed_at < p_to
       and (p_branch is null or o.branch_id = p_branch)
       and i.variant_id is not null
     group by i.variant_id
  ), cost as (
    select rl.variant_id, sum(rl.qty * ii.avg_cost_cents) as unit_cost
      from public.restaurant_recipe_lines rl join public.inventory_items ii on ii.id = rl.item_id
     where rl.organization_id = p_org
     group by rl.variant_id
  )
  select s.variant_id, coalesce(p.name, s.product_name), coalesce(v.name, s.variant_name), c.name,
         s.qty, s.revenue, coalesce(cost.unit_cost, 0)::numeric, cost.variant_id is not null
    from sold s
    left join public.restaurant_variants v on v.id = s.variant_id
    left join public.restaurant_products p on p.id = v.product_id
    left join public.restaurant_categories c on c.id = p.category_id
    left join cost on cost.variant_id = s.variant_id
   order by s.qty desc;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
do $$
declare f text;
begin
  revoke all on function app.reorder_suggestions(uuid, uuid) from public, anon, authenticated;
  foreach f in array array[
    'public.inventory_record_waste(uuid, uuid, text, uuid, numeric, text, text)',
    'public.inventory_threshold_save(uuid, uuid, text, uuid, numeric, numeric)',
    'public.restaurant_reorder_suggestions(uuid, uuid)',
    'public.restaurant_po_generate(uuid, uuid)',
    'public.restaurant_po_save(uuid, uuid, uuid, uuid, text, date, jsonb)',
    'public.restaurant_po_set_status(uuid, uuid, text)',
    'public.restaurant_po_receive(uuid, uuid, jsonb, text)',
    'public.restaurant_supplier_save(uuid, uuid, text, text, text, boolean)',
    'public.inventory_item_set_supplier(uuid, uuid, uuid)',
    'public.restaurant_recipe_costs(uuid)',
    'public.restaurant_menu_engineering(uuid, uuid, timestamptz, timestamptz)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
