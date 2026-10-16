-- =============================================================================
-- 0105: the dining floor and the kitchen display, phase 1.
--
-- FLOOR
--   * A floor plan per dining zone (restaurant_sections): every table keeps a
--     position, size and shape on its zone's canvas, saved in one call.
--   * Table operations, each in one transaction and audited:
--       transfer  move a table's open orders to another table      (no PIN)
--       merge     put several tables' open orders on ONE check      (PIN)
--       split     move chosen lines, or part of a line, to a new check (PIN)
--     "PIN" = app.require_approval (0103): holders of approval.grant act
--     directly, anyone else needs a manager's single-use grant.
--   * A hostess waiting list: walk-ins and reservations, a quoted wait from
--     the branch's own table turn times, table holds and seating.
--
-- KITCHEN DISPLAY
--   * Every order line now has its own preparation state (queued → preparing
--     → ready), so the grill and the bar each finish their own half of a
--     mixed ticket. The order moves to preparing on the first started line
--     and to ready when the last line is ready.
--   * Per-station warning / late thresholds for the ticket timer colours.
--   * Kitchen analytics: preparation time per item, per chef, per station.
--
-- INVENTORY (0102) — kept exact through moves and splits:
--   * A moved line keeps its id, so its consumption moves with it.
--   * A split line points at the line it came from (split_from); it is never
--     consumed again, and the original consumption is shared out by quantity.
--   * Cancellation is now decided PER LINE: a line the kitchen had not started
--     goes back to stock; a line that was started or ready is food that exists
--     and is recorded as waste. (Before, the whole order went one way.)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------------
insert into public.permissions (key, group_key, module_key, description, is_elevated) values
  ('restaurant.table.transfer',   'restaurant', 'restaurant', 'Transfer, merge and split tables and checks', false),
  ('restaurant.waitlist.manage',  'restaurant', 'restaurant', 'Manage the waiting list and reservations',    false),
  ('restaurant.kitchen.analytics','restaurant', 'restaurant', 'View kitchen preparation-time analytics',      false)
on conflict (key) do update
  set description = excluded.description, group_key = excluded.group_key, module_key = excluded.module_key;

-- Templates: restaurant (or shared) ones only — cashier and storekeeper also
-- exist as retail templates (see 0104).
with grants(role_key, permission_key) as (values
  ('cashier', 'restaurant.table.transfer'),      ('cashier', 'restaurant.waitlist.manage'),
  ('main_cashier', 'restaurant.table.transfer'), ('main_cashier', 'restaurant.waitlist.manage'),
  ('waiter', 'restaurant.table.transfer'),       ('waiter', 'restaurant.waitlist.manage'),
  ('manager', 'restaurant.table.transfer'),      ('manager', 'restaurant.waitlist.manage'),
  ('manager', 'restaurant.kitchen.analytics'),
  ('admin', 'restaurant.table.transfer'),        ('admin', 'restaurant.waitlist.manage'),
  ('admin', 'restaurant.kitchen.analytics')
)
insert into public.role_permissions (role_id, permission_key)
select r.id, g.permission_key
  from grants g
  join public.roles r on r.organization_id is null and r.key = g.role_key
                     and (r.module_key is null or r.module_key = 'restaurant')
on conflict do nothing;

-- Existing organizations: each org copy follows its own template (same module).
insert into public.role_permissions (role_id, permission_key)
select org_role.id, tp.permission_key
  from public.roles org_role
  join public.roles tpl on tpl.organization_id is null and tpl.is_system and tpl.key = org_role.key
                       and tpl.module_key is not distinct from org_role.module_key
  join public.role_permissions tp on tp.role_id = tpl.id
 where org_role.organization_id is not null
   and tp.permission_key in ('restaurant.table.transfer', 'restaurant.waitlist.manage', 'restaurant.kitchen.analytics')
on conflict do nothing;

insert into public.role_permissions (role_id, permission_key)
select r.id, p.key from public.roles r cross join public.permissions p
 where r.is_owner and r.organization_id is not null
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Schema additions
-- ---------------------------------------------------------------------------
-- Floor plan: percentages of the zone canvas, so the plan scales to any screen.
alter table public.restaurant_tables
  add column if not exists layout_x numeric(5, 2) check (layout_x between 0 and 100),
  add column if not exists layout_y numeric(5, 2) check (layout_y between 0 and 100),
  add column if not exists layout_w numeric(5, 2) not null default 12 check (layout_w between 4 and 60),
  add column if not exists layout_h numeric(5, 2) not null default 12 check (layout_h between 4 and 60),
  add column if not exists shape text not null default 'square' check (shape in ('square', 'round', 'rect')),
  -- A merged table points at the table whose check it shares.
  add column if not exists merged_into uuid references public.restaurant_tables(id) on delete set null;
alter table public.restaurant_tables drop constraint if exists restaurant_tables_not_self_merged;
alter table public.restaurant_tables add constraint restaurant_tables_not_self_merged check (merged_into is distinct from id);

alter table public.restaurant_orders
  add column if not exists split_from_order_id uuid references public.restaurant_orders(id) on delete set null,
  add column if not exists merged_into_order_id uuid references public.restaurant_orders(id) on delete set null;

alter table public.restaurant_order_items
  add column if not exists prep_status text not null default 'queued' check (prep_status in ('queued', 'preparing', 'ready')),
  add column if not exists prep_started_at timestamptz,
  add column if not exists prep_ready_at timestamptz,
  add column if not exists prepared_by uuid references auth.users(id) on delete set null,
  add column if not exists seat_no smallint check (seat_no between 1 and 99),
  add column if not exists split_from uuid references public.restaurant_order_items(id) on delete set null;
create index if not exists restaurant_order_items_ready_idx
  on public.restaurant_order_items(organization_id, prep_ready_at) where prep_ready_at is not null;
create index if not exists restaurant_order_items_split_idx
  on public.restaurant_order_items(split_from) where split_from is not null;

-- Lines of orders already past the kitchen are not "queued". The line →
-- order touch trigger is held off for this one backfill so historic orders
-- are not re-saved (and their totals not recomputed) just for this.
alter table public.restaurant_order_items disable trigger restaurant_order_items_resync;
update public.restaurant_order_items i
   set prep_status = case when o.status = 'preparing' then 'preparing' else 'ready' end
  from public.restaurant_orders o
 where o.id = i.order_id and i.prep_status = 'queued'
   and o.status in ('preparing', 'ready', 'served', 'completed');
alter table public.restaurant_order_items enable trigger restaurant_order_items_resync;

alter table public.restaurant_stations
  add column if not exists warn_after_min smallint not null default 10 check (warn_after_min between 1 and 240),
  add column if not exists late_after_min smallint not null default 20 check (late_after_min between 1 and 480);
alter table public.restaurant_stations drop constraint if exists restaurant_stations_late_after_warn;
alter table public.restaurant_stations add constraint restaurant_stations_late_after_warn check (late_after_min > warn_after_min);

