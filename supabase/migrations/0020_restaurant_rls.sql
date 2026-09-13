-- =============================================================================
-- LOCAL BASIC — 0020 Restaurant RLS and grants
--
-- Same rules as Core: RLS enabled and forced everywhere, anon holds no
-- privilege on any table, and every policy is self-contained on
-- organization_id / branch_id rather than reaching through joins.
--
-- Guests never read these tables. The public menu and order placement go
-- through the narrow SECURITY DEFINER functions in 0021.
-- =============================================================================

do $$
declare t text;
begin
  foreach t in array array[
    'restaurant_sections', 'restaurant_tables', 'restaurant_categories',
    'restaurant_products', 'restaurant_variants', 'restaurant_modifier_groups',
    'restaurant_modifiers', 'restaurant_branch_availability',
    'restaurant_orders', 'restaurant_order_items', 'restaurant_order_item_modifiers'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Floor plan — branch scoped.
-- ---------------------------------------------------------------------------
create policy sections_select on public.restaurant_sections for select to authenticated
  using (app.has_branch_permission(organization_id, branch_id, 'restaurant.table.read'));

create policy sections_write on public.restaurant_sections for all to authenticated
  using (app.has_branch_permission(organization_id, branch_id, 'restaurant.table.manage'))
  with check (app.has_branch_permission(organization_id, branch_id, 'restaurant.table.manage'));

create policy tables_select on public.restaurant_tables for select to authenticated
  using (app.has_branch_permission(organization_id, branch_id, 'restaurant.table.read')
         and deleted_at is null);

create policy tables_insert on public.restaurant_tables for insert to authenticated
  with check (app.has_branch_permission(organization_id, branch_id, 'restaurant.table.manage'));

-- A waiter may move a table between states without being able to create,
-- rename or delete one, so `restaurant.table.status` is enough to update.
create policy tables_update on public.restaurant_tables for update to authenticated
  using (app.has_branch_permission(organization_id, branch_id, 'restaurant.table.status')
      or app.has_branch_permission(organization_id, branch_id, 'restaurant.table.manage'))
  with check (app.has_branch_permission(organization_id, branch_id, 'restaurant.table.status')
           or app.has_branch_permission(organization_id, branch_id, 'restaurant.table.manage'));

-- ---------------------------------------------------------------------------
-- Menu — organization wide, since the menu is not owned by one branch.
-- ---------------------------------------------------------------------------
create policy menu_categories_select on public.restaurant_categories for select to authenticated
  using (app.has_permission(organization_id, 'restaurant.menu.read'));
create policy menu_categories_write on public.restaurant_categories for all to authenticated
  using (app.has_permission(organization_id, 'restaurant.menu.manage'))
  with check (app.has_permission(organization_id, 'restaurant.menu.manage'));

create policy menu_products_select on public.restaurant_products for select to authenticated
  using (app.has_permission(organization_id, 'restaurant.menu.read') and deleted_at is null);
create policy menu_products_insert on public.restaurant_products for insert to authenticated
  with check (app.has_permission(organization_id, 'restaurant.menu.manage'));
create policy menu_products_update on public.restaurant_products for update to authenticated
  using (app.has_permission(organization_id, 'restaurant.menu.manage'))
  with check (app.has_permission(organization_id, 'restaurant.menu.manage'));

create policy menu_variants_select on public.restaurant_variants for select to authenticated
  using (app.has_permission(organization_id, 'restaurant.menu.read') and deleted_at is null);
create policy menu_variants_insert on public.restaurant_variants for insert to authenticated
  with check (app.has_permission(organization_id, 'restaurant.menu.manage'));
create policy menu_variants_update on public.restaurant_variants for update to authenticated
  using (app.has_permission(organization_id, 'restaurant.menu.manage'))
  with check (app.has_permission(organization_id, 'restaurant.menu.manage'));

create policy modifier_groups_select on public.restaurant_modifier_groups for select to authenticated
  using (app.has_permission(organization_id, 'restaurant.menu.read'));
create policy modifier_groups_write on public.restaurant_modifier_groups for all to authenticated
  using (app.has_permission(organization_id, 'restaurant.menu.manage'))
  with check (app.has_permission(organization_id, 'restaurant.menu.manage'));

create policy modifiers_select on public.restaurant_modifiers for select to authenticated
  using (app.has_permission(organization_id, 'restaurant.menu.read'));
create policy modifiers_write on public.restaurant_modifiers for all to authenticated
  using (app.has_permission(organization_id, 'restaurant.menu.manage'))
  with check (app.has_permission(organization_id, 'restaurant.menu.manage'));

-- Marking a dish unavailable is a floor decision, not a menu edit, so the
-- kitchen or a manager can do it with either permission.
create policy availability_select on public.restaurant_branch_availability
  for select to authenticated
  using (app.has_branch_permission(organization_id, branch_id, 'restaurant.menu.read'));
create policy availability_write on public.restaurant_branch_availability
  for all to authenticated
  using (app.has_branch_permission(organization_id, branch_id, 'restaurant.menu.manage')
      or app.has_branch_permission(organization_id, branch_id, 'restaurant.kitchen.use'))
  with check (app.has_branch_permission(organization_id, branch_id, 'restaurant.menu.manage')
           or app.has_branch_permission(organization_id, branch_id, 'restaurant.kitchen.use'));

-- ---------------------------------------------------------------------------
-- Orders.
--
-- There is no DELETE policy: an order is cancelled, never erased. Creation and
-- status changes go through the SECURITY DEFINER functions in 0021, which
-- check the specific permission each transition needs — the update policy here
-- is the outer fence, not the whole gate.
-- ---------------------------------------------------------------------------
create policy orders_select on public.restaurant_orders for select to authenticated
  using (app.has_branch_permission(organization_id, branch_id, 'restaurant.order.read'));

create policy orders_insert on public.restaurant_orders for insert to authenticated
  with check (app.has_branch_permission(organization_id, branch_id, 'restaurant.order.create'));

create policy orders_update on public.restaurant_orders for update to authenticated
  using (
    app.has_branch_permission(organization_id, branch_id, 'restaurant.order.update')
    or app.has_branch_permission(organization_id, branch_id, 'restaurant.kitchen.use')
    or app.has_branch_permission(organization_id, branch_id, 'restaurant.service.use')
    or app.has_branch_permission(organization_id, branch_id, 'restaurant.pos.use')
  )
  with check (
    app.has_branch_permission(organization_id, branch_id, 'restaurant.order.update')
    or app.has_branch_permission(organization_id, branch_id, 'restaurant.kitchen.use')
    or app.has_branch_permission(organization_id, branch_id, 'restaurant.service.use')
    or app.has_branch_permission(organization_id, branch_id, 'restaurant.pos.use')
  );

create policy order_items_select on public.restaurant_order_items for select to authenticated
  using (exists (
    select 1 from public.restaurant_orders o
    where o.id = order_id
      and app.has_branch_permission(o.organization_id, o.branch_id, 'restaurant.order.read')
  ));

-- Items may only be changed while the order has not yet been confirmed.
create policy order_items_write on public.restaurant_order_items for all to authenticated
  using (exists (
    select 1 from public.restaurant_orders o
    where o.id = order_id and o.status = 'new'
      and app.has_branch_permission(o.organization_id, o.branch_id, 'restaurant.order.update')
  ))
  with check (exists (
    select 1 from public.restaurant_orders o
    where o.id = order_id and o.status = 'new'
      and app.has_branch_permission(o.organization_id, o.branch_id, 'restaurant.order.update')
  ));

create policy order_item_modifiers_select on public.restaurant_order_item_modifiers
  for select to authenticated
  using (exists (
    select 1
    from public.restaurant_order_items i
    join public.restaurant_orders o on o.id = i.order_id
    where i.id = order_item_id
      and app.has_branch_permission(o.organization_id, o.branch_id, 'restaurant.order.read')
  ));

create policy order_item_modifiers_write on public.restaurant_order_item_modifiers
  for all to authenticated
  using (exists (
    select 1
    from public.restaurant_order_items i
    join public.restaurant_orders o on o.id = i.order_id
    where i.id = order_item_id and o.status = 'new'
      and app.has_branch_permission(o.organization_id, o.branch_id, 'restaurant.order.update')
  ))
  with check (exists (
    select 1
    from public.restaurant_order_items i
    join public.restaurant_orders o on o.id = i.order_id
    where i.id = order_item_id and o.status = 'new'
      and app.has_branch_permission(o.organization_id, o.branch_id, 'restaurant.order.update')
  ));

-- ---------------------------------------------------------------------------
-- Grants. Orders are never hard-deleted; the menu is soft-deleted.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'restaurant_sections', 'restaurant_tables', 'restaurant_categories',
    'restaurant_products', 'restaurant_variants', 'restaurant_modifier_groups',
    'restaurant_modifiers', 'restaurant_branch_availability',
    'restaurant_orders', 'restaurant_order_items', 'restaurant_order_item_modifiers'
  ] loop
    execute format('grant select, insert, update on public.%I to authenticated', t);
  end loop;
end $$;

grant delete on
  public.restaurant_sections, public.restaurant_modifier_groups,
  public.restaurant_modifiers, public.restaurant_branch_availability,
  public.restaurant_order_items, public.restaurant_order_item_modifiers
to authenticated;

revoke delete on public.restaurant_orders from authenticated;
revoke delete on public.restaurant_tables from authenticated;
revoke delete on public.restaurant_products from authenticated;
revoke delete on public.restaurant_variants from authenticated;
revoke delete on public.restaurant_categories from authenticated;
