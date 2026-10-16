-- =============================================================================
-- 0106: delivery & fleet — call-center order entry, drivers, dispatch,
-- driver cash custody and commissions, and a standard order intake for web,
-- app and aggregator channels.
--
-- CALL CENTER. Staff look a caller up by phone (any format: the 9-digit
-- phone key of 0095), see their saved addresses, recent orders (to repeat
-- one) and loyalty balance, and place a delivery or pickup order for them.
-- New channel 'phone'; the order carries the guest's name and phone, so it
-- earns loyalty points exactly like an online one.
--
-- DELIVERY LIFECYCLE (restaurant_delivery_jobs, one row per delivery order):
--     pending → assigned → dispatched → in_transit → delivered
--                                   ↘ returned
-- Dispatch needs the kitchen to have finished (order 'ready') and hands the
-- order out (order → 'served', off the KDS). A return cancels the order, so
-- the 0105 per-line rules turn the food into waste — and the 0103 guard asks
-- for a manager PIN, as for any cancellation after the kitchen.
--
-- DRIVER MONEY (restaurant_driver_ledger, append-only). Two balances:
--     custody     cash the driver holds that belongs to the restaurant
--                 = change float handed out + cash collected on deliveries
--                   − cash handed back − approved shortages
--     commission  what the restaurant owes the driver
--                 = commissions earned − paid out ± approved adjustments
-- Cash is recognised in the drawer when the driver HANDS IT IN, not when the
-- customer pays the driver: settlement records each cash-on-delivery order's
-- payment through the normal restaurant_pay_order path at that moment, so the
-- treasury always matches what is physically in it. A shortage, a commission
-- payout and a commission adjustment each need a manager PIN.
--
-- COMMISSION per driver: by zone (a fixed amount per zone), a percentage of
-- the order total, or a fixed amount per delivery — booked when delivered.
--
-- INTAKE. restaurant_intake_order(key hash, payload): one documented JSON
-- shape for any external channel. Each integration has its own API key
-- (stored hashed), its own branch and its own auto-confirm switch; orders
-- are idempotent on the sender's external id and, when auto-confirmed, go
-- straight to the kitchen screens. Callable by the service role only — the
-- /api/integrations route authenticates the key, never the browser.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Permissions and roles
-- ---------------------------------------------------------------------------
insert into public.permissions (key, group_key, module_key, description, is_elevated) values
  ('restaurant.callcenter.use',      'restaurant', 'restaurant', 'Call center: look up customers and take phone orders', false),
  ('restaurant.delivery.manage',     'restaurant', 'restaurant', 'Dispatch deliveries and assign drivers',               false),
  ('restaurant.driver.use',          'restaurant', 'restaurant', 'Driver: see and update own deliveries',                false),
  ('restaurant.driver.manage',       'restaurant', 'restaurant', 'Manage drivers, delivery zones and commissions',       false),
  ('restaurant.driver.settle',       'restaurant', 'restaurant', 'Settle driver cash custody and pay commissions',       true),
  ('restaurant.integration.manage',  'restaurant', 'restaurant', 'Manage order intake integrations and API keys',        true)
on conflict (key) do update
  set description = excluded.description, group_key = excluded.group_key, module_key = excluded.module_key;

insert into public.roles (organization_id, key, name_ar, name_en, description, is_system, is_owner, module_key) values
  (null, 'driver', 'مندوب توصيل', 'Driver', 'Own deliveries only: on the way, delivered', true, false, 'restaurant')
on conflict do nothing;

with grants(role_key, permission_key) as (values
  ('driver', 'restaurant.driver.use'), ('driver', 'restaurant.order.read'),
  ('cashier', 'restaurant.callcenter.use'), ('cashier', 'restaurant.delivery.manage'),
  ('main_cashier', 'restaurant.callcenter.use'), ('main_cashier', 'restaurant.delivery.manage'),
  ('main_cashier', 'restaurant.driver.settle'),
  ('manager', 'restaurant.callcenter.use'), ('manager', 'restaurant.delivery.manage'),
  ('manager', 'restaurant.driver.manage'), ('manager', 'restaurant.driver.settle'),
  ('manager', 'restaurant.integration.manage'),
  ('admin', 'restaurant.callcenter.use'), ('admin', 'restaurant.delivery.manage'),
  ('admin', 'restaurant.driver.manage'), ('admin', 'restaurant.driver.settle'),
  ('admin', 'restaurant.integration.manage')
)
insert into public.role_permissions (role_id, permission_key)
select r.id, g.permission_key
  from grants g
  join public.roles r on r.organization_id is null and r.key = g.role_key
                     and (r.module_key is null or r.module_key = 'restaurant')
on conflict do nothing;

-- Existing restaurant organizations: the new driver role, then every org copy
-- in line with its own template (same module), and owners with the catalog.
insert into public.roles (organization_id, key, name_ar, name_en, description, is_system, is_owner, module_key)
select o.id, tpl.key, tpl.name_ar, tpl.name_en, tpl.description, true, false, tpl.module_key
  from public.organizations o
  join public.organization_modules om on om.organization_id = o.id and om.module_key = 'restaurant' and om.enabled
 cross join (select key, name_ar, name_en, description, module_key from public.roles
              where organization_id is null and key = 'driver') tpl
 where not exists (select 1 from public.roles e where e.organization_id = o.id and e.key = tpl.key)
on conflict do nothing;

insert into public.role_permissions (role_id, permission_key)
select org_role.id, tp.permission_key
  from public.roles org_role
  join public.roles tpl on tpl.organization_id is null and tpl.is_system and tpl.key = org_role.key
                       and tpl.module_key is not distinct from org_role.module_key
  join public.role_permissions tp on tp.role_id = tpl.id
 where org_role.organization_id is not null
   and (org_role.key = 'driver'
        or tp.permission_key in ('restaurant.callcenter.use', 'restaurant.delivery.manage', 'restaurant.driver.use',
                                 'restaurant.driver.manage', 'restaurant.driver.settle', 'restaurant.integration.manage'))
on conflict do nothing;

insert into public.role_permissions (role_id, permission_key)
select r.id, p.key from public.roles r cross join public.permissions p
 where r.is_owner and r.organization_id is not null
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Approvals: the actions of 0106 and 0107, in one list from now on.
-- ---------------------------------------------------------------------------
create or replace function app.approval_actions()
returns text[] language sql immutable set search_path = '' as $$
  select array['order.cancel', 'order.discount', 'inventory.adjust', 'inventory.resolve',
               'table.merge', 'check.split',
               'driver.payout', 'driver.shortage', 'driver.adjust',
               'account.adjust', 'account.overlimit', 'loyalty.adjust'];
$$;

alter table public.approval_grants drop constraint approval_grants_action_check;
alter table public.approval_grants add constraint approval_grants_action_check
  check (action = any (app.approval_actions()));

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
  if not (p_action = any (app.approval_actions())) then
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

-- ---------------------------------------------------------------------------
-- New order channels and external references
-- ---------------------------------------------------------------------------
alter table public.restaurant_orders drop constraint restaurant_orders_channel_check;
alter table public.restaurant_orders add constraint restaurant_orders_channel_check
  check (channel in ('qr', 'cashier', 'waiter', 'online', 'phone', 'aggregator'));
alter table public.restaurant_orders drop constraint restaurant_orders_online_shape;
alter table public.restaurant_orders add constraint restaurant_orders_online_shape
  check (channel not in ('online', 'phone', 'aggregator') or type in ('pickup', 'delivery'));

alter table public.restaurant_orders
  add column if not exists external_source text check (length(external_source) between 1 and 40),
  add column if not exists external_ref text check (length(external_ref) between 1 and 120),
  add column if not exists external_total_cents bigint check (external_total_cents >= 0);
create unique index if not exists restaurant_orders_external_uq
  on public.restaurant_orders(organization_id, external_source, external_ref) where external_ref is not null;

