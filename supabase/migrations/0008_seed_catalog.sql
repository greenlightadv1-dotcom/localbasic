-- =============================================================================
-- LOCAL BASIC — 0008 Platform catalog seed
-- permissions, role templates, template permission sets, plans
-- Idempotent: safe to re-run.
-- =============================================================================

insert into public.permissions (key, group_key, module_key, description, is_elevated) values
  -- Core: organization
  ('organization.manage', 'organization', null, 'Edit organization profile and enabled modules', false),
  ('billing.manage',      'organization', null, 'Manage subscription and billing',               true),
  ('branch.create',       'organization', null, 'Create branches',                               false),
  ('branch.manage',       'organization', null, 'Edit and deactivate branches',                  false),
  ('settings.manage',     'organization', null, 'Edit organization and branch settings',         false),
  ('branding.manage',     'organization', null, 'Edit logo, colors and contact details',         false),
  ('audit.read',          'organization', null, 'View the audit log',                            false),
  -- Core: people
  ('member.read',         'people', null, 'View members and their roles',                        false),
  ('member.manage',       'people', null, 'Invite, suspend and assign roles to members',         true),
  ('role.manage',         'people', null, 'Create roles and change their permissions',           true),
  -- Core: customers
  ('customer.read',       'customers', null, 'View customers',                                   false),
  ('customer.create',     'customers', null, 'Create customers',                                 false),
  ('customer.update',     'customers', null, 'Edit customers',                                   false),
  -- Core: money
  ('invoice.read',        'money', null, 'View invoices',                                        false),
  ('invoice.create',      'money', null, 'Create invoices',                                      false),
  ('invoice.update',      'money', null, 'Edit draft invoices',                                  false),
  ('invoice.void',        'money', null, 'Void an issued invoice',                               false),
  ('payment.read',        'money', null, 'View payments',                                        false),
  ('payment.create',      'money', null, 'Record payments',                                      false),
  ('payment.refund',      'money', null, 'Issue refunds',                                        false),
  ('treasury.read',       'money', null, 'View treasury accounts and balances',                  false),
  ('treasury.create',     'money', null, 'Record treasury movements and expenses',               false),
  ('treasury.manage',     'money', null, 'Create and edit treasury accounts',                    false),
  ('report.read',         'money', null, 'View reports and analytics',                           false),
  -- Core: links
  ('notification.read',   'system', null, 'View organization notifications',                     false),
  ('publiclink.read',     'system', null, 'View public links and QR codes',                      false),
  ('publiclink.manage',   'system', null, 'Create, assign and revoke public links and QR codes', false),
  -- Retail module
  ('retail.product.read',    'retail', 'retail', 'View products, variants and prices',       false),
  ('retail.product.manage',  'retail', 'retail', 'Create and edit products and variants',    false),
  ('retail.inventory.read',  'retail', 'retail', 'View stock levels and movements',          false),
  ('retail.inventory.adjust','retail', 'retail', 'Adjust stock and record damage/transfers', false),
  ('retail.supplier.manage', 'retail', 'retail', 'Manage suppliers',                         false),
  ('retail.purchase.read',   'retail', 'retail', 'View purchase orders',                     false),
  ('retail.purchase.manage', 'retail', 'retail', 'Create and receive purchase orders',       false),
  ('retail.pos.use',         'retail', 'retail', 'Operate the point of sale',                false),
  ('retail.pos.discount',    'retail', 'retail', 'Apply manual discounts at the POS',        false),
  ('retail.order.read',      'retail', 'retail', 'View online store orders',                 false),
  ('retail.order.manage',    'retail', 'retail', 'Fulfil, ship and cancel online orders',    false),
  ('retail.store.manage',    'retail', 'retail', 'Configure the online storefront',          false)
on conflict (key) do update
  set description = excluded.description,
      group_key   = excluded.group_key,
      module_key  = excluded.module_key,
      is_elevated = excluded.is_elevated;

-- ---------------------------------------------------------------------------
-- Role templates (organization_id is null). Cloned into each organization at
-- provisioning time, after which the tenant owns and may edit them.
-- ---------------------------------------------------------------------------
insert into public.roles (organization_id, key, name_ar, name_en, description, is_system, is_owner, module_key) values
  (null, 'owner',       'المالك',        'Owner',       'Full control, including billing and ownership transfer', true, true,  null),
  (null, 'admin',       'مدير النظام',   'Admin',       'Full operational control except ownership transfer',      true, false, null),
  (null, 'manager',     'مدير فرع',      'Manager',     'Runs a branch: staff, stock, money and reports',          true, false, null),
  (null, 'accountant',  'محاسب',         'Accountant',  'Money and reports, no operational editing',               true, false, null),
  (null, 'staff',       'موظف',          'Staff',       'Baseline access: customers and read-only lists',          true, false, null),
  (null, 'cashier',     'كاشير',         'Cashier',     'Point of sale, payments and returns',                     true, false, 'retail'),
  (null, 'storekeeper', 'أمين المخزن',   'Storekeeper', 'Stock, purchases and suppliers; no financial access',     true, false, 'retail')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Template permission sets.