-- ---------------------------------------------------------------------------
-- Waiting list
-- ---------------------------------------------------------------------------
create table public.restaurant_waitlist (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  branch_id        uuid not null references public.branches(id) on delete cascade,
  kind             text not null default 'walk_in' check (kind in ('walk_in', 'reservation')),
  guest_name       text not null check (length(trim(guest_name)) between 1 and 80),
  guest_phone      text check (length(guest_phone) <= 30),
  party_size       smallint not null check (party_size between 1 and 50),
  reserved_for     timestamptz,
  status           text not null default 'waiting' check (status in ('waiting', 'notified', 'seated', 'cancelled', 'no_show')),
  table_id         uuid references public.restaurant_tables(id) on delete set null,
  quoted_wait_min  smallint,
  note             text check (length(note) <= 300),
  created_by       uuid references auth.users(id),
  created_at       timestamptz not null default now(),
  notified_at      timestamptz,
  seated_at        timestamptz,
  closed_at        timestamptz,
  check (kind <> 'reservation' or reserved_for is not null)
);
create index restaurant_waitlist_branch_idx on public.restaurant_waitlist(branch_id, status, created_at);

alter table public.restaurant_waitlist enable row level security;
alter table public.restaurant_waitlist force row level security;
revoke all on public.restaurant_waitlist from public, anon, authenticated;
grant select on public.restaurant_waitlist to authenticated;
-- Guests' names and phones: the hostess stand, not every table reader.
create policy waitlist_select on public.restaurant_waitlist for select to authenticated
  using (app.has_branch_permission(organization_id, branch_id, 'restaurant.waitlist.manage'));

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'restaurant_tables') then
      alter publication supabase_realtime add table public.restaurant_tables;
    end if;
    alter publication supabase_realtime add table public.restaurant_waitlist;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