-- ---------------------------------------------------------------------------
-- Zones, drivers, jobs, the driver ledger
-- ---------------------------------------------------------------------------
create table public.restaurant_delivery_zones (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  branch_id        uuid not null references public.branches(id) on delete cascade,
  name             text not null check (length(trim(name)) between 1 and 80),
  fee_cents        bigint not null default 0 check (fee_cents between 0 and 100000000),
  -- What a driver on zone-based commission earns per delivery here.
  driver_fee_cents bigint not null default 0 check (driver_fee_cents between 0 and 100000000),
  sort_order       int not null default 0,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create unique index restaurant_delivery_zones_name_uq on public.restaurant_delivery_zones(branch_id, lower(trim(name)));

create table public.restaurant_drivers (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        uuid not null references public.organizations(id) on delete cascade,
  branch_id              uuid not null references public.branches(id) on delete cascade,
  -- A driver with a login (driver role) or an external rider without one.
  member_id              uuid references public.organization_members(id) on delete set null,
  name                   text not null check (length(trim(name)) between 1 and 80),
  phone                  text check (length(phone) <= 30),
  vehicle                text check (length(vehicle) <= 60),
  commission_mode        text not null default 'zone' check (commission_mode in ('zone', 'percent', 'fixed')),
  commission_percent_bp  int not null default 0 check (commission_percent_bp between 0 and 10000),
  commission_fixed_cents bigint not null default 0 check (commission_fixed_cents between 0 and 100000000),
  on_shift               boolean not null default false,
  is_active              boolean not null default true,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create unique index restaurant_drivers_member_uq on public.restaurant_drivers(branch_id, member_id) where member_id is not null;

create table public.restaurant_delivery_jobs (
  order_id              uuid primary key references public.restaurant_orders(id) on delete cascade,
  organization_id       uuid not null references public.organizations(id) on delete cascade,
  branch_id             uuid not null references public.branches(id) on delete cascade,
  zone_id               uuid references public.restaurant_delivery_zones(id) on delete set null,
  driver_id             uuid references public.restaurant_drivers(id) on delete set null,
  status                text not null default 'pending'
                          check (status in ('pending', 'assigned', 'dispatched', 'in_transit', 'delivered', 'returned', 'cancelled')),
  cash_to_collect_cents bigint not null default 0 check (cash_to_collect_cents >= 0),
  commission_cents      bigint not null default 0 check (commission_cents >= 0),
  assigned_at           timestamptz,
  dispatched_at         timestamptz,
  in_transit_at         timestamptz,
  delivered_at          timestamptz,
  returned_at           timestamptz,
  return_reason         text check (length(return_reason) <= 300),
  settled_at            timestamptz,
  settled_by            uuid references auth.users(id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index restaurant_delivery_jobs_branch_idx on public.restaurant_delivery_jobs(branch_id, status);
create index restaurant_delivery_jobs_driver_idx on public.restaurant_delivery_jobs(driver_id, status) where driver_id is not null;

create table public.restaurant_driver_ledger (
  id               bigint generated always as identity primary key,
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  branch_id        uuid not null references public.branches(id) on delete cascade,
  driver_id        uuid not null references public.restaurant_drivers(id) on delete cascade,
  kind             text not null check (kind in ('float_out', 'collect', 'settle', 'shortage',
                                                 'commission', 'payout', 'commission_adjust')),
  -- Positive, except a commission adjustment, which is signed.
  amount_cents     bigint not null check (amount_cents <> 0),
  order_id         uuid references public.restaurant_orders(id) on delete set null,
  note             text check (length(note) <= 300),
  actor_id         uuid,
  approved_by      uuid,
  created_at       timestamptz not null default now(),
  check (kind = 'commission_adjust' or amount_cents > 0)
);
create index restaurant_driver_ledger_driver_idx on public.restaurant_driver_ledger(driver_id, created_at desc);

create or replace function app.driver_ledger_immutable()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' and not exists (select 1 from public.restaurant_drivers where id = old.driver_id) then
    return old;  -- the driver (or the whole organization) is being removed
  end if;
  raise exception 'the driver ledger is append-only' using errcode = 'check_violation';
end;
$$;
create trigger restaurant_driver_ledger_no_update before update or delete on public.restaurant_driver_ledger
  for each row execute function app.driver_ledger_immutable();

create table public.restaurant_integrations (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  branch_id        uuid not null references public.branches(id) on delete cascade,
  name             text not null check (length(trim(name)) between 1 and 80),
  source           text not null check (source ~ '^[a-z0-9_]{2,40}$'),
  key_hash         text not null unique check (key_hash ~ '^[0-9a-f]{64}$'),
  key_prefix       text not null check (length(key_prefix) between 4 and 12),
  auto_confirm     boolean not null default true,
  is_active        boolean not null default true,
  last_used_at     timestamptz,
  created_by       uuid references auth.users(id),
  created_at       timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array['restaurant_delivery_zones', 'restaurant_drivers', 'restaurant_delivery_jobs',
                           'restaurant_driver_ledger', 'restaurant_integrations'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;

-- Who sees the fleet: dispatchers, call center, driver managers, settlers.
create or replace function app.fleet_can_read(p_org uuid, p_branch uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select app.has_branch_permission(p_org, p_branch, 'restaurant.delivery.manage')
      or app.has_branch_permission(p_org, p_branch, 'restaurant.callcenter.use')
      or app.has_branch_permission(p_org, p_branch, 'restaurant.driver.manage')
      or app.has_branch_permission(p_org, p_branch, 'restaurant.driver.settle');
$$;

-- A driver with a login: is this row theirs?
create or replace function app.is_my_driver(p_driver uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.restaurant_drivers d
                   join public.organization_members m on m.id = d.member_id
                  where d.id = p_driver and m.user_id = auth.uid() and m.status = 'active');
$$;

create policy delivery_zones_select on public.restaurant_delivery_zones for select to authenticated
  using (app.fleet_can_read(organization_id, branch_id));
create policy drivers_select on public.restaurant_drivers for select to authenticated
  using (app.fleet_can_read(organization_id, branch_id) or app.is_my_driver(id));
create policy delivery_jobs_select on public.restaurant_delivery_jobs for select to authenticated
  using (app.fleet_can_read(organization_id, branch_id) or (driver_id is not null and app.is_my_driver(driver_id)));
-- Driver money: whoever settles or manages drivers, and the driver themself.
create policy driver_ledger_select on public.restaurant_driver_ledger for select to authenticated
  using (app.has_branch_permission(organization_id, branch_id, 'restaurant.driver.settle')
         or app.has_branch_permission(organization_id, branch_id, 'restaurant.driver.manage')
         or app.is_my_driver(driver_id));
create policy integrations_select on public.restaurant_integrations for select to authenticated
  using (app.has_branch_permission(organization_id, branch_id, 'restaurant.integration.manage'));

-- A driver reads the orders assigned to them (to see the address and items).
create policy orders_driver_select on public.restaurant_orders for select to authenticated
  using (exists (select 1 from public.restaurant_delivery_jobs j
                  where j.order_id = id and j.driver_id is not null and app.is_my_driver(j.driver_id)));
create policy order_deliveries_driver_select on public.restaurant_order_deliveries for select to authenticated
  using (exists (select 1 from public.restaurant_delivery_jobs j
                  where j.order_id = restaurant_order_deliveries.order_id and j.driver_id is not null
                    and app.is_my_driver(j.driver_id)));

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.restaurant_delivery_jobs;
  end if;
end $$;

-- Balances, from the ledger.
create or replace function app.driver_balances(p_driver uuid)
returns table (out_custody bigint, out_commission bigint)
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(case kind when 'float_out' then amount_cents when 'collect' then amount_cents
                                when 'settle' then -amount_cents when 'shortage' then -amount_cents else 0 end), 0)::bigint,
         coalesce(sum(case kind when 'commission' then amount_cents when 'payout' then -amount_cents
                                when 'commission_adjust' then amount_cents else 0 end), 0)::bigint
    from public.restaurant_driver_ledger where driver_id = p_driver;
$$;

-- The order's invoice, created from its lines if it has none yet — the same
-- invoice restaurant_pay_order (0054) would issue, for paths that settle an
-- order without taking cash at the till (an aggregator's prepaid order, a
-- house account in 0107).
create or replace function app.restaurant_issue_invoice(p_order uuid, p_customer uuid default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_order   record;
  v_invoice uuid;
  v_number  text;
begin
  select o.id, o.organization_id, o.branch_id, o.invoice_id, o.customer_id, o.number, o.currency,
         o.subtotal_cents, o.tax_cents, o.discount_cents, o.total_cents
    into v_order from public.restaurant_orders o where o.id = p_order for update;
  if v_order.invoice_id is not null then return v_order.invoice_id; end if;

  v_number := app.next_document_number(v_order.organization_id, v_order.branch_id, 'invoice');
  insert into public.invoices
    (organization_id, branch_id, number, customer_id, status, source, currency,
     subtotal_cents, discount_cents, tax_cents, total_cents, notes, issued_at, created_by)
  values
    (v_order.organization_id, v_order.branch_id, v_number, coalesce(p_customer, v_order.customer_id), 'issued',
     'restaurant', v_order.currency, v_order.subtotal_cents + coalesce((select delivery_fee_cents from public.restaurant_orders where id = p_order), 0),
     v_order.discount_cents, v_order.tax_cents, v_order.total_cents,
     'طلب رقم ' || v_order.number, now(), auth.uid())
  returning id into v_invoice;

  insert into public.invoice_items
    (invoice_id, organization_id, ref_type, ref_id, description, quantity,
     unit_price_cents, discount_cents, tax_rate_bp, total_cents, position)
  select v_invoice, v_order.organization_id, 'restaurant_variant', i.variant_id,
         i.product_name || case when i.variant_name = 'default' then '' else ' — ' || i.variant_name end,
         i.quantity, i.unit_price_cents + i.modifiers_cents, 0, i.tax_rate_bp, i.line_total_cents, i.position
    from public.restaurant_order_items i where i.order_id = p_order;
  insert into public.invoice_items
    (invoice_id, organization_id, ref_type, ref_id, description, quantity,
     unit_price_cents, discount_cents, tax_rate_bp, total_cents, position)
  select v_invoice, v_order.organization_id, 'delivery_fee', null, 'رسوم التوصيل', 1, o.delivery_fee_cents, 0, 0, o.delivery_fee_cents, 10000
    from public.restaurant_orders o where o.id = p_order and o.delivery_fee_cents > 0;

  update public.restaurant_orders
     set invoice_id = v_invoice, customer_id = coalesce(p_customer, customer_id)
   where id = p_order;
  return v_invoice;
end;
$$;

-- ---------------------------------------------------------------------------
-- restaurant_pay_order (0054), now including the delivery fee.
-- ---------------------------------------------------------------------------
create or replace function public.restaurant_pay_order(
  p_org             uuid,
  p_order           uuid,
  p_method          text default 'cash',
  p_tendered_cents  bigint default 0,
  p_discount_cents  bigint default 0
)
returns table (
  out_invoice_id     uuid,
  out_receipt_number text,
  out_total_cents    bigint,
  out_paid_cents     bigint,
  out_due_cents      bigint,
  out_change_cents   bigint
)
language plpgsql security definer set search_path = '' as $$
declare
  v_user     uuid := auth.uid();
  v_order    record;
  v_currency char(3);
  v_subtotal bigint;
  v_tax      bigint;
  v_discount bigint;
  v_total    bigint;
  v_invoice  uuid;
  v_number   text;
  v_already  bigint;
  v_due      bigint;
  v_apply    bigint;
  v_change   bigint;
  v_account  uuid;
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  -- FOR UPDATE, added by 0054. Everything below decides how much is still owed
  -- by reading this order and the payments already against it. Without the lock
  -- two cashiers paying at the same moment both read "nothing paid yet" — under
  -- READ COMMITTED neither sees the other's uncommitted rows — and the order is
  -- paid twice, with two invoices and two receipt numbers.
  select o.id, o.branch_id, o.status, o.table_id, o.invoice_id, o.customer_id,
         o.number, o.currency, o.discount_cents, o.delivery_fee_cents
    into v_order
    from public.restaurant_orders o
   where o.id = p_order and o.organization_id = p_org
     for update;
  if v_order.id is null then
    raise exception 'order not found' using errcode = 'check_violation';
  end if;

  if not app.has_branch_permission(p_org, v_order.branch_id, 'restaurant.pos.use') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if not app.has_branch_permission(p_org, v_order.branch_id, 'payment.create') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_order.status = 'cancelled' then
    raise exception 'a cancelled order cannot be paid' using errcode = 'check_violation';
  end if;

  v_currency := v_order.currency;
  v_discount := greatest(coalesce(p_discount_cents, 0), 0);

  -- A discount is a separate privilege from taking money.
  if v_discount > 0
     and not app.has_branch_permission(p_org, v_order.branch_id, 'restaurant.pos.discount') then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  -- Totals are recomputed from the order's own lines every time, so a client
  -- cannot post a total, and a discount cannot be applied twice.
  select coalesce(sum(line_total_cents - round((line_total_cents * tax_rate_bp)::numeric
                                               / (10000 + tax_rate_bp))), 0),
         coalesce(sum(round((line_total_cents * tax_rate_bp)::numeric / (10000 + tax_rate_bp))), 0)
    into v_subtotal, v_tax
    from public.restaurant_order_items where order_id = p_order;

  -- 0106: the delivery fee is part of what the customer owes (it was left
  -- out here, so a delivery order paid at the till was invoiced without it).
  v_total := v_subtotal + v_tax + coalesce(v_order.delivery_fee_cents, 0) - v_discount;
  if v_total < 0 then
    raise exception 'discount exceeds the order total' using errcode = 'check_violation';
  end if;

  -- ---- the Core invoice (the receipt) --------------------------------------
  if v_order.invoice_id is null then
    v_number := app.next_document_number(p_org, v_order.branch_id, 'invoice');

    insert into public.invoices
      (organization_id, branch_id, number, customer_id, status, source, currency,
       subtotal_cents, discount_cents, tax_cents, total_cents, notes, issued_at, created_by)
    values
      (p_org, v_order.branch_id, v_number, v_order.customer_id, 'issued', 'restaurant',
       v_currency, v_subtotal + coalesce(v_order.delivery_fee_cents, 0), v_discount, v_tax, v_total,
       'طلب رقم ' || v_order.number, now(), v_user)
    returning id into v_invoice;

    insert into public.invoice_items
      (invoice_id, organization_id, ref_type, ref_id, description, quantity,
       unit_price_cents, discount_cents, tax_rate_bp, total_cents, position)
    select
      v_invoice, p_org, 'restaurant_variant', i.variant_id,
      i.product_name ||
        case when i.variant_name = 'default' then '' else ' — ' || i.variant_name end,
      i.quantity, i.unit_price_cents + i.modifiers_cents, 0, i.tax_rate_bp,
      i.line_total_cents, i.position
    from public.restaurant_order_items i
    where i.order_id = p_order;

    if coalesce(v_order.delivery_fee_cents, 0) > 0 then
      insert into public.invoice_items
        (invoice_id, organization_id, ref_type, ref_id, description, quantity,
         unit_price_cents, discount_cents, tax_rate_bp, total_cents, position)
      values
        (v_invoice, p_org, 'delivery_fee', null, 'رسوم التوصيل', 1,
         v_order.delivery_fee_cents, 0, 0, v_order.delivery_fee_cents, 10000);
    end if;

    update public.restaurant_orders
       set invoice_id = v_invoice,
           discount_cents = v_discount,
           subtotal_cents = v_subtotal,
           tax_cents = v_tax,
           total_cents = v_total
     where id = p_order;
  else
    v_invoice := v_order.invoice_id;
    select number, total_cents into v_number, v_total
      from public.invoices where id = v_invoice;
  end if;

  -- ---- payment -------------------------------------------------------------
  select coalesce(sum(amount_cents), 0) into v_already
    from public.payments where invoice_id = v_invoice and status = 'completed';

  v_due := v_total - v_already;
  if v_due <= 0 then
    raise exception 'this order is already paid in full' using errcode = 'check_violation';
  end if;

  -- Partial payments are supported: whatever is tendered goes against the
  -- balance, and anything above it is change, never an overpayment.
  v_apply  := least(greatest(coalesce(p_tendered_cents, 0), 0), v_due);
  v_change := greatest(coalesce(p_tendered_cents, 0) - v_due, 0);

  if v_apply > 0 then
    select id into v_account from public.treasury_accounts
     where branch_id = v_order.branch_id and is_active and is_default limit 1;

    insert into public.payments
      (organization_id, branch_id, invoice_id, customer_id, kind, method,
       amount_cents, currency, status, treasury_account_id, reference, created_by)
    values
      (p_org, v_order.branch_id, v_invoice, v_order.customer_id, 'payment', p_method,
       v_apply, v_currency, 'completed', v_account, v_order.number, v_user);

    if v_account is not null then
      insert into public.treasury_transactions
        (organization_id, branch_id, account_id, direction, amount_cents, currency,
         category, reason, ref_type, ref_id, created_by)
      values
        (p_org, v_order.branch_id, v_account, 'in', v_apply, v_currency,
         'sale', 'طلب ' || v_order.number, 'invoice', v_invoice, v_user);
    end if;
  end if;

  v_due := v_total - (v_already + v_apply);

  -- The table is waiting on payment until the balance is clear.
  if v_order.table_id is not null and v_due > 0 then
    update public.restaurant_tables
       set status = 'waiting_payment'
     where id = v_order.table_id and status = 'occupied';
  end if;

  insert into public.audit_logs
    (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values
    (p_org, v_order.branch_id, v_user, 'restaurant.order.paid', 'restaurant_order',
     p_order::text,
     jsonb_build_object('invoice', v_invoice, 'method', p_method,
                        'amount_cents', v_apply, 'due_cents', v_due));

  return query select v_invoice, v_number, v_total, v_already + v_apply, v_due, v_change;
end;
$$;

-- ---------------------------------------------------------------------------
-- Zones and drivers (managers)
-- ---------------------------------------------------------------------------
create or replace function public.restaurant_delivery_zone_save(
  p_org uuid, p_branch uuid, p_id uuid, p_name text, p_fee_cents bigint, p_driver_fee_cents bigint, p_is_active boolean default true
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_branch_permission(p_org, p_branch, 'restaurant.driver.manage') then raise exception 'not permitted' using errcode = '42501'; end if;
  if length(trim(coalesce(p_name, ''))) not between 1 and 80 then raise exception 'اسم المنطقة مطلوب' using errcode = '22023'; end if;
  if coalesce(p_fee_cents, -1) < 0 or coalesce(p_driver_fee_cents, -1) < 0 then raise exception 'المبلغ غير صالح' using errcode = '22023'; end if;
  if not exists (select 1 from public.branches where id = p_branch and organization_id = p_org) then
    raise exception 'الفرع غير موجود' using errcode = 'check_violation';
  end if;
  begin
    if p_id is null then
      insert into public.restaurant_delivery_zones (organization_id, branch_id, name, fee_cents, driver_fee_cents, is_active)
      values (p_org, p_branch, trim(p_name), p_fee_cents, p_driver_fee_cents, coalesce(p_is_active, true)) returning id into v_id;
    else
      update public.restaurant_delivery_zones
         set name = trim(p_name), fee_cents = p_fee_cents, driver_fee_cents = p_driver_fee_cents,
             is_active = coalesce(p_is_active, true), updated_at = now()
       where id = p_id and branch_id = p_branch and organization_id = p_org returning id into v_id;
      if v_id is null then raise exception 'المنطقة غير موجودة' using errcode = 'check_violation'; end if;
    end if;
  exception when unique_violation then
    raise exception 'توجد منطقة بنفس الاسم' using errcode = '23505';
  end;
  insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, p_branch, auth.uid(), 'restaurant.delivery_zone.saved', 'restaurant_delivery_zone', v_id::text,
          jsonb_build_object('name', p_name, 'fee_cents', p_fee_cents, 'driver_fee_cents', p_driver_fee_cents, 'active', p_is_active));
  return v_id;
end;
$$;

create or replace function public.restaurant_driver_save(
  p_org uuid, p_branch uuid, p_id uuid, p_name text, p_phone text, p_member uuid, p_vehicle text,
  p_mode text, p_percent_bp int, p_fixed_cents bigint, p_is_active boolean default true
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_branch_permission(p_org, p_branch, 'restaurant.driver.manage') then raise exception 'not permitted' using errcode = '42501'; end if;
  if length(trim(coalesce(p_name, ''))) not between 1 and 80 then raise exception 'اسم المندوب مطلوب' using errcode = '22023'; end if;
  if p_mode not in ('zone', 'percent', 'fixed') then raise exception 'طريقة العمولة غير معروفة' using errcode = '22023'; end if;
  if coalesce(p_percent_bp, 0) not between 0 and 10000 or coalesce(p_fixed_cents, 0) < 0 then
    raise exception 'العمولة غير صالحة' using errcode = '22023';
  end if;
  if p_member is not null and not exists (select 1 from public.organization_members where id = p_member and organization_id = p_org) then
    raise exception 'الموظف غير موجود' using errcode = 'check_violation';
  end if;
  if not exists (select 1 from public.branches where id = p_branch and organization_id = p_org) then
    raise exception 'الفرع غير موجود' using errcode = 'check_violation';
  end if;
  begin
    if p_id is null then
      insert into public.restaurant_drivers
        (organization_id, branch_id, member_id, name, phone, vehicle, commission_mode, commission_percent_bp, commission_fixed_cents, is_active)
      values (p_org, p_branch, p_member, trim(p_name), nullif(trim(coalesce(p_phone, '')), ''), nullif(trim(coalesce(p_vehicle, '')), ''),
              p_mode, coalesce(p_percent_bp, 0), coalesce(p_fixed_cents, 0), coalesce(p_is_active, true))
      returning id into v_id;
    else
      update public.restaurant_drivers
         set member_id = p_member, name = trim(p_name), phone = nullif(trim(coalesce(p_phone, '')), ''),
             vehicle = nullif(trim(coalesce(p_vehicle, '')), ''), commission_mode = p_mode,
             commission_percent_bp = coalesce(p_percent_bp, 0), commission_fixed_cents = coalesce(p_fixed_cents, 0),
             is_active = coalesce(p_is_active, true), on_shift = on_shift and coalesce(p_is_active, true), updated_at = now()
       where id = p_id and branch_id = p_branch and organization_id = p_org returning id into v_id;
      if v_id is null then raise exception 'المندوب غير موجود' using errcode = 'check_violation'; end if;
    end if;
  exception when unique_violation then
    raise exception 'هذا الموظف مسجل كمندوب بالفعل' using errcode = '23505';
  end;
  insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, p_branch, auth.uid(), 'restaurant.driver.saved', 'restaurant_driver', v_id::text,
          jsonb_build_object('name', p_name, 'mode', p_mode, 'percent_bp', p_percent_bp, 'fixed_cents', p_fixed_cents, 'active', p_is_active));
  return v_id;
end;
$$;

-- Clock a driver on or off (the dispatcher, or the driver themself).
create or replace function public.restaurant_driver_shift(p_org uuid, p_driver uuid, p_on boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare v public.restaurant_drivers%rowtype;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into v from public.restaurant_drivers where id = p_driver and organization_id = p_org;
  if v.id is null then raise exception 'المندوب غير موجود' using errcode = 'check_violation'; end if;
  if not (app.has_branch_permission(p_org, v.branch_id, 'restaurant.delivery.manage') or app.is_my_driver(p_driver)) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if p_on and not v.is_active then raise exception 'المندوب موقوف' using errcode = 'check_violation'; end if;
  update public.restaurant_drivers set on_shift = p_on, updated_at = now() where id = p_driver;
end;
$$;

-- ---------------------------------------------------------------------------
-- Dispatch
-- ---------------------------------------------------------------------------
create or replace function app.delivery_job(p_order uuid)
returns public.restaurant_delivery_jobs language plpgsql security definer set search_path = '' as $$
declare v public.restaurant_delivery_jobs%rowtype; o record;
begin
  select * into v from public.restaurant_delivery_jobs where order_id = p_order for update;
  if v.order_id is not null then return v; end if;
  select id, organization_id, branch_id, type into o from public.restaurant_orders where id = p_order;
  if o.id is null or o.type <> 'delivery' then raise exception 'ليس طلب توصيل' using errcode = 'check_violation'; end if;
  insert into public.restaurant_delivery_jobs (order_id, organization_id, branch_id)
  values (o.id, o.organization_id, o.branch_id)
  on conflict (order_id) do nothing;
  select * into v from public.restaurant_delivery_jobs where order_id = p_order for update;
  return v;
end;
$$;

-- Assign (or reassign, or with p_driver null unassign) before the driver leaves.
create or replace function public.restaurant_delivery_assign(p_org uuid, p_order uuid, p_driver uuid, p_zone uuid default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  o  record;
  j  public.restaurant_delivery_jobs%rowtype;
  d  public.restaurant_drivers%rowtype;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select id, branch_id, status into o from public.restaurant_orders where id = p_order and organization_id = p_org;
  if o.id is null then raise exception 'الطلب غير موجود' using errcode = 'check_violation'; end if;
  if not app.has_branch_permission(p_org, o.branch_id, 'restaurant.delivery.manage') then raise exception 'not permitted' using errcode = '42501'; end if;
  if o.status in ('pending_verification', 'completed', 'cancelled') then
    raise exception 'لا يمكن تعيين مندوب لهذا الطلب' using errcode = 'check_violation';
  end if;
  j := app.delivery_job(p_order);
  if j.status not in ('pending', 'assigned') then raise exception 'المندوب خرج بالطلب بالفعل' using errcode = 'check_violation'; end if;
  if p_driver is not null then
    select * into d from public.restaurant_drivers where id = p_driver and organization_id = p_org;
    if d.id is null or d.branch_id <> o.branch_id then raise exception 'المندوب غير موجود في هذا الفرع' using errcode = 'check_violation'; end if;
    if not d.is_active then raise exception 'المندوب موقوف' using errcode = 'check_violation'; end if;
  end if;
  if p_zone is not null and not exists (select 1 from public.restaurant_delivery_zones where id = p_zone and branch_id = o.branch_id) then
    raise exception 'المنطقة غير موجودة' using errcode = 'check_violation';
  end if;
  update public.restaurant_delivery_jobs
     set driver_id = p_driver, zone_id = coalesce(p_zone, zone_id),
         status = case when p_driver is null then 'pending' else 'assigned' end,
         assigned_at = case when p_driver is null then null else now() end, updated_at = now()
   where order_id = p_order;
  insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, o.branch_id, auth.uid(), 'restaurant.delivery.assigned', 'restaurant_order', p_order::text,
          jsonb_build_object('driver', p_driver, 'zone', p_zone, 'previous_driver', j.driver_id));
end;
$$;

-- p_status: dispatched · in_transit · delivered · returned
create or replace function public.restaurant_delivery_status(p_org uuid, p_order uuid, p_status text, p_reason text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  o     record;
  j     public.restaurant_delivery_jobs%rowtype;
  d     public.restaurant_drivers%rowtype;
  v_paid bigint := 0;
  v_due  bigint;
  v_comm bigint := 0;
  v_mgr  boolean;
  v_mine boolean;
  v_on   constant text := 'on';
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if p_status not in ('dispatched', 'in_transit', 'delivered', 'returned') then
    raise exception 'حالة غير معروفة' using errcode = '22023';
  end if;
  select id, branch_id, status, total_cents, invoice_id, number into o
    from public.restaurant_orders where id = p_order and organization_id = p_org for update;
  if o.id is null then raise exception 'الطلب غير موجود' using errcode = 'check_violation'; end if;
  j := app.delivery_job(p_order);
  if j.driver_id is null then raise exception 'عيّن مندوبًا أولًا' using errcode = 'check_violation'; end if;
  select * into d from public.restaurant_drivers where id = j.driver_id;

  v_mgr  := app.has_branch_permission(p_org, o.branch_id, 'restaurant.delivery.manage');
  v_mine := app.is_my_driver(j.driver_id) and app.has_branch_permission(p_org, o.branch_id, 'restaurant.driver.use');
  -- The driver moves their own trip; a return is the dispatcher's call.
  if not (v_mgr or (v_mine and p_status in ('in_transit', 'delivered'))) then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  if p_status = 'dispatched' then
    if j.status <> 'assigned' then raise exception 'الطلب ليس جاهزًا للخروج' using errcode = 'check_violation'; end if;
    if o.status <> 'ready' then raise exception 'المطبخ لم يجهّز الطلب بعد' using errcode = 'check_violation'; end if;
    update public.restaurant_orders set status = 'served' where id = p_order;
    update public.restaurant_delivery_jobs set status = 'dispatched', dispatched_at = now(), updated_at = now() where order_id = p_order;

  elsif p_status = 'in_transit' then
    if j.status <> 'dispatched' then raise exception 'الطلب لم يخرج بعد' using errcode = 'check_violation'; end if;
    update public.restaurant_delivery_jobs set status = 'in_transit', in_transit_at = now(), updated_at = now() where order_id = p_order;

  elsif p_status = 'delivered' then
    if j.status not in ('dispatched', 'in_transit') then raise exception 'الطلب لم يخرج بعد' using errcode = 'check_violation'; end if;
    if o.invoice_id is not null then
      select coalesce(paid_cents, 0) into v_paid from public.invoices where id = o.invoice_id;
    end if;
    v_due := greatest(o.total_cents - v_paid, 0);
    v_comm := case d.commission_mode
                when 'zone' then coalesce((select driver_fee_cents from public.restaurant_delivery_zones where id = j.zone_id), 0)
                when 'percent' then round(o.total_cents * d.commission_percent_bp / 10000.0)
                else d.commission_fixed_cents end;
    update public.restaurant_delivery_jobs
       set status = 'delivered', delivered_at = now(), cash_to_collect_cents = v_due, commission_cents = v_comm,
           -- Nothing to collect (paid online): nothing to settle.
           settled_at = case when v_due = 0 then now() else null end, updated_at = now()
     where order_id = p_order;
    if v_due > 0 then
      insert into public.restaurant_driver_ledger (organization_id, branch_id, driver_id, kind, amount_cents, order_id, actor_id)
      values (p_org, o.branch_id, j.driver_id, 'collect', v_due, p_order, auth.uid());
    else
      update public.restaurant_orders set status = 'completed' where id = p_order and status = 'served';
    end if;
    if v_comm > 0 then
      insert into public.restaurant_driver_ledger (organization_id, branch_id, driver_id, kind, amount_cents, order_id, actor_id)
      values (p_org, o.branch_id, j.driver_id, 'commission', v_comm, p_order, auth.uid());
    end if;

  else -- returned
    if j.status not in ('dispatched', 'in_transit') then raise exception 'الطلب لم يخرج بعد' using errcode = 'check_violation'; end if;
    if nullif(trim(coalesce(p_reason, '')), '') is null then raise exception 'اكتب سبب الإرجاع' using errcode = '22023'; end if;
    if o.invoice_id is not null then raise exception 'الطلب مدفوع — يُسترد من الفواتير' using errcode = 'check_violation'; end if;
    -- A returned order is cancelled: its food is waste (0105) and, for anyone
    -- without approval rights, the 0103 guard asks for a manager PIN.
    perform set_config('app.delivery_return', v_on, true);
    update public.restaurant_orders set status = 'cancelled', cancel_reason = left('مرتجع توصيل: ' || trim(p_reason), 300)
     where id = p_order;
    perform set_config('app.delivery_return', '', true);
    update public.restaurant_delivery_jobs
       set status = 'returned', returned_at = now(), return_reason = left(trim(p_reason), 300), updated_at = now()
     where order_id = p_order;
  end if;

  insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, o.branch_id, auth.uid(), 'restaurant.delivery.' || p_status, 'restaurant_order', p_order::text,
          jsonb_build_object('driver', j.driver_id, 'cash_to_collect', v_due, 'commission', v_comm, 'reason', p_reason));
end;
$$;

-- The 0021 order state machine, plus one move: a delivery that came back
-- (served → cancelled), only from restaurant_delivery_status above.
create or replace function app.check_order_transition()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  allowed text[];
begin
  if new.status = old.status then
    return new;
  end if;
  allowed := case old.status
    when 'pending_verification' then array['new','cancelled']
    when 'new'       then array['confirmed','cancelled']
    when 'confirmed' then array['preparing','ready','cancelled']
    when 'preparing' then array['ready','cancelled']
    when 'ready'     then array['served','cancelled']
    when 'served'    then case when coalesce(current_setting('app.delivery_return', true), '') = 'on'
                               then array['completed','cancelled'] else array['completed'] end
    else array[]::text[]
  end;
  if not (new.status = any(allowed)) then
    raise exception 'invalid order transition % → %', old.status, new.status
      using errcode = 'check_violation';
  end if;
  new.confirmed_at := case when new.status = 'confirmed' then now() else new.confirmed_at end;
  new.ready_at     := case when new.status = 'ready'     then now() else new.ready_at end;
  new.served_at    := case when new.status = 'served'    then now() else new.served_at end;
  new.completed_at := case when new.status = 'completed' then now() else new.completed_at end;
  new.cancelled_at := case when new.status = 'cancelled' then now() else new.cancelled_at end;
  return new;
end;
$$;

-- A delivery order cancelled before it left takes its job with it.
create or replace function app.delivery_job_on_cancel()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'cancelled' and old.status <> 'cancelled' then
    update public.restaurant_delivery_jobs set status = 'cancelled', updated_at = now()
     where order_id = new.id and status in ('pending', 'assigned');
  end if;
  return new;
end;
$$;
create trigger restaurant_orders_delivery_job_cancel
  after update of status on public.restaurant_orders
  for each row execute function app.delivery_job_on_cancel();

-- ---------------------------------------------------------------------------
-- Driver money
-- ---------------------------------------------------------------------------
-- Change float handed to a driver from the drawer.
create or replace function public.restaurant_driver_float(p_org uuid, p_driver uuid, p_amount bigint, p_note text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare d public.restaurant_drivers%rowtype; v_account uuid; v_currency char(3);
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into d from public.restaurant_drivers where id = p_driver and organization_id = p_org for update;
  if d.id is null then raise exception 'المندوب غير موجود' using errcode = 'check_violation'; end if;
  if not app.has_branch_permission(p_org, d.branch_id, 'restaurant.driver.settle') then raise exception 'not permitted' using errcode = '42501'; end if;
  if p_amount is null or p_amount <= 0 or p_amount > 100000000 then raise exception 'المبلغ غير صالح' using errcode = '22023'; end if;
  select id, currency into v_account, v_currency from public.treasury_accounts
   where branch_id = d.branch_id and is_active and is_default limit 1;
  if v_account is not null then
    insert into public.treasury_transactions
      (organization_id, branch_id, account_id, direction, amount_cents, currency, category, reason, ref_type, ref_id, created_by)
    values (p_org, d.branch_id, v_account, 'out', p_amount, v_currency, 'driver_float', 'فكة للمندوب ' || d.name,
            'restaurant_driver', p_driver, auth.uid());
  end if;
  insert into public.restaurant_driver_ledger (organization_id, branch_id, driver_id, kind, amount_cents, note, actor_id)
  values (p_org, d.branch_id, p_driver, 'float_out', p_amount, left(p_note, 300), auth.uid());
  insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, d.branch_id, auth.uid(), 'restaurant.driver.float', 'restaurant_driver', p_driver::text,
          jsonb_build_object('amount', p_amount));
end;
$$;

-- The driver hands in cash. Every unsettled cash-on-delivery order is paid
-- now (restaurant_pay_order, into the drawer) and completed; what remains is
-- returned float. A shortage, and paying out commission, need a manager PIN.
create or replace function public.restaurant_driver_settle(p_org uuid, p_driver uuid, p_cash_cents bigint, p_pay_commission boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  d          public.restaurant_drivers%rowtype;
  r          record;
  v_custody  bigint;
  v_comm     bigint;
  v_collect  bigint := 0;
  v_short    bigint;
  v_by_short uuid;
  v_by_pay   uuid;
  v_account  uuid;
  v_currency char(3);
  v_orders   int := 0;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into d from public.restaurant_drivers where id = p_driver and organization_id = p_org for update;
  if d.id is null then raise exception 'المندوب غير موجود' using errcode = 'check_violation'; end if;
  if not app.has_branch_permission(p_org, d.branch_id, 'restaurant.driver.settle') then raise exception 'not permitted' using errcode = '42501'; end if;
  if p_cash_cents is null or p_cash_cents < 0 then raise exception 'المبلغ غير صالح' using errcode = '22023'; end if;
  if exists (select 1 from public.restaurant_delivery_jobs where driver_id = p_driver and status in ('dispatched', 'in_transit')) then
    raise exception 'المندوب لديه طلبات في الطريق — سوِّ بعد عودته' using errcode = 'check_violation';
  end if;

  select out_custody, out_commission into v_custody, v_comm from app.driver_balances(p_driver);
  if p_cash_cents > v_custody then
    raise exception 'المبلغ أكبر من عهدة المندوب' using errcode = 'check_violation';
  end if;
  v_short := v_custody - p_cash_cents;
  if v_short > 0 then
    v_by_short := app.require_approval(p_org, d.branch_id, 'driver.shortage', p_driver, v_short);
  end if;
  if p_pay_commission and v_comm > 0 then
    v_by_pay := app.require_approval(p_org, d.branch_id, 'driver.payout', p_driver, v_comm);
  end if;

  -- Each delivered, unsettled order: paid into the drawer now, and closed.
  for r in
    select j.order_id, j.cash_to_collect_cents, o.discount_cents, o.status
      from public.restaurant_delivery_jobs j join public.restaurant_orders o on o.id = j.order_id
     where j.driver_id = p_driver and j.status = 'delivered' and j.settled_at is null
     order by j.delivered_at
     for update of j
  loop
    if r.cash_to_collect_cents > 0 and r.status <> 'cancelled' then
      perform public.restaurant_pay_order(p_org, r.order_id, 'cash', r.cash_to_collect_cents, r.discount_cents);
      v_collect := v_collect + r.cash_to_collect_cents;
    end if;
    update public.restaurant_orders set status = 'completed' where id = r.order_id and status = 'served';
    update public.restaurant_delivery_jobs set settled_at = now(), settled_by = auth.uid(), updated_at = now()
     where order_id = r.order_id;
    v_orders := v_orders + 1;
  end loop;

  select id, currency into v_account, v_currency from public.treasury_accounts
   where branch_id = d.branch_id and is_active and is_default limit 1;
  if v_account is not null then
    -- The orders' payments put v_collect in the drawer; the drawer actually
    -- received p_cash_cents. The difference is returned float (in) or a
    -- shortage on the collections themselves (out).
    if p_cash_cents > v_collect then
      insert into public.treasury_transactions
        (organization_id, branch_id, account_id, direction, amount_cents, currency, category, reason, ref_type, ref_id, created_by)
      values (p_org, d.branch_id, v_account, 'in', p_cash_cents - v_collect, v_currency, 'driver_float_return',
              'إرجاع فكة ' || d.name, 'restaurant_driver', p_driver, auth.uid());
    elsif p_cash_cents < v_collect then
      insert into public.treasury_transactions
        (organization_id, branch_id, account_id, direction, amount_cents, currency, category, reason, ref_type, ref_id, created_by)
      values (p_org, d.branch_id, v_account, 'out', v_collect - p_cash_cents, v_currency, 'driver_shortage',
              'عجز مندوب ' || d.name, 'restaurant_driver', p_driver, auth.uid());
    end if;
  end if;

  if p_cash_cents > 0 then
    insert into public.restaurant_driver_ledger (organization_id, branch_id, driver_id, kind, amount_cents, actor_id)
    values (p_org, d.branch_id, p_driver, 'settle', p_cash_cents, auth.uid());
  end if;
  if v_short > 0 then
    insert into public.restaurant_driver_ledger (organization_id, branch_id, driver_id, kind, amount_cents, actor_id, approved_by, note)
    values (p_org, d.branch_id, p_driver, 'shortage', v_short, auth.uid(), v_by_short, 'عجز عند التسوية');
  end if;
  if p_pay_commission and v_comm > 0 then
    if v_account is not null then
      insert into public.treasury_transactions
        (organization_id, branch_id, account_id, direction, amount_cents, currency, category, reason, ref_type, ref_id, created_by)
      values (p_org, d.branch_id, v_account, 'out', v_comm, v_currency, 'driver_commission',
              'عمولة المندوب ' || d.name, 'restaurant_driver', p_driver, auth.uid());
    end if;
    insert into public.restaurant_driver_ledger (organization_id, branch_id, driver_id, kind, amount_cents, actor_id, approved_by)
    values (p_org, d.branch_id, p_driver, 'payout', v_comm, auth.uid(), v_by_pay);
  end if;

  insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, d.branch_id, auth.uid(), 'restaurant.driver.settled', 'restaurant_driver', p_driver::text,
          jsonb_build_object('cash', p_cash_cents, 'custody', v_custody, 'collected', v_collect, 'orders', v_orders,
                             'shortage', v_short, 'shortage_approved_by', v_by_short,
                             'commission_paid', case when p_pay_commission then v_comm else 0 end, 'payout_approved_by', v_by_pay));
  return jsonb_build_object('orders', v_orders, 'collected', v_collect, 'shortage', v_short,
                            'commission_paid', case when p_pay_commission then v_comm else 0 end);
end;
$$;

-- A manual commission correction (a bonus, a deduction for a shortage).
create or replace function public.restaurant_driver_adjust(p_org uuid, p_driver uuid, p_amount bigint, p_note text)
returns void language plpgsql security definer set search_path = '' as $$
declare d public.restaurant_drivers%rowtype; v_by uuid;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into d from public.restaurant_drivers where id = p_driver and organization_id = p_org for update;
  if d.id is null then raise exception 'المندوب غير موجود' using errcode = 'check_violation'; end if;
  if not app.has_branch_permission(p_org, d.branch_id, 'restaurant.driver.manage') then raise exception 'not permitted' using errcode = '42501'; end if;
  if p_amount is null or p_amount = 0 or abs(p_amount) > 100000000 then raise exception 'المبلغ غير صالح' using errcode = '22023'; end if;
  if nullif(trim(coalesce(p_note, '')), '') is null then raise exception 'اكتب سبب التعديل' using errcode = '22023'; end if;
  v_by := app.require_approval(p_org, d.branch_id, 'driver.adjust', p_driver, abs(p_amount));
  insert into public.restaurant_driver_ledger (organization_id, branch_id, driver_id, kind, amount_cents, note, actor_id, approved_by)
  values (p_org, d.branch_id, p_driver, 'commission_adjust', p_amount, left(trim(p_note), 300), auth.uid(), v_by);
  insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, d.branch_id, auth.uid(), 'restaurant.driver.adjusted', 'restaurant_driver', p_driver::text,
          jsonb_build_object('amount', p_amount, 'note', p_note, 'approved_by', v_by));
end;
$$;

-- ---------------------------------------------------------------------------
-- Call center
-- ---------------------------------------------------------------------------
-- Everything the agent needs about a caller, from any phone format.
create or replace function public.restaurant_callcenter_lookup(p_org uuid, p_branch uuid, p_phone text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_key text := app.phone_key(p_phone);
  v_customers jsonb; v_addresses jsonb; v_orders jsonb; v_points record; v_ids uuid[];
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_branch_permission(p_org, p_branch, 'restaurant.callcenter.use') then raise exception 'not permitted' using errcode = '42501'; end if;
  if length(v_key) < 7 then raise exception 'رقم الهاتف غير مكتمل' using errcode = '22023'; end if;
  perform app.rate_limit('rl_callcenter_lookup', auth.uid()::text, 600, 600);

  select array_agg(id) into v_ids from public.customers
   where organization_id = p_org and deleted_at is null and app.phone_key(phone) = v_key;

  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'phone', c.phone, 'notes', c.notes) order by c.created_at), '[]'::jsonb)
    into v_customers from public.customers c where c.id = any(coalesce(v_ids, '{}'));

  -- Saved addresses first, then the distinct addresses this phone ordered to.
  select coalesce(jsonb_agg(a), '[]'::jsonb) into v_addresses from (
    select jsonb_build_object('id', ca.id, 'saved', true, 'customer_id', ca.customer_id, 'label', ca.label,
             'recipient_name', ca.recipient_name, 'phone', ca.phone, 'city', ca.city, 'area', ca.area,
             'address', ca.address, 'landmark', ca.landmark, 'is_default', ca.is_default) as a
      from public.customer_addresses ca
     where ca.organization_id = p_org and ca.customer_id = any(coalesce(v_ids, '{}'))
    union all
    select jsonb_build_object('id', null, 'saved', false, 'customer_id', null, 'label', 'من طلب سابق',
             'recipient_name', x.recipient_name, 'phone', x.phone, 'city', x.city, 'area', x.area,
             'address', x.address, 'landmark', x.landmark, 'is_default', false)
      from (select distinct on (lower(trim(d.address)), lower(coalesce(d.area, '')))
                   d.recipient_name, d.phone, d.city, d.area, d.address, d.landmark, o.placed_at
              from public.restaurant_order_deliveries d join public.restaurant_orders o on o.id = d.order_id
             where o.organization_id = p_org and app.phone_key(o.guest_phone) = v_key
             order by lower(trim(d.address)), lower(coalesce(d.area, '')), o.placed_at desc
             limit 5) x
     where not exists (select 1 from public.customer_addresses ca
                        where ca.customer_id = any(coalesce(v_ids, '{}')) and lower(trim(ca.address)) = lower(trim(x.address)))
  ) s;

  select coalesce(jsonb_agg(r order by r->>'placed_at' desc), '[]'::jsonb) into v_orders from (
    select jsonb_build_object('id', o.id, 'number', o.number, 'placed_at', o.placed_at, 'status', o.status,
             'type', o.type, 'channel', o.channel, 'total_cents', o.total_cents,
             'lines', (select coalesce(jsonb_agg(jsonb_build_object('variant_id', i.variant_id, 'product_name', i.product_name,
                                       'variant_name', i.variant_name, 'quantity', i.quantity, 'note', i.note,
                                       'modifier_ids', (select coalesce(jsonb_agg(m.modifier_id), '[]'::jsonb)
                                                          from public.restaurant_order_item_modifiers m
                                                         where m.order_item_id = i.id and m.modifier_id is not null))
                                       order by i.position), '[]'::jsonb)
                         from public.restaurant_order_items i where i.order_id = o.id)) as r
      from public.restaurant_orders o
     where o.organization_id = p_org
       and (app.phone_key(o.guest_phone) = v_key or o.customer_id = any(coalesce(v_ids, '{}')))
     order by o.placed_at desc limit 10
  ) s;

  select * into v_points from app.loyalty_points(p_org, v_key);
  return jsonb_build_object('phone_key', v_key, 'customers', v_customers, 'addresses', v_addresses,
                            'orders', v_orders, 'points', coalesce(v_points.out_balance, 0));
end;
$$;

create or replace function public.restaurant_customer_upsert(p_org uuid, p_branch uuid, p_id uuid, p_name text, p_phone text, p_notes text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_key text := app.phone_key(p_phone);
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_branch_permission(p_org, p_branch, 'restaurant.callcenter.use') then raise exception 'not permitted' using errcode = '42501'; end if;
  if length(trim(coalesce(p_name, ''))) not between 1 and 160 then raise exception 'اسم العميل مطلوب' using errcode = '22023'; end if;
  if length(v_key) < 7 or p_phone !~ '^[0-9+ ()-]{7,30}$' then raise exception 'رقم الهاتف غير صالح' using errcode = '22023'; end if;

  v_id := p_id;
  if v_id is null then
    -- The same phone in another format is the same customer.
    select id into v_id from public.customers
     where organization_id = p_org and deleted_at is null and app.phone_key(phone) = v_key
     order by created_at limit 1;
  end if;
  if v_id is null then
    insert into public.customers (organization_id, name, phone, notes, created_by)
    values (p_org, trim(p_name), trim(p_phone), left(nullif(trim(coalesce(p_notes, '')), ''), 1000), auth.uid())
    returning id into v_id;
  else
    update public.customers
       -- The number as first saved stays, unless it is really a different one.
       set name = trim(p_name), phone = case when app.phone_key(phone) = v_key then phone else trim(p_phone) end,
           notes = coalesce(left(nullif(trim(coalesce(p_notes, '')), ''), 1000), notes), updated_at = now()
     where id = v_id and organization_id = p_org and deleted_at is null;
    if not found then raise exception 'العميل غير موجود' using errcode = 'check_violation'; end if;
  end if;
  insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, p_branch, auth.uid(), 'restaurant.callcenter.customer_saved', 'customer', v_id::text,
          jsonb_build_object('name', p_name));
  return v_id;
end;
$$;

create or replace function public.restaurant_customer_address_save(
  p_org uuid, p_branch uuid, p_customer uuid, p_id uuid, p_label text, p_recipient text, p_phone text,
  p_city text, p_area text, p_address text, p_landmark text, p_default boolean default false
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_branch_permission(p_org, p_branch, 'restaurant.callcenter.use') then raise exception 'not permitted' using errcode = '42501'; end if;
  if not exists (select 1 from public.customers where id = p_customer and organization_id = p_org and deleted_at is null) then
    raise exception 'العميل غير موجود' using errcode = 'check_violation';
  end if;
  if length(trim(coalesce(p_address, ''))) not between 5 and 500 then raise exception 'العنوان قصير جدًا' using errcode = '22023'; end if;
  if coalesce(p_default, false) then
    update public.customer_addresses set is_default = false where customer_id = p_customer and organization_id = p_org;
  end if;
  if p_id is null then
    insert into public.customer_addresses
      (organization_id, customer_id, label, recipient_name, phone, city, area, address, landmark, is_default)
    values (p_org, p_customer, coalesce(nullif(trim(coalesce(p_label, '')), ''), 'المنزل'), nullif(trim(coalesce(p_recipient, '')), ''),
            nullif(trim(coalesce(p_phone, '')), ''), nullif(trim(coalesce(p_city, '')), ''), nullif(trim(coalesce(p_area, '')), ''),
            trim(p_address), nullif(trim(coalesce(p_landmark, '')), ''), coalesce(p_default, false))
    returning id into v_id;
  else
    update public.customer_addresses
       set label = coalesce(nullif(trim(coalesce(p_label, '')), ''), label), recipient_name = nullif(trim(coalesce(p_recipient, '')), ''),
           phone = nullif(trim(coalesce(p_phone, '')), ''), city = nullif(trim(coalesce(p_city, '')), ''),
           area = nullif(trim(coalesce(p_area, '')), ''), address = trim(p_address),
           landmark = nullif(trim(coalesce(p_landmark, '')), ''), is_default = coalesce(p_default, false), updated_at = now()
     where id = p_id and customer_id = p_customer and organization_id = p_org returning id into v_id;
    if v_id is null then raise exception 'العنوان غير موجود' using errcode = 'check_violation'; end if;
  end if;
  return v_id;
end;
$$;

-- A phone order: the customer, the address (saved or typed), the zone and its fee.
-- p_address: { "id"?, "recipient_name"?, "phone"?, "city"?, "area"?, "address", "landmark"?, "notes"? }
create or replace function public.restaurant_callcenter_place_order(
  p_org uuid, p_branch uuid, p_customer uuid, p_type text, p_items jsonb,
  p_address jsonb default null, p_zone uuid default null, p_note text default null, p_confirm boolean default true
) returns table (out_order_id uuid, out_number text, out_total_cents bigint)
language plpgsql security definer set search_path = '' as $$
declare
  c        public.customers%rowtype;
  a        public.customer_addresses%rowtype;
  z        public.restaurant_delivery_zones%rowtype;
  v_order  uuid;
  v_number text;
  v_total  bigint;
  v_addr   text;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_branch_permission(p_org, p_branch, 'restaurant.callcenter.use') then raise exception 'not permitted' using errcode = '42501'; end if;
  if p_type not in ('delivery', 'pickup') then raise exception 'نوع الطلب غير صالح' using errcode = '22023'; end if;
  select * into c from public.customers where id = p_customer and organization_id = p_org and deleted_at is null;
  if c.id is null then raise exception 'العميل غير موجود' using errcode = 'check_violation'; end if;

  if p_type = 'delivery' then
    if p_address is null then raise exception 'اختر عنوان التوصيل' using errcode = '22023'; end if;
    if nullif(p_address ->> 'id', '') is not null then
      select * into a from public.customer_addresses
       where id = (p_address ->> 'id')::uuid and customer_id = p_customer and organization_id = p_org;
      if a.id is null then raise exception 'العنوان غير موجود' using errcode = 'check_violation'; end if;
    end if;
    v_addr := coalesce(a.address, nullif(trim(p_address ->> 'address'), ''));
    if length(coalesce(v_addr, '')) < 4 then raise exception 'العنوان قصير جدًا' using errcode = '22023'; end if;
    if p_zone is not null then
      select * into z from public.restaurant_delivery_zones where id = p_zone and branch_id = p_branch and is_active;
      if z.id is null then raise exception 'منطقة التوصيل غير موجودة' using errcode = 'check_violation'; end if;
    end if;
  end if;

  select o.out_order_id, o.out_number into v_order, v_number
    from public.restaurant_create_order(p_org, p_branch, p_items, null, p_type, 'phone', p_customer, p_note) o;

  -- The guest's name and phone on the order: loyalty points follow the phone.
  update public.restaurant_orders
     set guest_name = c.name, guest_phone = c.phone,
         delivery_fee_cents = case when p_type = 'delivery' then coalesce(z.fee_cents, 0) else 0 end
   where id = v_order;

  if p_type = 'delivery' then
    insert into public.restaurant_order_deliveries
      (order_id, organization_id, branch_id, recipient_name, phone, city, area, address, landmark, notes)
    values (v_order, p_org, p_branch,
            left(coalesce(a.recipient_name, nullif(trim(p_address ->> 'recipient_name'), ''), c.name), 120),
            left(coalesce(a.phone, nullif(trim(p_address ->> 'phone'), ''), c.phone), 32),
            coalesce(a.city, nullif(trim(p_address ->> 'city'), '')),
            coalesce(a.area, nullif(trim(p_address ->> 'area'), '')),
            v_addr,
            coalesce(a.landmark, nullif(trim(p_address ->> 'landmark'), '')),
            left(nullif(trim(p_address ->> 'notes'), ''), 500));
    insert into public.restaurant_delivery_jobs (order_id, organization_id, branch_id, zone_id)
    values (v_order, p_org, p_branch, z.id);
  end if;

  if coalesce(p_confirm, true) then
    update public.restaurant_orders set status = 'confirmed' where id = v_order;
  end if;
  select total_cents into v_total from public.restaurant_orders where id = v_order;

  insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, p_branch, auth.uid(), 'restaurant.callcenter.order', 'restaurant_order', v_order::text,
          jsonb_build_object('customer', p_customer, 'type', p_type, 'zone', p_zone, 'total', v_total));
  return query select v_order, v_number, v_total;
end;
$$;

-- ---------------------------------------------------------------------------
-- Integrations: keys and the standard intake
-- ---------------------------------------------------------------------------
-- The key itself is generated and shown once by the app; only its SHA-256 is stored.
create or replace function public.restaurant_integration_create(
  p_org uuid, p_branch uuid, p_name text, p_source text, p_key_hash text, p_key_prefix text, p_auto_confirm boolean default true
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_branch_permission(p_org, p_branch, 'restaurant.integration.manage') then raise exception 'not permitted' using errcode = '42501'; end if;
  if not exists (select 1 from public.branches where id = p_branch and organization_id = p_org) then
    raise exception 'الفرع غير موجود' using errcode = 'check_violation';
  end if;
  if p_source !~ '^[a-z0-9_]{2,40}$' then raise exception 'اسم المصدر: حروف إنجليزية صغيرة وأرقام فقط' using errcode = '22023'; end if;
  if p_key_hash !~ '^[0-9a-f]{64}$' then raise exception 'مفتاح غير صالح' using errcode = '22023'; end if;
  insert into public.restaurant_integrations (organization_id, branch_id, name, source, key_hash, key_prefix, auto_confirm, created_by)
  values (p_org, p_branch, trim(p_name), p_source, p_key_hash, p_key_prefix, coalesce(p_auto_confirm, true), auth.uid())
  returning id into v_id;
  insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, p_branch, auth.uid(), 'restaurant.integration.created', 'restaurant_integration', v_id::text,
          jsonb_build_object('name', p_name, 'source', p_source, 'prefix', p_key_prefix, 'auto_confirm', p_auto_confirm));
  return v_id;
end;
$$;

create or replace function public.restaurant_integration_set(p_org uuid, p_id uuid, p_active boolean, p_auto_confirm boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare v public.restaurant_integrations%rowtype;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into v from public.restaurant_integrations where id = p_id and organization_id = p_org;
  if v.id is null then raise exception 'التكامل غير موجود' using errcode = 'check_violation'; end if;
  if not app.has_branch_permission(p_org, v.branch_id, 'restaurant.integration.manage') then raise exception 'not permitted' using errcode = '42501'; end if;
  update public.restaurant_integrations
     set is_active = coalesce(p_active, is_active), auto_confirm = coalesce(p_auto_confirm, auto_confirm)
   where id = p_id;
  insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, v.branch_id, auth.uid(), 'restaurant.integration.updated', 'restaurant_integration', p_id::text,
          jsonb_build_object('active', p_active, 'auto_confirm', p_auto_confirm));
end;
$$;

-- The integration's menu: what the sender maps its items to.
create or replace function public.restaurant_intake_menu(p_key_hash text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v public.restaurant_integrations%rowtype;
begin
  select * into v from public.restaurant_integrations where key_hash = p_key_hash and is_active;
  if v.id is null then raise exception 'invalid key' using errcode = '28000'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
            'variant_id', rv.id, 'product', p.name, 'variant', rv.name, 'category', c.name,
            'price_cents', rv.price_cents,
            'modifiers', (select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'group', g.name, 'name', m.name,
                                   'price_cents', m.price_cents) order by g.sort_order, m.sort_order), '[]'::jsonb)
                            from public.restaurant_modifier_groups g join public.restaurant_modifiers m on m.group_id = g.id
                           where g.product_id = p.id and g.is_active and m.is_active))
          order by c.sort_order, p.sort_order, rv.sort_order), '[]'::jsonb)
            from public.restaurant_variants rv
            join public.restaurant_products p on p.id = rv.product_id
            left join public.restaurant_categories c on c.id = p.category_id
           where p.organization_id = v.organization_id and p.is_active and rv.is_active and p.deleted_at is null);
