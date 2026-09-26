-- =============================================================================
-- LOCAL BASIC — Split the kitchen role into شيف (Chef) and باريستا (Barista)
--
-- 0071 already built the routing infrastructure: restaurant_stations.kind is
-- 'kitchen' or 'bar', restaurant_categories.default_station_kind and
-- restaurant_products.station_id decide which one a line item belongs to,
-- and restaurant_build_order_lines() snapshots station_id/station_kind onto
-- every restaurant_order_item at order-placement time. None of that changes
-- here. What was missing is the ROLE layer on top of it: one permission
-- (restaurant.kitchen.use) and one role ('kitchen' / "المطبخ") covered both
-- stations, so a chef and a barista were the same account with the same
-- screen showing both stations' tickets mixed together.
--
-- This adds a second permission (restaurant.bar.use) and a second role
-- ('barista' / "باريستا"), relabels the existing 'kitchen' role to "شيف" as
-- the chef-only counterpart, and lets either permission advance an order's
-- status — a barista finishing their drinks needs to move the order along
-- exactly as a chef finishing food does; the underlying order is still one
-- row with one status (per-station completion tracking would be a larger,
-- separate feature, not asked for here).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. The permission.
-- ---------------------------------------------------------------------------
insert into public.permissions (key, group_key, module_key, description, is_elevated)
values ('restaurant.bar.use', 'restaurant', 'restaurant', 'Use the bar/barista display and advance preparation', false)
on conflict (key) do update
  set description = excluded.description,
      group_key   = excluded.group_key,
      module_key  = excluded.module_key;

-- ---------------------------------------------------------------------------
-- 2. Relabel the existing role, everywhere it already exists.
--
-- The 'kitchen' key, its permission grants, and every existing membership
-- are untouched — only what a human reads changes, on the system template
-- (future organizations) and on every already-provisioned organization's own
-- clone of it.
-- ---------------------------------------------------------------------------
update public.roles
   set name_ar = 'شيف', name_en = 'Chef'
 where key = 'kitchen';

