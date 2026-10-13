-- ---------------------------------------------------------------------------
-- 0094: stock tracking for menu items + internal preparation notes.
--
-- 1. restaurant_products.prep_notes — recipe / preparation specs for the
--    kitchen and bar. The public menu functions all select explicit columns
--    (never the whole row), so this column is unreachable from any guest
--    surface; staff read it through tenant RLS only.
--
-- 2. Stock. restaurant_products.track_inventory switches tracking on for an
--    item; restaurant_branch_stock holds the quantity PER BRANCH (one branch
--    selling out never affects another, same as availability).
--      * placing: a line asking for more than is in stock is refused
--        (BEFORE INSERT on the order line) — this is what makes ordering
--        impossible for a sold-out item even if a page is stale.
--      * confirming an order (new → confirmed) takes its quantities out of
--        stock; cancelling an order that had been confirmed puts them back.
--      * reaching zero marks every variant of the item unavailable at that
--        branch (the existing 86 mechanism, note 'out_of_stock'), so every
--        menu already renders it as sold out; restocking lifts exactly those
--        rows and never a manual 86.
--    Stock never goes below zero: confirming more than is left (two guests
--    raced for the last one) empties it instead of failing the cashier.
--
-- Flavors / options need no schema change: modifier groups (0017) already
-- carry required/optional (min_select) and single/multi (max_select) rules
-- and a per-option price.
-- ---------------------------------------------------------------------------

alter table public.restaurant_products
  add column prep_notes text check (prep_notes is null or length(prep_notes) <= 2000),
  add column track_inventory boolean not null default false;

create table public.restaurant_branch_stock (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id       uuid not null references public.branches(id) on delete cascade,
  product_id      uuid not null references public.restaurant_products(id) on delete cascade,
  quantity        int not null default 0 check (quantity >= 0),
  updated_at      timestamptz not null default now(),
  updated_by      uuid references public.profiles(id),
  primary key (branch_id, product_id)
);
create index restaurant_branch_stock_org_idx on public.restaurant_branch_stock(organization_id);

alter table public.restaurant_branch_stock enable row level security;
alter table public.restaurant_branch_stock force row level security;
create policy branch_stock_select on public.restaurant_branch_stock
  for select to authenticated
  using (app.has_branch_permission(organization_id, branch_id, 'restaurant.menu.read'));
revoke all on public.restaurant_branch_stock from public, anon, authenticated;
grant select on public.restaurant_branch_stock to authenticated;

-- Sold-out ⇄ available sync for one product at one branch.
create or replace function app.restaurant_stock_sync_availability(
  p_org uuid, p_branch uuid, p_product uuid, p_quantity int
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_quantity <= 0 then
    insert into public.restaurant_branch_availability
      (organization_id, branch_id, variant_id, is_available, unavailable_note, updated_at)
    select p_org, p_branch, v.id, false, 'out_of_stock', now()
      from public.restaurant_variants v
     where v.product_id = p_product and v.deleted_at is null
    on conflict (branch_id, variant_id) do update
      set is_available = false, unavailable_note = 'out_of_stock', updated_at = now();
  else
    -- Only lifts what the stock itself closed; a manual 86 stays.
    update public.restaurant_branch_availability a
       set is_available = true, unavailable_note = null, updated_at = now()
      from public.restaurant_variants v
     where a.variant_id = v.id and v.product_id = p_product
       and a.branch_id = p_branch and a.unavailable_note = 'out_of_stock';
  end if;
end;
$$;
revoke all on function app.restaurant_stock_sync_availability(uuid, uuid, uuid, int) from public, anon, authenticated;

-- Staff sets the on-hand quantity (and turns tracking on/off) for one item.
create or replace function public.restaurant_set_stock(
  p_org uuid, p_branch uuid, p_product uuid, p_track boolean, p_quantity int
) returns void
language plpgsql security definer set search_path = '' as $$
declare v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not app.has_branch_permission(p_org, p_branch, 'restaurant.menu.manage') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if p_quantity is null or p_quantity < 0 or p_quantity > 1000000 then
    raise exception 'invalid quantity' using errcode = 'check_violation';
  end if;
  if not exists (select 1 from public.restaurant_products
                  where id = p_product and organization_id = p_org and deleted_at is null) then
    raise exception 'product not found' using errcode = 'check_violation';
  end if;

  update public.restaurant_products set track_inventory = p_track
   where id = p_product and organization_id = p_org;

  if p_track then
    insert into public.restaurant_branch_stock
      (organization_id, branch_id, product_id, quantity, updated_by, updated_at)
    values (p_org, p_branch, p_product, p_quantity, v_user, now())
    on conflict (branch_id, product_id) do update
      set quantity = excluded.quantity, updated_by = excluded.updated_by, updated_at = now();
    perform app.restaurant_stock_sync_availability(p_org, p_branch, p_product, p_quantity);
  else
    -- Tracking off: a sold-out closure made by stock no longer applies.
    perform app.restaurant_stock_sync_availability(p_org, p_branch, p_product, 1);
  end if;
end;
$$;
revoke all on function public.restaurant_set_stock(uuid, uuid, uuid, boolean, int) from public, anon;
grant execute on function public.restaurant_set_stock(uuid, uuid, uuid, boolean, int) to authenticated;

-- Refuse a line that asks for more than is in stock.
create or replace function app.restaurant_stock_guard_line()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_product uuid;
  v_branch  uuid;
  v_stock   int;
  v_already numeric;
begin
  if new.variant_id is null then
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
revoke all on function app.restaurant_stock_guard_line() from public, anon, authenticated;
create trigger restaurant_order_items_stock_guard
  before insert on public.restaurant_order_items
  for each row execute function app.restaurant_stock_guard_line();

-- Take stock out when an order is confirmed; put it back if it is cancelled
-- after having been confirmed.
create or replace function app.restaurant_stock_on_status()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  r record;
  v_sign int;
  v_qty  int;
begin
  if new.status = old.status then
    return new;
  end if;
  if new.status = 'confirmed' and old.status = 'new' then
    v_sign := -1;
  elsif new.status = 'cancelled' and old.status in ('confirmed', 'preparing', 'ready', 'served') then
    v_sign := 1;
  else
    return new;
  end if;

  for r in
    select p.id as product_id, sum(i.quantity)::int as qty
      from public.restaurant_order_items i
      join public.restaurant_variants v on v.id = i.variant_id
      join public.restaurant_products p on p.id = v.product_id
     where i.order_id = new.id and p.track_inventory
     group by p.id
  loop
    update public.restaurant_branch_stock
       set quantity = greatest(quantity + v_sign * r.qty, 0), updated_at = now()
     where branch_id = new.branch_id and product_id = r.product_id
     returning quantity into v_qty;
    if found then
      perform app.restaurant_stock_sync_availability(new.organization_id, new.branch_id, r.product_id, v_qty);
    end if;
  end loop;
  return new;
end;
$$;
revoke all on function app.restaurant_stock_on_status() from public, anon, authenticated;
create trigger restaurant_orders_stock_on_status
  after update of status on public.restaurant_orders
  for each row execute function app.restaurant_stock_on_status();