end;
$$;

-- Payload:
-- { "external_id": "TLB-123", "type": "delivery"|"pickup",
--   "customer": { "name": "...", "phone": "..." },
--   "delivery": { "address": "...", "area"?, "city"?, "landmark"?, "notes"?, "latitude"?, "longitude"? },
--   "items": [ { "variant_id": "...", "quantity": 2, "modifier_ids"?: [...], "note"?: "..." } ],
--   "note"?: "...", "paid"?: true, "total_cents"?: 12345 }
create or replace function public.restaurant_intake_order(p_key_hash text, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v        public.restaurant_integrations%rowtype;
  v_ext    text := nullif(trim(p_payload ->> 'external_id'), '');
  v_type   text := coalesce(p_payload ->> 'type', 'delivery');
  v_name   text := nullif(trim(p_payload #>> '{customer,name}'), '');
  v_phone  text := nullif(trim(p_payload #>> '{customer,phone}'), '');
  v_order  uuid;
  v_number text;
  v_currency char(3);
  v_existing record;
  v_invoice uuid;
  v_total  bigint;
begin
  select * into v from public.restaurant_integrations where key_hash = p_key_hash and is_active;
  if v.id is null then raise exception 'invalid key' using errcode = '28000'; end if;
  perform app.rate_limit('rl_intake', v.id::text, 600, 600);

  if v_ext is null or length(v_ext) > 120 then raise exception 'external_id is required' using errcode = '22023'; end if;
  if v_type not in ('delivery', 'pickup') then raise exception 'type must be delivery or pickup' using errcode = '22023'; end if;
  if v_name is null or length(v_name) > 120 then raise exception 'customer.name is required' using errcode = '22023'; end if;
  if v_phone is null or length(app.phone_key(v_phone)) < 7 then raise exception 'customer.phone is required' using errcode = '22023'; end if;
  if v_type = 'delivery' and length(coalesce(trim(p_payload #>> '{delivery,address}'), '')) < 4 then
    raise exception 'delivery.address is required' using errcode = '22023';
  end if;

  -- Idempotent: the same external order twice is the same order.
  select id, number, status into v_existing from public.restaurant_orders
   where organization_id = v.organization_id and external_source = v.source and external_ref = v_ext;
  if v_existing.id is not null then
    return jsonb_build_object('order_id', v_existing.id, 'number', v_existing.number, 'status', v_existing.status, 'duplicate', true);
  end if;

  select o.currency into v_currency from public.organizations o
    join public.branches b on b.organization_id = o.id
   where o.id = v.organization_id and b.id = v.branch_id and b.is_active and b.deleted_at is null;
  if v_currency is null then raise exception 'branch unavailable' using errcode = 'check_violation'; end if;

  v_number := app.next_document_number(v.organization_id, v.branch_id, 'restaurant_order');
  insert into public.restaurant_orders
    (organization_id, branch_id, number, channel, type, status, guest_name, guest_phone, note, currency,
     external_source, external_ref, external_total_cents)
  values (v.organization_id, v.branch_id, v_number, 'aggregator', v_type, 'new', left(v_name, 120), left(v_phone, 30),
          left(nullif(trim(p_payload ->> 'note'), ''), 500), v_currency, v.source, v_ext,
          nullif(p_payload ->> 'total_cents', '')::bigint)
  returning id into v_order;

  -- Priced from this restaurant's own menu; the sender's total is kept for reconciliation.
  perform app.restaurant_build_order_lines(v.organization_id, v.branch_id, v_order, p_payload -> 'items');

  if v_type = 'delivery' then
    insert into public.restaurant_order_deliveries
      (order_id, organization_id, branch_id, recipient_name, phone, city, area, address, landmark, latitude, longitude, notes)
    values (v_order, v.organization_id, v.branch_id, left(v_name, 120), left(v_phone, 32),
            left(nullif(trim(p_payload #>> '{delivery,city}'), ''), 120), left(nullif(trim(p_payload #>> '{delivery,area}'), ''), 120),
            left(trim(p_payload #>> '{delivery,address}'), 500), left(nullif(trim(p_payload #>> '{delivery,landmark}'), ''), 240),
            nullif(p_payload #>> '{delivery,latitude}', '')::numeric, nullif(p_payload #>> '{delivery,longitude}', '')::numeric,
            left(nullif(trim(p_payload #>> '{delivery,notes}'), ''), 500));
    insert into public.restaurant_delivery_jobs (order_id, organization_id, branch_id)
    values (v_order, v.organization_id, v.branch_id);
  end if;

  -- Paid on the platform: invoiced and paid now, so nothing is collected at the door.
  if coalesce((p_payload ->> 'paid')::boolean, false) then
    v_invoice := app.restaurant_issue_invoice(v_order);
    select total_cents into v_total from public.restaurant_orders where id = v_order;
    if v_total > 0 then
      insert into public.payments
        (organization_id, branch_id, invoice_id, kind, method, amount_cents, currency, status, reference, provider, provider_ref)
      values (v.organization_id, v.branch_id, v_invoice, 'payment', 'online', v_total, v_currency, 'completed',
              v_number, v.source, v_ext);
    end if;
  end if;

  if v.auto_confirm then
    update public.restaurant_orders set status = 'confirmed' where id = v_order;
  end if;
  update public.restaurant_integrations set last_used_at = now() where id = v.id;

  insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values (v.organization_id, v.branch_id, null, 'restaurant.intake.order', 'restaurant_order', v_order::text,
          jsonb_build_object('integration', v.id, 'source', v.source, 'external_id', v_ext));
  return jsonb_build_object('order_id', v_order, 'number', v_number,
                            'status', case when v.auto_confirm then 'confirmed' else 'new' end,
                            'total_cents', (select total_cents from public.restaurant_orders where id = v_order),
                            'duplicate', false);
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'app.approval_actions()', 'app.driver_ledger_immutable()', 'app.driver_balances(uuid)',
    'app.restaurant_issue_invoice(uuid, uuid)', 'app.delivery_job(uuid)', 'app.delivery_job_on_cancel()'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
  -- Policies call these as the reading user.
  foreach f in array array['app.fleet_can_read(uuid, uuid)', 'app.is_my_driver(uuid)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;

  foreach f in array array[
    'public.approval_grant(uuid, uuid, text, uuid, numeric, uuid, text)',
    'public.restaurant_delivery_zone_save(uuid, uuid, uuid, text, bigint, bigint, boolean)',
    'public.restaurant_driver_save(uuid, uuid, uuid, text, text, uuid, text, text, integer, bigint, boolean)',
    'public.restaurant_driver_shift(uuid, uuid, boolean)',
    'public.restaurant_delivery_assign(uuid, uuid, uuid, uuid)',
    'public.restaurant_delivery_status(uuid, uuid, text, text)',
    'public.restaurant_driver_float(uuid, uuid, bigint, text)',
    'public.restaurant_driver_settle(uuid, uuid, bigint, boolean)',
    'public.restaurant_driver_adjust(uuid, uuid, bigint, text)',
    'public.restaurant_callcenter_lookup(uuid, uuid, text)',
    'public.restaurant_customer_upsert(uuid, uuid, uuid, text, text, text)',
    'public.restaurant_customer_address_save(uuid, uuid, uuid, uuid, text, text, text, text, text, text, text, boolean)',
    'public.restaurant_callcenter_place_order(uuid, uuid, uuid, text, jsonb, jsonb, uuid, text, boolean)',
    'public.restaurant_integration_create(uuid, uuid, text, text, text, text, boolean)',
    'public.restaurant_integration_set(uuid, uuid, boolean, boolean)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;

  -- The intake is the server's alone: the route authenticates the key.
  foreach f in array array['public.restaurant_intake_menu(text)', 'public.restaurant_intake_order(text, jsonb)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
