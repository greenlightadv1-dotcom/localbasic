-- =============================================================================
-- LOCAL BASIC — 0019 Restaurant permissions and role templates
--
-- Kitchen and waiter roles are deliberately narrow. Neither holds any
-- financial permission by default: no invoice, payment, treasury or report
-- access. Granting one is an explicit, audited change by an owner or admin.
-- =============================================================================

insert into public.permissions (key, group_key, module_key, description, is_elevated) values
  ('restaurant.menu.read',     'restaurant', 'restaurant', 'View the menu',                          false),
  ('restaurant.menu.manage',   'restaurant', 'restaurant', 'Create and edit menu items and prices',  false),
  ('restaurant.table.read',    'restaurant', 'restaurant', 'View tables and the floor plan',         false),
  ('restaurant.table.manage',  'restaurant', 'restaurant', 'Create tables, sections and QR codes',   false),
  ('restaurant.table.status',  'restaurant', 'restaurant', 'Change a table''s status',               false),
  ('restaurant.order.read',    'restaurant', 'restaurant', 'View orders',                            false),
  ('restaurant.order.create',  'restaurant', 'restaurant', 'Create orders',                          false),
  ('restaurant.order.update',  'restaurant', 'restaurant', 'Edit order items before confirmation',   false),
  ('restaurant.order.cancel',  'restaurant', 'restaurant', 'Cancel an order',                        false),
  ('restaurant.kitchen.use',   'restaurant', 'restaurant', 'Use the kitchen display and advance preparation', false),
  ('restaurant.service.use',   'restaurant', 'restaurant', 'Use the waiter view and mark orders served',      false),
  ('restaurant.pos.use',       'restaurant', 'restaurant', 'Use the cashier screen and take payment',         false),
  ('restaurant.pos.discount',  'restaurant', 'restaurant', 'Apply manual discounts to an order',              false)
on conflict (key) do update
  set description = excluded.description,
      group_key   = excluded.group_key,
      module_key  = excluded.module_key;

-- ---------------------------------------------------------------------------
-- Restaurant-specific role templates.
-- ---------------------------------------------------------------------------
insert into public.roles (organization_id, key, name_ar, name_en, description, is_system, is_owner, module_key) values
  (null, 'cashier', 'كاشير', 'Cashier',
   'Takes orders and payment at the till; no menu or staff management', true, false, 'restaurant'),
  (null, 'kitchen', 'المطبخ', 'Kitchen',
   'Kitchen display only — no financial access', true, false, 'restaurant'),
  (null, 'waiter',  'كابتن / ويتر', 'Waiter',
   'Floor service: tables and serving orders; no financial access', true, false, 'restaurant')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Template permission sets.
-- ---------------------------------------------------------------------------
with tpl as (
  select id, key, coalesce(module_key, '') as module_key
  from public.roles where organization_id is null
),
grants(role_key, module_key, permission_key) as (values
  -- Core templates gain the restaurant permissions appropriate to them.
  ('admin', '', 'restaurant.menu.read'),   ('admin', '', 'restaurant.menu.manage'),
  ('admin', '', 'restaurant.table.read'),  ('admin', '', 'restaurant.table.manage'),
  ('admin', '', 'restaurant.table.status'),
  ('admin', '', 'restaurant.order.read'),  ('admin', '', 'restaurant.order.create'),
  ('admin', '', 'restaurant.order.update'),('admin', '', 'restaurant.order.cancel'),
  ('admin', '', 'restaurant.kitchen.use'), ('admin', '', 'restaurant.service.use'),
  ('admin', '', 'restaurant.pos.use'),     ('admin', '', 'restaurant.pos.discount'),

  ('manager', '', 'restaurant.menu.read'),   ('manager', '', 'restaurant.menu.manage'),
  ('manager', '', 'restaurant.table.read'),  ('manager', '', 'restaurant.table.manage'),
  ('manager', '', 'restaurant.table.status'),
  ('manager', '', 'restaurant.order.read'),  ('manager', '', 'restaurant.order.create'),
  ('manager', '', 'restaurant.order.update'),('manager', '', 'restaurant.order.cancel'),
  ('manager', '', 'restaurant.kitchen.use'), ('manager', '', 'restaurant.service.use'),
  ('manager', '', 'restaurant.pos.use'),     ('manager', '', 'restaurant.pos.discount'),

  -- Reads the money, touches no operations.
  ('accountant', '', 'restaurant.order.read'), ('accountant', '', 'restaurant.menu.read'),

  ('staff', '', 'restaurant.menu.read'), ('staff', '', 'restaurant.table.read'),

  -- Restaurant cashier: sells and takes money. No menu management, no staff
  -- management, and no manual discounts unless separately granted.
  ('cashier', 'restaurant', 'restaurant.menu.read'),
  ('cashier', 'restaurant', 'restaurant.table.read'),
  ('cashier', 'restaurant', 'restaurant.table.status'),
  ('cashier', 'restaurant', 'restaurant.order.read'),
  ('cashier', 'restaurant', 'restaurant.order.create'),
  ('cashier', 'restaurant', 'restaurant.order.update'),
  ('cashier', 'restaurant', 'restaurant.pos.use'),
  ('cashier', 'restaurant', 'customer.read'),
  ('cashier', 'restaurant', 'customer.create'),
  ('cashier', 'restaurant', 'invoice.read'),
  ('cashier', 'restaurant', 'invoice.create'),
  ('cashier', 'restaurant', 'payment.read'),
  ('cashier', 'restaurant', 'payment.create'),
  ('cashier', 'restaurant', 'treasury.read'),
  ('cashier', 'restaurant', 'treasury.create'),

  -- Kitchen: the display and nothing else. Deliberately no invoice.*,
  -- payment.*, treasury.*, report.* or member.* — see the tests.
  ('kitchen', 'restaurant', 'restaurant.menu.read'),
  ('kitchen', 'restaurant', 'restaurant.order.read'),
  ('kitchen', 'restaurant', 'restaurant.kitchen.use'),

  -- Waiter: the floor. Can serve and seat, cannot take money.
  ('waiter', 'restaurant', 'restaurant.menu.read'),
  ('waiter', 'restaurant', 'restaurant.table.read'),
  ('waiter', 'restaurant', 'restaurant.table.status'),
  ('waiter', 'restaurant', 'restaurant.order.read'),
  ('waiter', 'restaurant', 'restaurant.order.create'),
  ('waiter', 'restaurant', 'restaurant.order.update'),
  ('waiter', 'restaurant', 'restaurant.service.use')
)
insert into public.role_permissions (role_id, permission_key)
select tpl.id, g.permission_key
from grants g
join tpl on tpl.key = g.role_key and tpl.module_key = g.module_key
on conflict do nothing;

-- Organizations provisioned before this migration keep their owner role in
-- sync with the catalog, so a new permission is never locked away from them.
insert into public.role_permissions (role_id, permission_key)
select r.id, p.key
from public.roles r
cross join public.permissions p
where r.is_owner and r.organization_id is not null
on conflict do nothing;