-- Owner is intentionally absent here: it always receives the complete
-- permission catalog at provisioning time, and it cannot be edited.
-- ---------------------------------------------------------------------------
with tpl as (
  select id, key from public.roles where organization_id is null
),
grants(role_key, permission_key) as (values
  -- admin: everything except billing (owner-only by default)
  ('admin','organization.manage'),('admin','branch.create'),('admin','branch.manage'),
  ('admin','settings.manage'),('admin','branding.manage'),('admin','audit.read'),
  ('admin','member.read'),('admin','member.manage'),('admin','role.manage'),
  ('admin','customer.read'),('admin','customer.create'),('admin','customer.update'),
  ('admin','invoice.read'),('admin','invoice.create'),('admin','invoice.update'),('admin','invoice.void'),
  ('admin','payment.read'),('admin','payment.create'),('admin','payment.refund'),
  ('admin','treasury.read'),('admin','treasury.create'),('admin','treasury.manage'),
  ('admin','report.read'),('admin','notification.read'),
  ('admin','publiclink.read'),('admin','publiclink.manage'),
  ('admin','retail.product.read'),('admin','retail.product.manage'),
  ('admin','retail.inventory.read'),('admin','retail.inventory.adjust'),
  ('admin','retail.supplier.manage'),('admin','retail.purchase.read'),('admin','retail.purchase.manage'),
  ('admin','retail.pos.use'),('admin','retail.pos.discount'),
  ('admin','retail.order.read'),('admin','retail.order.manage'),('admin','retail.store.manage'),

  -- manager: runs a branch, cannot restructure the organization
  ('manager','branch.manage'),('manager','settings.manage'),('manager','audit.read'),
  ('manager','member.read'),
  ('manager','customer.read'),('manager','customer.create'),('manager','customer.update'),
  ('manager','invoice.read'),('manager','invoice.create'),('manager','invoice.update'),('manager','invoice.void'),
  ('manager','payment.read'),('manager','payment.create'),('manager','payment.refund'),
  ('manager','treasury.read'),('manager','treasury.create'),
  ('manager','report.read'),('manager','notification.read'),
  ('manager','publiclink.read'),('manager','publiclink.manage'),
  ('manager','retail.product.read'),('manager','retail.product.manage'),
  ('manager','retail.inventory.read'),('manager','retail.inventory.adjust'),
  ('manager','retail.supplier.manage'),('manager','retail.purchase.read'),('manager','retail.purchase.manage'),
  ('manager','retail.pos.use'),('manager','retail.pos.discount'),
  ('manager','retail.order.read'),('manager','retail.order.manage'),

  -- accountant: sees the money, touches no operations
  ('accountant','customer.read'),
  ('accountant','invoice.read'),('accountant','payment.read'),
  ('accountant','treasury.read'),('accountant','treasury.create'),('accountant','treasury.manage'),
  ('accountant','report.read'),('accountant','audit.read'),
  ('accountant','retail.product.read'),('accountant','retail.inventory.read'),
  ('accountant','retail.purchase.read'),('accountant','retail.order.read'),

  -- cashier: sell and take money; no stock editing, no manual discounts
  ('cashier','customer.read'),('cashier','customer.create'),
  ('cashier','invoice.read'),('cashier','invoice.create'),
  ('cashier','payment.read'),('cashier','payment.create'),
  ('cashier','treasury.read'),
  ('cashier','retail.product.read'),('cashier','retail.inventory.read'),
  ('cashier','retail.pos.use'),

  -- storekeeper: stock and purchasing, deliberately NO financial permissions
  ('storekeeper','retail.product.read'),('storekeeper','retail.product.manage'),
  ('storekeeper','retail.inventory.read'),('storekeeper','retail.inventory.adjust'),
  ('storekeeper','retail.supplier.manage'),
  ('storekeeper','retail.purchase.read'),('storekeeper','retail.purchase.manage'),

  -- staff: the safe baseline
  ('staff','customer.read'),('staff','retail.product.read')
)
insert into public.role_permissions (role_id, permission_key)
select tpl.id, g.permission_key
from grants g join tpl on tpl.key = g.role_key
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Plans
-- ---------------------------------------------------------------------------
insert into public.plans (key, name_ar, name_en, price_cents, interval, limits, features, sort_order) values
  ('trial', 'تجريبي', 'Trial', 0, 'trial',
   '{"branches":1,"members":3,"products":100}',
   '{"online_store":true,"white_label":false,"analytics":"basic"}', 0),
  ('basic', 'أساسي', 'Basic', 49900, 'month',
   '{"branches":1,"members":5,"products":1000}',
   '{"online_store":true,"white_label":false,"analytics":"basic"}', 1),
  ('growth', 'نمو', 'Growth', 129900, 'month',
   '{"branches":5,"members":25,"products":20000}',
   '{"online_store":true,"white_label":false,"analytics":"full"}', 2),
  ('scale', 'احترافي', 'Scale', 299900, 'month',
   '{"branches":50,"members":200,"products":200000}',
   '{"online_store":true,"white_label":true,"analytics":"full"}', 3)
on conflict (key) do update
  set price_cents = excluded.price_cents,
      limits      = excluded.limits,
      features    = excluded.features;