-- Put a table into "occupied" from wherever it is (cleaning goes via available,
-- as the 0016 transition rules require).
create or replace function app.restaurant_table_occupy(p_table uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.restaurant_tables set status = 'available' where id = p_table and status = 'cleaning';
  update public.restaurant_tables set status = 'occupied' where id = p_table and status in ('available', 'reserved');
end;
$$;

-- Orders still being served on a table.
create or replace function app.restaurant_open_order_statuses()
returns text[] language sql immutable set search_path = '' as $$
  select array['new', 'confirmed', 'preparing', 'ready', 'served'];
$$;

create or replace function app.restaurant_status_rank(p_status text)
returns int language sql immutable set search_path = '' as $$
  select case p_status when 'new' then 0 when 'confirmed' then 1 when 'preparing' then 2
                       when 'ready' then 3 when 'served' then 4 else 9 end;
$$;

-- A table whose check is shared resolves to the table that holds it.
create or replace function app.restaurant_table_primary(p_table uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select coalesce(merged_into, id) from public.restaurant_tables where id = p_table;
$$;

-- When the table holding a merged check is freed, its partners are freed too.
create or replace function app.restaurant_release_merged()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status in ('cleaning', 'available') and old.status not in ('cleaning', 'available') then
    update public.restaurant_tables
       set merged_into = null,
           status = case when status in ('occupied', 'waiting_payment', 'reserved') then 'cleaning' else status end
     where merged_into = new.id;
  end if;
  return new;
end;
$$;
create trigger restaurant_tables_release_merged
  after update of status on public.restaurant_tables
  for each row execute function app.restaurant_release_merged();

-- A table is only freed when its LAST open check closes. Paying or closing one
-- of two split checks used to send the table to cleaning with guests still
-- at it; every path that frees a table (closing, paying, cancelling) now
-- passes through this one rule.
create or replace function app.restaurant_keep_table_busy()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status in ('cleaning', 'available') and old.status in ('occupied', 'waiting_payment')
     and exists (select 1 from public.restaurant_orders o
                  where o.table_id = new.id and o.status = any(app.restaurant_open_order_statuses())) then
    new.status := old.status;
  end if;
  return new;
end;
$$;
create trigger restaurant_tables_keep_busy
  before update of status on public.restaurant_tables
  for each row execute function app.restaurant_keep_table_busy();

-- ---------------------------------------------------------------------------
-- Approvals: two new sensitive actions (0103 list + table.merge, check.split)
-- ---------------------------------------------------------------------------
alter table public.approval_grants drop constraint approval_grants_action_check;
alter table public.approval_grants add constraint approval_grants_action_check
  check (action in ('order.cancel', 'order.discount', 'inventory.adjust', 'inventory.resolve', 'table.merge', 'check.split'));

create or replace function public.approval_grant(
  p_org uuid, p_branch uuid, p_action text, p_subject uuid, p_amount numeric,
  p_approver_member uuid, p_pin text
) returns table (out_grant uuid, out_error text)
language plpgsql security definer set search_path = '' as $$
declare
  v_pin  public.member_approval_pins%rowtype;
  v_approver uuid;
  v_id   uuid;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if p_action not in ('order.cancel', 'order.discount', 'inventory.adjust', 'inventory.resolve', 'table.merge', 'check.split') then
    raise exception 'unknown action' using errcode = '22023';
  end if;
  if not exists (select 1 from public.organization_members where organization_id = p_org and user_id = auth.uid() and status = 'active') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  perform app.rate_limit('rl_approval_try', auth.uid()::text, 20, 600);

  select p.* into v_pin from public.member_approval_pins p
    join public.organization_members m on m.id = p.member_id
   where p.member_id = p_approver_member and m.organization_id = p_org and m.status = 'active'
   for update of p;
  select m.user_id into v_approver from public.organization_members m where m.id = p_approver_member;

  if v_pin.member_id is null or v_approver is null
     or not app.user_has_branch_permission(v_approver, p_org, p_branch, 'approval.grant') then
    return query select null::uuid, 'هذا المستخدم لا يملك صلاحية الموافقة'::text; return;
  end if;
  if v_approver = auth.uid() then
    return query select null::uuid, 'لا يمكنك الموافقة على طلبك بنفسك'::text; return;
  end if;
  if v_pin.locked_until is not null and v_pin.locked_until > now() then
    return query select null::uuid, 'تم إيقاف الرمز مؤقتًا بعد محاولات خاطئة. حاول بعد 15 دقيقة.'::text; return;
  end if;

  if not app.pin_matches(coalesce(p_pin, ''), v_pin.pin_hash) then
    update public.member_approval_pins
       set failed_attempts = failed_attempts + 1,
           locked_until = case when failed_attempts + 1 >= 5 then now() + interval '15 minutes' else locked_until end
     where member_id = v_pin.member_id;
    insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
    values (p_org, p_branch, auth.uid(), 'approval.pin_failed', 'organization_member', p_approver_member::text,
            jsonb_build_object('action', p_action, 'subject_id', p_subject));
    return query select null::uuid, 'الرمز غير صحيح'::text; return;
  end if;

  update public.member_approval_pins set failed_attempts = 0, locked_until = null where member_id = v_pin.member_id;
  insert into public.approval_grants (organization_id, branch_id, action, subject_id, amount, requested_by, approved_by)
  values (p_org, p_branch, p_action, p_subject, p_amount, auth.uid(), v_approver)
  returning id into v_id;
  insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, p_branch, v_approver, 'approval.granted', 'approval_grant', v_id::text,
          jsonb_build_object('action', p_action, 'subject_id', p_subject, 'amount', p_amount, 'requested_by', auth.uid()));
  return query select v_id, null::text;
end;
$$;

-- The 0103 order guard, with one change: closing an order that no longer has
-- any lines (a check emptied by a merge) needs no approval — nothing is lost.
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
    if to_regclass('public.restaurant_loyalty_coupons') is not null then
      execute 'select coalesce(sum(value_cents), 0) from public.restaurant_loyalty_coupons
                where redeemed_order_id = $1 and status = ''redeemed'''
        into v_coupons using new.id;
    end if;
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
-- Inventory, per line (replaces the 0102 order-level rules)
-- ---------------------------------------------------------------------------
-- A split line was already consumed as part of the line it came from.
create or replace function app.inventory_on_order_item()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.split_from is not null then
    return new;
  end if;
  if exists (select 1 from public.restaurant_orders o
              where o.id = new.order_id and o.status in ('confirmed', 'preparing', 'ready', 'served')) then
    perform app.inventory_consume_line(new.id);
  end if;
  return new;
end;
$$;

-- The 0094 product-count guard, skipping split lines (no new food).
create or replace function app.restaurant_stock_guard_line()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_product uuid;
  v_branch  uuid;
  v_stock   int;
  v_already numeric;
begin
  if new.variant_id is null or new.split_from is not null then
    return new;
  end if;
  select p.id into v_product
    from public.restaurant_variants v
    join public.restaurant_products p on p.id = v.product_id
   where v.id = new.variant_id and p.track_inventory;
  if v_product is null then
    return new;
  end if;

  select branch_id into v_branch from public.restaurant_orders where id = new.order_id;
  select quantity into v_stock from public.restaurant_branch_stock
   where branch_id = v_branch and product_id = v_product;

  select coalesce(sum(i.quantity), 0) into v_already
    from public.restaurant_order_items i
    join public.restaurant_variants v on v.id = i.variant_id
   where i.order_id = new.order_id and v.product_id = v_product;

  if coalesce(v_stock, 0) < new.quantity + v_already then
    raise exception 'نفدت الكمية: % متاح بكمية أقل من المطلوبة', new.product_name
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create or replace function app.inventory_on_order_status()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  r      record;
  v_line uuid;
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  if new.status in ('confirmed', 'preparing', 'ready', 'served', 'completed')
     and old.status in ('new', 'pending_verification') then
    for v_line in select id from public.restaurant_order_items where order_id = new.id and split_from is null loop
      perform app.inventory_consume_line(v_line);
    end loop;

  elsif new.status = 'cancelled' and old.status in ('confirmed', 'preparing', 'ready', 'served') then
    -- Each line's share of what its family (the line and anything split from
    -- it) consumed: by quantity, wherever those lines are now.
    for r in
      select i.id as line_id, i.prep_status, m.organization_id, m.branch_id, m.location_id, m.item_id,
             m.unit_cost_cents,
             (-m.qty) * i.quantity
               / nullif((select sum(f.quantity) from public.restaurant_order_items f
                          where coalesce(f.split_from, f.id) = coalesce(i.split_from, i.id)), 0) as used
        from public.restaurant_order_items i
        join public.inventory_movements m
          on m.ref_line = coalesce(i.split_from, i.id) and m.reason = 'consumption'
       where i.order_id = new.id
    loop
      continue when round(coalesce(r.used, 0), 3) <= 0;
      if r.prep_status = 'queued' then
        -- Never started: it goes back.
        insert into public.inventory_movements
          (organization_id, branch_id, location_id, item_id, qty, unit_cost_cents, reason,
           doc_type, doc_id, ref_line, actor_id, note)
        values (r.organization_id, r.branch_id, r.location_id, r.item_id, round(r.used, 3), r.unit_cost_cents,
                'consumption_reversal', 'restaurant_order', new.id, r.line_id, auth.uid(), 'إلغاء قبل التحضير')
        on conflict (ref_line, item_id) where reason = 'consumption_reversal' do nothing;
      else
        -- Started or ready: the food exists; it is a loss against the order.
        insert into public.inventory_waste
          (organization_id, branch_id, location_id, item_id, qty, cost_cents, reason, note, order_id,
           recorded_by, moved_stock)
        values (r.organization_id, r.branch_id, r.location_id, r.item_id, round(r.used, 3),
                round(r.used * r.unit_cost_cents, 2), 'order_cancelled', left(new.cancel_reason, 300), new.id,
                auth.uid(), false);
      end if;
    end loop;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Line preparation state follows the order when the order is moved as a
-- whole (the 0080 board buttons, the waiter). A per-line bump from the KDS
-- sets app.kds_bump so starting one station's line does not start the rest.
-- ---------------------------------------------------------------------------
create or replace function app.restaurant_prep_on_status()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status is not distinct from old.status then return new; end if;
  if new.status = 'preparing' and coalesce(current_setting('app.kds_bump', true), '') <> 'on' then
    update public.restaurant_order_items
       set prep_status = 'preparing', prep_started_at = now()
     where order_id = new.id and prep_status = 'queued';
  elsif new.status = 'ready' then
    update public.restaurant_order_items
       set prep_status = 'ready', prep_ready_at = now(),
           prep_started_at = coalesce(prep_started_at, now()),
           prepared_by = coalesce(prepared_by, auth.uid())
     where order_id = new.id and prep_status <> 'ready';
  end if;
  return new;
end;
$$;
create trigger restaurant_orders_prep_status
  after update of status on public.restaurant_orders
  for each row execute function app.restaurant_prep_on_status();

-- ---------------------------------------------------------------------------
-- KDS: bump lines at one station
-- ---------------------------------------------------------------------------
create or replace function public.restaurant_kds_bump(p_org uuid, p_items uuid[], p_status text)
returns table (out_order_id uuid, out_order_status text)
language plpgsql security definer set search_path = '' as $$
declare
  r        record;
  v_order  record;
  v_orders uuid[] := '{}';
  v_o      uuid;
  v_total  int;
  v_ready  int;
  v_moving int;
  v_on     constant text := 'on';
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if p_status not in ('queued', 'preparing', 'ready') then raise exception 'حالة غير معروفة' using errcode = '22023'; end if;
  if p_items is null or cardinality(p_items) = 0 or cardinality(p_items) > 200 then
    raise exception 'لا توجد أصناف' using errcode = '22023';
  end if;

  for r in
    select i.id, i.order_id, i.prep_status, coalesce(i.station_kind, 'kitchen') as kind,
           o.branch_id, o.status as order_status
      from public.restaurant_order_items i
      join public.restaurant_orders o on o.id = i.order_id
     where i.id = any(p_items) and i.organization_id = p_org
     order by i.order_id
       for update of i
  loop
    if not app.has_branch_permission(p_org, r.branch_id,
             case r.kind when 'bar' then 'restaurant.bar.use' else 'restaurant.kitchen.use' end) then
      raise exception 'not permitted' using errcode = '42501';
    end if;
    if r.order_status not in ('confirmed', 'preparing', 'ready') then
      raise exception 'هذا الطلب لم يعد في المطبخ' using errcode = 'check_violation';
    end if;
    -- Taking a line back is only possible while the order is not yet ready.
    if r.order_status = 'ready' and p_status <> 'ready' then
      raise exception 'الطلب جاهز بالفعل' using errcode = 'check_violation';
    end if;
    continue when r.prep_status = p_status;

    update public.restaurant_order_items
       set prep_status = p_status,
           prep_started_at = case when p_status = 'queued' then null
                                  else coalesce(prep_started_at, now()) end,
           prep_ready_at = case when p_status = 'ready' then now() else null end,
           prepared_by = case when p_status = 'ready' then auth.uid() else null end
     where id = r.id;
    if not (r.order_id = any(v_orders)) then v_orders := v_orders || r.order_id; end if;
  end loop;

  perform set_config('app.kds_bump', v_on, true);
  foreach v_o in array v_orders loop
    select id, branch_id, status into v_order from public.restaurant_orders where id = v_o for update;
    select count(*), count(*) filter (where prep_status = 'ready'), count(*) filter (where prep_status <> 'queued')
      into v_total, v_ready, v_moving
      from public.restaurant_order_items where order_id = v_o;
    if v_total > 0 and v_ready = v_total and v_order.status in ('confirmed', 'preparing') then
      update public.restaurant_orders set status = 'ready' where id = v_o;
    elsif v_moving > 0 and v_order.status = 'confirmed' then
      update public.restaurant_orders set status = 'preparing' where id = v_o;
    end if;
    insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
    values (p_org, v_order.branch_id, auth.uid(), 'restaurant.kds.bump', 'restaurant_order', v_o::text,
            jsonb_build_object('status', p_status,
                               'items', (select jsonb_agg(x) from unnest(p_items) x
                                          where x in (select id from public.restaurant_order_items where order_id = v_o))));
  end loop;
  perform set_config('app.kds_bump', '', true);

  return query select o.id, o.status from public.restaurant_orders o where o.id = any(v_orders);
end;
$$;

-- ---------------------------------------------------------------------------
-- Kitchen analytics
-- ---------------------------------------------------------------------------
create or replace function public.restaurant_kitchen_analytics(p_org uuid, p_branch uuid, p_days int default 7)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_from timestamptz := now() - make_interval(days => least(greatest(coalesce(p_days, 7), 1), 90));
  v jsonb;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_branch_permission(p_org, p_branch, 'restaurant.kitchen.analytics') then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  with lines as (
    select i.product_name, i.quantity, i.prepared_by, i.station_id, coalesce(i.station_kind, 'kitchen') as kind,
           extract(epoch from (i.prep_ready_at - coalesce(o.confirmed_at, o.placed_at)))::numeric as total_sec,
           case when i.prep_started_at is not null
                then extract(epoch from (i.prep_ready_at - i.prep_started_at))::numeric end as cook_sec,
           coalesce(s.late_after_min, 20) as late_min
      from public.restaurant_order_items i
      join public.restaurant_orders o on o.id = i.order_id
      left join public.restaurant_stations s on s.id = i.station_id
     where i.organization_id = p_org and o.branch_id = p_branch
       and i.prep_ready_at is not null and i.prep_ready_at >= v_from
       and i.prep_ready_at >= coalesce(o.confirmed_at, o.placed_at)
  )
  select jsonb_build_object(
    'days', least(greatest(coalesce(p_days, 7), 1), 90),
    'overall', (select jsonb_build_object(
        'lines', count(*), 'avg_total_sec', round(avg(total_sec)), 'avg_cook_sec', round(avg(cook_sec)),
        'p90_total_sec', round(percentile_cont(0.9) within group (order by total_sec)::numeric),
        'late_share', round(avg(case when total_sec > late_min * 60 then 1 else 0 end)::numeric, 3))
      from lines),
    'by_item', coalesce((select jsonb_agg(x order by x->>'avg_total_sec' desc) from (
        select jsonb_build_object('name', product_name, 'lines', count(*), 'units', sum(quantity),
               'avg_total_sec', round(avg(total_sec)), 'avg_cook_sec', round(avg(cook_sec)),
               'p90_total_sec', round(percentile_cont(0.9) within group (order by total_sec)::numeric)) as x
          from lines group by product_name order by count(*) desc limit 50) t), '[]'::jsonb),
    'by_chef', coalesce((select jsonb_agg(x) from (
        select jsonb_build_object('user_id', l.prepared_by,
               'name', coalesce(nullif(trim(pr.full_name), ''), '—'),
               'lines', count(*), 'avg_total_sec', round(avg(l.total_sec)), 'avg_cook_sec', round(avg(l.cook_sec))) as x
          from lines l left join public.profiles pr on pr.id = l.prepared_by
         where l.prepared_by is not null
         group by l.prepared_by, pr.full_name order by count(*) desc limit 50) t), '[]'::jsonb),
    'by_station', coalesce((select jsonb_agg(x) from (
        select jsonb_build_object('station_id', l.station_id,
               'name', coalesce(s.name, case l.kind when 'bar' then 'البار' else 'المطبخ' end),
               'lines', count(*), 'avg_total_sec', round(avg(l.total_sec)),
               'late_share', round(avg(case when l.total_sec > l.late_min * 60 then 1 else 0 end)::numeric, 3)) as x
          from lines l left join public.restaurant_stations s on s.id = l.station_id
         group by l.station_id, s.name, l.kind order by count(*) desc) t), '[]'::jsonb)
  ) into v;
  return v;
end;
$$;

-- ---------------------------------------------------------------------------
-- Floor plan
-- ---------------------------------------------------------------------------
-- p_tables: [{ "id", "section_id", "x", "y", "w", "h", "shape" }]
create or replace function public.restaurant_floor_layout_save(p_org uuid, p_branch uuid, p_tables jsonb)
returns int language plpgsql security definer set search_path = '' as $$
declare
  v_t jsonb;
  v_n int := 0;
  v_section uuid;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_branch_permission(p_org, p_branch, 'restaurant.table.manage') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if jsonb_typeof(coalesce(p_tables, 'null')) <> 'array' or jsonb_array_length(p_tables) > 500 then
    raise exception 'مخطط غير صالح' using errcode = '22023';
  end if;
  for v_t in select * from jsonb_array_elements(p_tables) loop
    v_section := nullif(v_t ->> 'section_id', '')::uuid;
    if v_section is not null and not exists (
         select 1 from public.restaurant_sections where id = v_section and branch_id = p_branch) then
      raise exception 'المنطقة غير موجودة' using errcode = 'check_violation';
    end if;
    update public.restaurant_tables
       set section_id = v_section,
           layout_x = round(least(greatest((v_t ->> 'x')::numeric, 0), 100), 2),
           layout_y = round(least(greatest((v_t ->> 'y')::numeric, 0), 100), 2),
           layout_w = round(least(greatest(coalesce((v_t ->> 'w')::numeric, 12), 4), 60), 2),
           layout_h = round(least(greatest(coalesce((v_t ->> 'h')::numeric, 12), 4), 60), 2),
           shape = case when v_t ->> 'shape' in ('square', 'round', 'rect') then v_t ->> 'shape' else shape end
     where id = (v_t ->> 'id')::uuid and branch_id = p_branch and organization_id = p_org and deleted_at is null;
    if not found then raise exception 'الطاولة غير موجودة' using errcode = 'check_violation'; end if;
    v_n := v_n + 1;
  end loop;
  insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, p_branch, auth.uid(), 'restaurant.floor.layout_saved', 'branch', p_branch::text,
          jsonb_build_object('tables', v_n));
  return v_n;
end;
$$;

-- ---------------------------------------------------------------------------
-- Table operations
-- ---------------------------------------------------------------------------
create or replace function app.restaurant_table_check(p_org uuid, p_table uuid)
returns public.restaurant_tables language plpgsql stable security definer set search_path = '' as $$
declare v public.restaurant_tables%rowtype;
begin
  select * into v from public.restaurant_tables
   where id = p_table and organization_id = p_org and deleted_at is null and is_active;
  if v.id is null then raise exception 'الطاولة غير موجودة' using errcode = 'check_violation'; end if;
  return v;
end;
$$;

-- Move a table's open orders (or one of them) to another table.
create or replace function public.restaurant_table_transfer(p_org uuid, p_from uuid, p_to uuid, p_order uuid default null)
returns int language plpgsql security definer set search_path = '' as $$
declare
  v_from  public.restaurant_tables%rowtype;
  v_to    public.restaurant_tables%rowtype;
  v_ids   uuid[];
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  v_from := app.restaurant_table_check(p_org, p_from);
  v_to   := app.restaurant_table_check(p_org, coalesce(app.restaurant_table_primary(p_to), p_to));
  if not app.has_branch_permission(p_org, v_from.branch_id, 'restaurant.table.transfer') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_from.branch_id <> v_to.branch_id then raise exception 'الطاولتان في فرعين مختلفين' using errcode = 'check_violation'; end if;
  if v_from.id = v_to.id then raise exception 'اختر طاولة أخرى' using errcode = 'check_violation'; end if;

  select array_agg(id) into v_ids from public.restaurant_orders
   where table_id = p_from and status = any(app.restaurant_open_order_statuses())
     and (p_order is null or id = p_order);
  if v_ids is null then raise exception 'لا توجد طلبات مفتوحة على هذه الطاولة' using errcode = 'check_violation'; end if;

  update public.restaurant_orders set table_id = v_to.id where id = any(v_ids);
  perform app.restaurant_table_occupy(v_to.id);
  update public.restaurant_tables set merged_into = v_to.id where merged_into = p_from and id <> v_to.id;
  if not exists (select 1 from public.restaurant_orders
                  where table_id = p_from and status = any(app.restaurant_open_order_statuses())) then
    update public.restaurant_tables set status = 'cleaning' where id = p_from and status in ('occupied', 'waiting_payment');
  end if;

  insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, before, after)
  values (p_org, v_from.branch_id, auth.uid(), 'restaurant.table.transferred', 'restaurant_table', p_from::text,
          jsonb_build_object('table', v_from.name), jsonb_build_object('to', v_to.name, 'to_id', v_to.id, 'orders', v_ids));
  return cardinality(v_ids);
end;
$$;

-- Seat several tables as one party on one check.
create or replace function public.restaurant_table_merge(p_org uuid, p_target uuid, p_sources uuid[])
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_target public.restaurant_tables%rowtype;
  v_src    uuid;
  v_t      public.restaurant_tables%rowtype;
  v_all    uuid[];
  v_check  record;
  r        record;
  v_by     uuid;
  v_moved  int := 0;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  v_target := app.restaurant_table_check(p_org, p_target);
  if not app.has_branch_permission(p_org, v_target.branch_id, 'restaurant.table.transfer') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_target.merged_into is not null then raise exception 'هذه الطاولة مدموجة مع طاولة أخرى' using errcode = 'check_violation'; end if;
  if p_sources is null or cardinality(p_sources) = 0 or cardinality(p_sources) > 20 or p_target = any(p_sources) then
    raise exception 'اختر الطاولات المراد دمجها' using errcode = '22023';
  end if;
  foreach v_src in array p_sources loop
    v_t := app.restaurant_table_check(p_org, v_src);
    if v_t.branch_id <> v_target.branch_id then raise exception 'الطاولات في فروع مختلفة' using errcode = 'check_violation'; end if;
    if v_t.merged_into is not null and v_t.merged_into <> p_target then
      raise exception 'الطاولة % مدموجة بالفعل', v_t.name using errcode = 'check_violation';
    end if;
  end loop;
  v_all := array_append(p_sources, p_target);

  -- Every open order on these tables must be a plain, unpaid, confirmed check.
  if exists (select 1 from public.restaurant_orders
              where table_id = any(v_all) and status in ('new', 'pending_verification')) then
    raise exception 'أكّد الطلبات المفتوحة على هذه الطاولات أولًا' using errcode = 'check_violation';
  end if;
  if exists (select 1 from public.restaurant_orders
              where table_id = any(v_all) and status = any(app.restaurant_open_order_statuses())
                and (invoice_id is not null or discount_cents > 0)) then
    raise exception 'لا يمكن دمج طلب بدأ تحصيله أو عليه خصم' using errcode = 'check_violation';
  end if;

  v_by := app.require_approval(p_org, v_target.branch_id, 'table.merge', p_target);

  -- The check is the least advanced order, so no line drops off a station screen.
  select id, number, status into v_check from public.restaurant_orders
   where table_id = any(v_all) and status = any(app.restaurant_open_order_statuses())
   order by app.restaurant_status_rank(status), placed_at
   limit 1 for update;

  if v_check.id is not null then
    update public.restaurant_orders set table_id = p_target where id = v_check.id and table_id <> p_target;
    for r in
      select id, status from public.restaurant_orders
       where table_id = any(v_all) and status = any(app.restaurant_open_order_statuses()) and id <> v_check.id
       for update
    loop
      update public.restaurant_order_items set order_id = v_check.id where order_id = r.id;
      update public.restaurant_orders
         set status = case when r.status = 'served' then 'completed' else 'cancelled' end,
             cancel_reason = case when r.status = 'served' then cancel_reason else 'دُمج في الطلب ' || v_check.number end,
             merged_into_order_id = v_check.id
       where id = r.id;
      v_moved := v_moved + 1;
    end loop;
    update public.restaurant_orders set updated_at = now() where id = v_check.id;
  end if;

  perform app.restaurant_table_occupy(p_target);
  -- Tables already sharing a source's check now share the target's.
  update public.restaurant_tables set merged_into = p_target where merged_into = any(p_sources);
  foreach v_src in array p_sources loop
    update public.restaurant_tables set merged_into = p_target where id = v_src;
    perform app.restaurant_table_occupy(v_src);
  end loop;

  insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, v_target.branch_id, auth.uid(), 'restaurant.table.merged', 'restaurant_table', p_target::text,
          jsonb_build_object('sources', p_sources, 'check_order', v_check.id, 'orders_merged', v_moved, 'approved_by', v_by));
  return v_check.id;
end;
$$;

create or replace function public.restaurant_table_unmerge(p_org uuid, p_table uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v public.restaurant_tables%rowtype;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  v := app.restaurant_table_check(p_org, p_table);
  if not app.has_branch_permission(p_org, v.branch_id, 'restaurant.table.transfer') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v.merged_into is null then raise exception 'الطاولة غير مدموجة' using errcode = 'check_violation'; end if;
  update public.restaurant_tables set merged_into = null where id = p_table;
  if not exists (select 1 from public.restaurant_orders
                  where table_id = p_table and status = any(app.restaurant_open_order_statuses())) then
    update public.restaurant_tables set status = 'cleaning' where id = p_table and status in ('occupied', 'waiting_payment');
  end if;
  insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, v.branch_id, auth.uid(), 'restaurant.table.unmerged', 'restaurant_table', p_table::text,
          jsonb_build_object('from', v.merged_into));
end;
$$;

-- Split a check: move whole lines, or part of a line's quantity, to a new check
-- on the same table. p_lines: [{ "item_id": ..., "qty": ... }]
create or replace function public.restaurant_check_split(p_org uuid, p_order uuid, p_lines jsonb)
returns table (out_order_id uuid, out_number text)
language plpgsql security definer set search_path = '' as $$
declare
  v_order  public.restaurant_orders%rowtype;
  v_new    uuid;
  v_number text;
  v_line   jsonb;
  v_item   public.restaurant_order_items%rowtype;
  v_qty    numeric;
  v_new_item uuid;
  v_gross  bigint;
  v_by     uuid;
  v_units_total numeric;
  v_units_moved numeric := 0;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into v_order from public.restaurant_orders where id = p_order and organization_id = p_org for update;
  if v_order.id is null then raise exception 'الطلب غير موجود' using errcode = 'check_violation'; end if;
  if not app.has_branch_permission(p_org, v_order.branch_id, 'restaurant.table.transfer') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_order.status not in ('new', 'confirmed', 'preparing', 'ready', 'served') then
    raise exception 'لا يمكن تقسيم هذا الطلب' using errcode = 'check_violation';
  end if;
  if v_order.invoice_id is not null or v_order.discount_cents > 0 then
    raise exception 'لا يمكن تقسيم طلب بدأ تحصيله أو عليه خصم' using errcode = 'check_violation';
  end if;
  if jsonb_typeof(coalesce(p_lines, 'null')) <> 'array' or jsonb_array_length(p_lines) = 0 or jsonb_array_length(p_lines) > 100 then
    raise exception 'اختر الأصناف المراد فصلها' using errcode = '22023';
  end if;

  select coalesce(sum(quantity), 0) into v_units_total from public.restaurant_order_items where order_id = p_order;
  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_units_moved := v_units_moved + coalesce((v_line ->> 'qty')::numeric, 0);
  end loop;
  if v_units_moved >= v_units_total then
    raise exception 'يجب أن يبقى صنف واحد على الأقل في الفاتورة الأصلية' using errcode = 'check_violation';
  end if;

  v_by := app.require_approval(p_org, v_order.branch_id, 'check.split', p_order);

  v_number := app.next_document_number(p_org, v_order.branch_id, 'restaurant_order');
  insert into public.restaurant_orders
    (organization_id, branch_id, table_id, number, channel, type, status, customer_id, guest_name, guest_phone,
     currency, placed_at, confirmed_at, ready_at, served_at, created_by, guest_verified, split_from_order_id)
  values (p_org, v_order.branch_id, v_order.table_id, v_number, v_order.channel, v_order.type, v_order.status,
          v_order.customer_id, v_order.guest_name, v_order.guest_phone, v_order.currency, v_order.placed_at,
          v_order.confirmed_at, v_order.ready_at, v_order.served_at, auth.uid(), true, p_order)
  returning id into v_new;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    select * into v_item from public.restaurant_order_items
     where id = (v_line ->> 'item_id')::uuid and order_id = p_order for update;
    if v_item.id is null then raise exception 'الصنف ليس في هذا الطلب' using errcode = 'check_violation'; end if;
    v_qty := (v_line ->> 'qty')::numeric;
    if v_qty is null or v_qty <= 0 or v_qty > v_item.quantity then
      raise exception 'كمية غير صالحة للصنف %', v_item.product_name using errcode = '22023';
    end if;

    if v_qty = v_item.quantity then
      update public.restaurant_order_items set order_id = v_new where id = v_item.id;
    else
      v_gross := round((v_item.unit_price_cents + v_item.modifiers_cents) * (v_item.quantity - v_qty));
      update public.restaurant_order_items
         set quantity = v_item.quantity - v_qty,
             line_total_cents = v_gross + round((v_gross * v_item.tax_rate_bp)::numeric / 10000)
       where id = v_item.id;
      v_gross := round((v_item.unit_price_cents + v_item.modifiers_cents) * v_qty);
      insert into public.restaurant_order_items
        (order_id, organization_id, variant_id, product_name, variant_name, quantity, unit_price_cents,
         modifiers_cents, tax_rate_bp, line_total_cents, note, position, station_id, station_kind,
         prep_status, prep_started_at, prep_ready_at, prepared_by, seat_no, split_from)
      values (v_new, p_org, v_item.variant_id, v_item.product_name, v_item.variant_name, v_qty,
              v_item.unit_price_cents, v_item.modifiers_cents, v_item.tax_rate_bp,
              v_gross + round((v_gross * v_item.tax_rate_bp)::numeric / 10000),
              v_item.note, v_item.position, v_item.station_id, v_item.station_kind,
              v_item.prep_status, v_item.prep_started_at, v_item.prep_ready_at, v_item.prepared_by,
              -- An unconfirmed order has consumed nothing yet: its split line is a line of its own.
              v_item.seat_no, case when v_order.status = 'new' then null else coalesce(v_item.split_from, v_item.id) end)
      returning id into v_new_item;
      insert into public.restaurant_order_item_modifiers (order_item_id, organization_id, modifier_id, name, price_cents)
      select v_new_item, organization_id, modifier_id, name, price_cents
        from public.restaurant_order_item_modifiers where order_item_id = v_item.id;
    end if;
  end loop;

  update public.restaurant_orders set updated_at = now() where id in (p_order, v_new);

  insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, v_order.branch_id, auth.uid(), 'restaurant.check.split', 'restaurant_order', p_order::text,
          jsonb_build_object('new_order', v_new, 'new_number', v_number, 'lines', p_lines, 'approved_by', v_by));
  return query select v_new, v_number;
end;
$$;

-- Which seat a line belongs to, for splitting by seat.
create or replace function public.restaurant_order_item_set_seat(p_org uuid, p_items uuid[], p_seat int)
returns void language plpgsql security definer set search_path = '' as $$
declare v_branch uuid;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if p_seat is not null and (p_seat < 1 or p_seat > 99) then raise exception 'رقم مقعد غير صالح' using errcode = '22023'; end if;
  if p_items is null or cardinality(p_items) = 0 or cardinality(p_items) > 200 then raise exception 'لا توجد أصناف' using errcode = '22023'; end if;
  for v_branch in
    select distinct o.branch_id from public.restaurant_order_items i join public.restaurant_orders o on o.id = i.order_id
     where i.id = any(p_items) and i.organization_id = p_org
  loop
    if not (app.has_branch_permission(p_org, v_branch, 'restaurant.table.transfer')
            or app.has_branch_permission(p_org, v_branch, 'restaurant.order.update')) then
      raise exception 'not permitted' using errcode = '42501';
    end if;
  end loop;
  update public.restaurant_order_items i set seat_no = p_seat
    from public.restaurant_orders o
   where o.id = i.order_id and i.id = any(p_items) and i.organization_id = p_org
     and o.status = any(app.restaurant_open_order_statuses()) and o.invoice_id is null;
end;
$$;

-- ---------------------------------------------------------------------------
-- Waiting list
-- ---------------------------------------------------------------------------
-- Minutes until a table that fits this party is likely to be free.
create or replace function app.restaurant_wait_estimate(p_branch uuid, p_party int, p_exclude uuid default null)
returns int language plpgsql stable security definer set search_path = '' as $$
declare
  v_turn   numeric;
  v_ahead  int;
  v_rem    numeric[];
  v_n      int;
begin
  -- A free table that fits: no wait.
  if exists (select 1 from public.restaurant_tables t
              where t.branch_id = p_branch and t.is_active and t.deleted_at is null and t.merged_into is null
                and t.seats >= p_party and t.status = 'available'
                and not exists (select 1 from public.restaurant_waitlist w
                                 where w.table_id = t.id and w.status in ('waiting', 'notified'))) then
    return 0;
  end if;

  -- This branch's own table turn: dine-in visits over the last 30 days.
  select percentile_cont(0.5) within group (order by extract(epoch from (completed_at - placed_at)) / 60)
    into v_turn
    from public.restaurant_orders
   where branch_id = p_branch and type = 'dine_in' and status = 'completed'
     and completed_at > now() - interval '30 days' and completed_at > placed_at;
  v_turn := least(greatest(coalesce(v_turn, 45), 15), 180);

  -- Time left at each table big enough, soonest first.
  select array_agg(rem order by rem), count(*) into v_rem, v_n from (
    -- No open order: the table is being cleaned or held — minutes, not a turn.
    select case when min(o.placed_at) is null then 5
                else greatest(v_turn - extract(epoch from (now() - min(o.placed_at))) / 60, 5) end as rem
      from public.restaurant_tables t
      left join public.restaurant_orders o
        on o.table_id = t.id and o.status = any(app.restaurant_open_order_statuses())
     where t.branch_id = p_branch and t.is_active and t.deleted_at is null and t.merged_into is null
       and t.seats >= p_party
     group by t.id) x;
  if coalesce(v_n, 0) = 0 then
    return null;  -- no table seats a party this size; the hostess must combine tables
  end if;

  -- Walk-ins already waiting who would take the same tables.
  select count(*) into v_ahead from public.restaurant_waitlist
   where branch_id = p_branch and kind = 'walk_in' and status in ('waiting', 'notified')
     and party_size <= (select max(seats) from public.restaurant_tables
                         where branch_id = p_branch and is_active and deleted_at is null and seats >= p_party)
     and party_size >= greatest(p_party - 2, 1)
     and (p_exclude is null or id <> p_exclude)
     and created_at < coalesce((select created_at from public.restaurant_waitlist where id = p_exclude), now());

  return ceil(v_rem[(v_ahead % v_n) + 1] + v_turn * (v_ahead / v_n))::int;
end;
$$;

create or replace function public.restaurant_waitlist_estimate(p_org uuid, p_branch uuid, p_party int)
returns int language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_branch_permission(p_org, p_branch, 'restaurant.waitlist.manage') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if p_party is null or p_party < 1 or p_party > 50 then raise exception 'عدد الأشخاص غير صالح' using errcode = '22023'; end if;
  return app.restaurant_wait_estimate(p_branch, p_party);
end;
$$;

create or replace function public.restaurant_waitlist_add(
  p_org uuid, p_branch uuid, p_name text, p_phone text, p_party int,
  p_kind text default 'walk_in', p_reserved_for timestamptz default null, p_note text default null
) returns table (out_id uuid, out_quoted_min int)
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_q int;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_branch_permission(p_org, p_branch, 'restaurant.waitlist.manage') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if not exists (select 1 from public.branches where id = p_branch and organization_id = p_org) then
    raise exception 'الفرع غير موجود' using errcode = 'check_violation';
  end if;
  if length(trim(coalesce(p_name, ''))) not between 1 and 80 then raise exception 'اسم الضيف مطلوب' using errcode = '22023'; end if;
  if p_party is null or p_party < 1 or p_party > 50 then raise exception 'عدد الأشخاص غير صالح' using errcode = '22023'; end if;
  if p_kind not in ('walk_in', 'reservation') then raise exception 'نوع غير معروف' using errcode = '22023'; end if;
  if p_kind = 'reservation' and (p_reserved_for is null or p_reserved_for < now() - interval '1 hour') then
    raise exception 'حدد موعد الحجز' using errcode = '22023';
  end if;
  if p_phone is not null and p_phone !~ '^[0-9+ ()-]{5,30}$' then raise exception 'رقم الهاتف غير صالح' using errcode = '22023'; end if;
  perform app.rate_limit('rl_waitlist_add', p_branch::text, 300, 3600);

  v_q := case when p_kind = 'walk_in' then app.restaurant_wait_estimate(p_branch, p_party) end;
  insert into public.restaurant_waitlist
    (organization_id, branch_id, kind, guest_name, guest_phone, party_size, reserved_for, quoted_wait_min, note, created_by)
  values (p_org, p_branch, p_kind, trim(p_name), nullif(trim(coalesce(p_phone, '')), ''), p_party,
          case when p_kind = 'reservation' then p_reserved_for end, v_q,
          left(nullif(trim(coalesce(p_note, '')), ''), 300), auth.uid())
  returning id into v_id;
  insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, p_branch, auth.uid(), 'restaurant.waitlist.added', 'restaurant_waitlist', v_id::text,
          jsonb_build_object('kind', p_kind, 'party', p_party, 'quoted_min', v_q));
  return query select v_id, v_q;
end;
$$;

-- p_action: assign (hold a table) · notify · seat · cancel · no_show
create or replace function public.restaurant_waitlist_action(p_org uuid, p_id uuid, p_action text, p_table uuid default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v public.restaurant_waitlist%rowtype;
  v_t public.restaurant_tables%rowtype;
  v_old_table uuid;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into v from public.restaurant_waitlist where id = p_id and organization_id = p_org for update;
  if v.id is null then raise exception 'غير موجود في قائمة الانتظار' using errcode = 'check_violation'; end if;
  if not app.has_branch_permission(p_org, v.branch_id, 'restaurant.waitlist.manage') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v.status not in ('waiting', 'notified') then raise exception 'تم إغلاق هذا الطلب بالفعل' using errcode = 'check_violation'; end if;
  v_old_table := v.table_id;

  if p_action in ('assign', 'seat') and p_table is not null then
    v_t := app.restaurant_table_check(p_org, p_table);
    if v_t.branch_id <> v.branch_id then raise exception 'الطاولة في فرع آخر' using errcode = 'check_violation'; end if;
    if v_t.merged_into is not null then raise exception 'الطاولة مدموجة مع طاولة أخرى' using errcode = 'check_violation'; end if;
    if v_t.status in ('occupied', 'waiting_payment') and p_action = 'assign' then
      raise exception 'الطاولة مشغولة الآن' using errcode = 'check_violation';
    end if;
    if exists (select 1 from public.restaurant_waitlist w
                where w.table_id = p_table and w.id <> p_id and w.status in ('waiting', 'notified')) then
      raise exception 'الطاولة محجوزة لضيف آخر' using errcode = 'check_violation';
    end if;
  end if;

  if p_action = 'assign' then
    if p_table is null then raise exception 'اختر طاولة' using errcode = '22023'; end if;
    update public.restaurant_waitlist set table_id = p_table where id = p_id;
    update public.restaurant_tables set status = 'available' where id = p_table and status = 'cleaning';
    update public.restaurant_tables set status = 'reserved' where id = p_table and status = 'available';
  elsif p_action = 'notify' then
    update public.restaurant_waitlist set status = 'notified', notified_at = now() where id = p_id;
  elsif p_action = 'seat' then
    if coalesce(p_table, v.table_id) is null then raise exception 'اختر طاولة' using errcode = '22023'; end if;
    update public.restaurant_waitlist
       set status = 'seated', seated_at = now(), closed_at = now(), table_id = coalesce(p_table, v.table_id)
     where id = p_id;
    perform app.restaurant_table_occupy(coalesce(p_table, v.table_id));
  elsif p_action in ('cancel', 'no_show') then
    update public.restaurant_waitlist
       set status = case when p_action = 'cancel' then 'cancelled' else 'no_show' end, closed_at = now()
     where id = p_id;
  else
    raise exception 'إجراء غير معروف' using errcode = '22023';
  end if;

  -- A hold that moved or ended frees the table it was holding.
  if v_old_table is not null and (p_action in ('cancel', 'no_show') or (p_action in ('assign', 'seat') and p_table is distinct from v_old_table and p_table is not null)) then
    update public.restaurant_tables set status = 'available' where id = v_old_table and status = 'reserved';
  end if;

  insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, v.branch_id, auth.uid(), 'restaurant.waitlist.' || p_action, 'restaurant_waitlist', p_id::text,
          jsonb_build_object('table', coalesce(p_table, v.table_id)));
end;
$$;

-- ---------------------------------------------------------------------------
-- Stations: timer thresholds (managers)
-- ---------------------------------------------------------------------------
create or replace function public.restaurant_station_timers_save(p_org uuid, p_station uuid, p_warn int, p_late int)
returns void language plpgsql security definer set search_path = '' as $$
declare v_branch uuid;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select branch_id into v_branch from public.restaurant_stations where id = p_station and organization_id = p_org;
  if v_branch is null then raise exception 'المحطة غير موجودة' using errcode = 'check_violation'; end if;
  if not app.has_branch_permission(p_org, v_branch, 'restaurant.table.manage') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if p_warn is null or p_late is null or p_warn < 1 or p_late <= p_warn or p_late > 480 then
    raise exception 'وقت التنبيه يجب أن يكون أقل من وقت التأخير' using errcode = '22023';
  end if;
  update public.restaurant_stations set warn_after_min = p_warn, late_after_min = p_late where id = p_station;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'app.restaurant_table_occupy(uuid)', 'app.restaurant_table_primary(uuid)', 'app.restaurant_release_merged()',
    'app.restaurant_prep_on_status()', 'app.restaurant_table_check(uuid, uuid)', 'app.restaurant_keep_table_busy()',
    'app.restaurant_wait_estimate(uuid, integer, uuid)',
    'app.restaurant_open_order_statuses()', 'app.restaurant_status_rank(text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;

  foreach f in array array[
    'public.approval_grant(uuid, uuid, text, uuid, numeric, uuid, text)',
    'public.restaurant_kds_bump(uuid, uuid[], text)',
    'public.restaurant_kitchen_analytics(uuid, uuid, integer)',
    'public.restaurant_floor_layout_save(uuid, uuid, jsonb)',
    'public.restaurant_table_transfer(uuid, uuid, uuid, uuid)',
    'public.restaurant_table_merge(uuid, uuid, uuid[])',
    'public.restaurant_table_unmerge(uuid, uuid)',
    'public.restaurant_check_split(uuid, uuid, jsonb)',
    'public.restaurant_order_item_set_seat(uuid, uuid[], integer)',
    'public.restaurant_waitlist_estimate(uuid, uuid, integer)',
    'public.restaurant_waitlist_add(uuid, uuid, text, text, integer, text, timestamptz, text)',
    'public.restaurant_waitlist_action(uuid, uuid, text, uuid)',
    'public.restaurant_station_timers_save(uuid, uuid, integer, integer)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