-- ---------------------------------------------------------------------------
-- 3. The new role's system template, plus its permission grants.
--
-- Same shape and same three supporting reads the chef role holds
-- (menu.read so the board can show product/variant names, order.read so it
-- can list tickets, table.read so a ticket's table name resolves — 0027) —
-- only the station-use permission differs.
-- ---------------------------------------------------------------------------
insert into public.roles
  (organization_id, key, name_ar, name_en, description, is_system, is_owner, module_key)
values
  (null, 'barista', 'باريستا', 'Barista', 'Bar display only — no financial access', true, false, 'restaurant')
on conflict do nothing;

insert into public.role_permissions (role_id, permission_key)
select r.id, p.key
from public.roles r
cross join (values
  ('restaurant.menu.read'),
  ('restaurant.order.read'),
  ('restaurant.table.read'),
  ('restaurant.bar.use')
) as p(key)
where r.organization_id is null and r.key = 'barista'
on conflict do nothing;

-- admin/manager already supervise the kitchen; they now supervise the bar
-- too, on the system template so every future organization inherits it.
insert into public.role_permissions (role_id, permission_key)
select r.id, 'restaurant.bar.use'
from public.roles r
where r.organization_id is null and r.key in ('admin', 'manager')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 4. Backfill EXISTING organizations — provisioning only clones templates at
--    signup, so nothing here happens automatically for a tenant that already
--    exists. Three gaps, each closed the same way 0075 closed the last one of
--    these: read what the template says, write whatever a real org's own
--    role is still missing.
-- ---------------------------------------------------------------------------

-- 4a. Every existing owner holds the entire permission catalog by design
--     (0009/0031) — a permission added after their organization was
--     provisioned is not otherwise reachable to them at all.
insert into public.role_permissions (role_id, permission_key)
select r.id, 'restaurant.bar.use'
from public.roles r
where r.organization_id is not null and r.is_owner
on conflict do nothing;

-- 4b. Existing admin/manager roles get the same grant the template above
--     now carries.
insert into public.role_permissions (role_id, permission_key)
select org_role.id, 'restaurant.bar.use'
from public.roles org_role
where org_role.organization_id is not null
  and org_role.key in ('admin', 'manager')
on conflict do nothing;

-- 4c. A 'barista' role row, for every organization that already has the
--     restaurant module enabled — the same clone provision_workspace() does
--     for a brand-new organization, run once here for tenants that signed up
--     before this role template existed.
insert into public.roles
  (organization_id, key, name_ar, name_en, description, is_system, is_owner, module_key)
select o.id, tpl.key, tpl.name_ar, tpl.name_en, tpl.description, true, false, tpl.module_key
from public.organizations o
join public.organization_modules om
  on om.organization_id = o.id and om.module_key = 'restaurant' and om.enabled
cross join (
  select key, name_ar, name_en, description, module_key
    from public.roles where organization_id is null and key = 'barista'
) tpl
where not exists (
  select 1 from public.roles existing
   where existing.organization_id = o.id and existing.key = 'barista'
)
on conflict do nothing;

-- 4d. That new org-level 'barista' role needs its own permission rows —
--     copied from the template, the same relationship every other org role
--     has with its template.
insert into public.role_permissions (role_id, permission_key)
select org_role.id, template_perm.permission_key
from public.roles org_role
join public.roles template_role
  on template_role.organization_id is null
 and template_role.is_system = true
 and template_role.key = 'barista'
join public.role_permissions template_perm
  on template_perm.role_id = template_role.id
where org_role.organization_id is not null
  and org_role.key = 'barista'
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 5. Order-status transitions: a barista finishing their station's items
--    needs to move the order the same way a chef does. restaurant_kitchen.use
--    stays the primary permission checked; restaurant.bar.use is accepted as
--    an alternate for exactly the same two transitions, never for any other
--    status (confirmed/served/completed/cancelled keep their own single
--    permission, unchanged).
-- ---------------------------------------------------------------------------
create or replace function public.restaurant_set_order_status(
  p_org      uuid,
  p_order    uuid,
  p_status   text,
  p_reason   text default null
)
returns table (out_status text)
language plpgsql security definer set search_path = '' as $$
declare
  v_user   uuid := auth.uid();
  v_order  record;
  v_needed text;
  v_ok     boolean;
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  select id, branch_id, status, table_id, total_cents, invoice_id
    into v_order
    from public.restaurant_orders
   where id = p_order and organization_id = p_org;
  if v_order.id is null then
    raise exception 'order not found' using errcode = 'check_violation';
  end if;

  -- Which permission this particular move requires.
  v_needed := case p_status
    when 'confirmed' then 'restaurant.order.update'
    when 'preparing' then 'restaurant.kitchen.use'
    when 'ready'     then 'restaurant.kitchen.use'
    when 'served'    then 'restaurant.service.use'
    when 'completed' then 'restaurant.pos.use'
    when 'cancelled' then 'restaurant.order.cancel'
    else null
  end;
  if v_needed is null then
    raise exception 'unknown order status %', p_status using errcode = '22023';
  end if;

  v_ok := app.has_branch_permission(p_org, v_order.branch_id, v_needed);
  -- The till and the floor both legitimately confirm an order they just took.
  if not v_ok and p_status = 'confirmed' then
    v_ok := app.has_branch_permission(p_org, v_order.branch_id, 'restaurant.pos.use')
         or app.has_branch_permission(p_org, v_order.branch_id, 'restaurant.service.use');
  end if;
  -- A barista holds restaurant.bar.use, not restaurant.kitchen.use — the
  -- same order-level move (there is one status per order, not one per
  -- station) is still theirs to make for an order that is (or partly is)
  -- theirs to prepare.
  if not v_ok and v_needed = 'restaurant.kitchen.use' then
    v_ok := app.has_branch_permission(p_org, v_order.branch_id, 'restaurant.bar.use');
  end if;
  if not v_ok then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  if p_status = 'cancelled' and nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'a cancellation needs a reason' using errcode = 'check_violation';
  end if;

  -- An order that has been paid cannot be cancelled; refund it through Core
  -- instead, so the money and the order never disagree.
  if p_status = 'cancelled' and v_order.invoice_id is not null then
    raise exception 'a paid order cannot be cancelled — issue a refund'
      using errcode = 'check_violation';
  end if;

  -- Completion means the money is settled.
  if p_status = 'completed' and v_order.invoice_id is null and v_order.total_cents > 0 then
    raise exception 'the order must be paid before it is completed'
      using errcode = 'check_violation';
  end if;

  update public.restaurant_orders
     set status = p_status,
         cancel_reason = case when p_status = 'cancelled' then p_reason else cancel_reason end
   where id = p_order;

  -- Free the table once the party is done or gone.
  if v_order.table_id is not null and p_status in ('completed', 'cancelled') then
    update public.restaurant_tables
       set status = 'cleaning'
     where id = v_order.table_id and status in ('occupied', 'waiting_payment');
  end if;

  insert into public.audit_logs
    (organization_id, branch_id, actor_id, action, entity_type, entity_id, before, after)
  values
    (p_org, v_order.branch_id, v_user, 'restaurant.order.status', 'restaurant_order',
     p_order::text,
     jsonb_build_object('status', v_order.status),
     jsonb_build_object('status', p_status, 'reason', p_reason));

  return query select p_status;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. RLS: the same "outer fence" defense-in-depth extension, so a barista
--    reaches the same rows a chef already could — the RPC above is still the
--    actual gate, since it is SECURITY DEFINER, but the direct-table policies
--    should not quietly disagree with it.
-- ---------------------------------------------------------------------------
drop policy if exists orders_update on public.restaurant_orders;
create policy orders_update on public.restaurant_orders for update to authenticated
  using (
    app.has_branch_permission(organization_id, branch_id, 'restaurant.order.update')
    or app.has_branch_permission(organization_id, branch_id, 'restaurant.kitchen.use')
    or app.has_branch_permission(organization_id, branch_id, 'restaurant.bar.use')
    or app.has_branch_permission(organization_id, branch_id, 'restaurant.service.use')
    or app.has_branch_permission(organization_id, branch_id, 'restaurant.pos.use')
  )
  with check (
    app.has_branch_permission(organization_id, branch_id, 'restaurant.order.update')
    or app.has_branch_permission(organization_id, branch_id, 'restaurant.kitchen.use')
    or app.has_branch_permission(organization_id, branch_id, 'restaurant.bar.use')
    or app.has_branch_permission(organization_id, branch_id, 'restaurant.service.use')
    or app.has_branch_permission(organization_id, branch_id, 'restaurant.pos.use')
  );

drop policy if exists availability_write on public.restaurant_branch_availability;
create policy availability_write on public.restaurant_branch_availability
  for all to authenticated
  using (app.has_branch_permission(organization_id, branch_id, 'restaurant.menu.manage')
      or app.has_branch_permission(organization_id, branch_id, 'restaurant.kitchen.use')
      or app.has_branch_permission(organization_id, branch_id, 'restaurant.bar.use'))
  with check (app.has_branch_permission(organization_id, branch_id, 'restaurant.menu.manage')
           or app.has_branch_permission(organization_id, branch_id, 'restaurant.kitchen.use')
           or app.has_branch_permission(organization_id, branch_id, 'restaurant.bar.use'));
