-- =============================================================================
-- LOCAL BASIC — 0111 Retail & Clinic expansion (multi-industry schema)
--
-- One migration that turns the platform from "restaurant first" into three
-- operating modes sharing one Core: restaurant, retail and clinic.
--
--   1. Branch mode       branches.module_key + app.branch_module(); a branch can
--                        run a different enabled module from the org default.
--   2. Permissions       retail.* additions, clinic.* (module 'medical'), and
--                        doctor / nurse / receptionist role templates.
--   3. Approvals         retail.cashback (manager PIN on cash refunds) and
--                        retail.credit_adjust.
--   4. Retail            scale formats, alternate barcodes, promotions, a
--                        transfer workflow on retail_stock_transfers, receipt
--                        returns and a store-credit ledger.
--   5. Clinic            rooms, doctors, shifts, services and their supply BOM,
--                        patients, appointments, EMR, prescriptions and doctor
--                        commissions; supplies leave stock on completion.
--   6. Storage           a PRIVATE clinic-records bucket.
--   7. RPCs              the minimum to run both modules end to end; the rest
--                        ships in 0112 (retail) and 0113 (clinic).
--
-- CONVENTIONS KEPT
--   * The clinic module key stays 'medical' — it is already the allowed value
--     in organization_modules, permissions and every module CHECK. "Clinic" is
--     the product label and the route prefix (/clinic-*).
--   * Status/kind columns are text + CHECK, not ENUM types, like every other
--     table here: a CHECK is replaced in one statement inside a transaction,
--     an ENUM value cannot be removed at all.
--   * "stock_transfers" extends the existing retail_stock_transfers table
--     instead of adding a second transfer document; old rows and the immediate
--     transfer function keep working (status defaults to 'received').
--   * Every table carries organization_id, RLS enabled and forced, SELECT only
--     for authenticated; all writes go through SECURITY DEFINER functions.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Branch operating mode
-- ---------------------------------------------------------------------------
alter table public.branches
  add column module_key text check (module_key in ('retail', 'restaurant', 'medical', 'workshop'));

comment on column public.branches.module_key is
  'Operating mode of this branch; null = the organization primary_module.';

create or replace function app.branch_module_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.module_key is not null and not exists (
    select 1 from public.organization_modules m
     where m.organization_id = new.organization_id
       and m.module_key = new.module_key and m.enabled
  ) then
    raise exception 'هذا النشاط غير مفعّل للمؤسسة' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger branches_module_guard before insert or update of module_key on public.branches
  for each row execute function app.branch_module_guard();

create or replace function app.branch_module(p_branch uuid)
returns text language sql stable security definer set search_path = '' as $$
  select coalesce(b.module_key, o.primary_module)
    from public.branches b
    join public.organizations o on o.id = b.organization_id
   where b.id = p_branch;
$$;

-- ---------------------------------------------------------------------------
-- 2. Permissions and role templates
-- ---------------------------------------------------------------------------
insert into public.permissions (key, group_key, module_key, description, is_elevated) values
  ('retail.transfer.approve',  'retail', 'retail', 'Approve, dispatch and receive branch stock transfers', false),
  ('retail.return.manage',     'retail', 'retail', 'Process receipt-based returns and exchanges',          false),
  ('retail.promotion.manage',  'retail', 'retail', 'Create and edit retail promotions and codes',          false),
  ('retail.credit.manage',     'retail', 'retail', 'View and adjust customer store credit',                true),

  ('clinic.appointment.read',   'clinic', 'medical', 'View the appointment calendar',                       false),
  ('clinic.appointment.manage', 'clinic', 'medical', 'Book, move, check in and cancel appointments',        false),
  ('clinic.patient.read',       'clinic', 'medical', 'View patient demographic profiles',                   false),
  ('clinic.patient.manage',     'clinic', 'medical', 'Register and edit patient profiles',                  false),
  ('clinic.emr.read',           'clinic', 'medical', 'Read medical records: history, notes, vitals, files', true),
  ('clinic.emr.write',          'clinic', 'medical', 'Write medical records',                               true),
  ('clinic.prescription.write', 'clinic', 'medical', 'Issue and cancel prescriptions',                      true),
  ('clinic.service.manage',     'clinic', 'medical', 'Manage procedures, prices and their supplies',        false),
  ('clinic.doctor.manage',      'clinic', 'medical', 'Manage doctors, shifts, rooms and commission rules',  false),
  ('clinic.billing.use',        'clinic', 'medical', 'Bill completed visits at the clinic cashier',         false),
  ('clinic.commission.read',    'clinic', 'medical', 'View doctor commissions',                             true)
on conflict (key) do update
  set description = excluded.description, group_key = excluded.group_key,
      module_key = excluded.module_key, is_elevated = excluded.is_elevated;

insert into public.roles (organization_id, key, name_ar, name_en, description, is_system, is_owner, module_key) values
  (null, 'doctor',       'طبيب',      'Doctor',       'Sees own calendar, writes medical records and prescriptions', true, false, 'medical'),
  (null, 'nurse',        'تمريض',     'Nurse',        'Check-in, vitals and medical records; no billing',            true, false, 'medical'),
  (null, 'receptionist', 'استقبال',   'Receptionist', 'Calendar, patient registration and visit billing; no records', true, false, 'medical')
on conflict do nothing;

with grants(role_key, module_key, permission_key) as (values
  ('doctor', 'medical', 'clinic.appointment.read'), ('doctor', 'medical', 'clinic.patient.read'),
  ('doctor', 'medical', 'clinic.patient.manage'),   ('doctor', 'medical', 'clinic.emr.read'),
  ('doctor', 'medical', 'clinic.emr.write'),        ('doctor', 'medical', 'clinic.prescription.write'),

  ('nurse', 'medical', 'clinic.appointment.read'), ('nurse', 'medical', 'clinic.patient.read'),
  ('nurse', 'medical', 'clinic.emr.read'),         ('nurse', 'medical', 'clinic.emr.write'),

  ('receptionist', 'medical', 'clinic.appointment.read'), ('receptionist', 'medical', 'clinic.appointment.manage'),
  ('receptionist', 'medical', 'clinic.patient.read'),     ('receptionist', 'medical', 'clinic.patient.manage'),
  ('receptionist', 'medical', 'clinic.billing.use'),
  ('receptionist', 'medical', 'customer.read'),

  -- Managers run the clinic but do not read charts: EMR access is clinical.
  ('manager', '', 'clinic.appointment.read'), ('manager', '', 'clinic.appointment.manage'),
  ('manager', '', 'clinic.patient.read'),     ('manager', '', 'clinic.patient.manage'),
  ('manager', '', 'clinic.service.manage'),   ('manager', '', 'clinic.doctor.manage'),
  ('manager', '', 'clinic.billing.use'),      ('manager', '', 'clinic.commission.read'),
  ('admin',   '', 'clinic.appointment.read'), ('admin',   '', 'clinic.appointment.manage'),
  ('admin',   '', 'clinic.patient.read'),     ('admin',   '', 'clinic.patient.manage'),
  ('admin',   '', 'clinic.service.manage'),   ('admin',   '', 'clinic.doctor.manage'),
  ('admin',   '', 'clinic.billing.use'),      ('admin',   '', 'clinic.commission.read'),
  ('accountant', '', 'clinic.appointment.read'), ('accountant', '', 'clinic.commission.read'),

  ('manager', '', 'retail.transfer.approve'), ('manager', '', 'retail.return.manage'),
  ('manager', '', 'retail.promotion.manage'), ('manager', '', 'retail.credit.manage'),
  ('admin',   '', 'retail.transfer.approve'), ('admin',   '', 'retail.return.manage'),
  ('admin',   '', 'retail.promotion.manage'), ('admin',   '', 'retail.credit.manage'),
  ('cashier', 'retail', 'retail.return.manage')
)
insert into public.role_permissions (role_id, permission_key)
select r.id, g.permission_key
  from grants g
  join public.roles r on r.organization_id is null and r.key = g.role_key
                     and coalesce(r.module_key, '') = g.module_key
  join public.permissions p on p.key = g.permission_key
on conflict do nothing;

-- Organizations that already run the medical module get the new templates.
insert into public.roles (organization_id, key, name_ar, name_en, description, is_system, is_owner, module_key)
select m.organization_id, t.key, t.name_ar, t.name_en, t.description, true, false, t.module_key
  from public.organization_modules m
  join public.roles t on t.organization_id is null and t.module_key = 'medical'
                     and t.key in ('doctor', 'nurse', 'receptionist')
 where m.module_key = 'medical' and m.enabled
on conflict do nothing;

-- Existing organizations: their copies of the templates, then owners.
insert into public.role_permissions (role_id, permission_key)
select org_role.id, tp.permission_key
  from public.roles org_role
  join public.roles tpl on tpl.organization_id is null and tpl.is_system and tpl.key = org_role.key
                       and tpl.module_key is not distinct from org_role.module_key
  join public.role_permissions tp on tp.role_id = tpl.id
 where org_role.organization_id is not null
   and (tp.permission_key like 'clinic.%'
        or tp.permission_key in ('retail.transfer.approve', 'retail.return.manage',
                                 'retail.promotion.manage', 'retail.credit.manage')
        or org_role.key in ('doctor', 'nurse', 'receptionist'))
on conflict do nothing;

insert into public.role_permissions (role_id, permission_key)
select r.id, p.key from public.roles r cross join public.permissions p
 where r.is_owner and r.organization_id is not null
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 3. Approval gates
-- ---------------------------------------------------------------------------
create or replace function app.approval_actions()
returns text[] language sql immutable set search_path = '' as $$
  select array['order.cancel', 'order.discount', 'inventory.adjust', 'inventory.resolve',
               'table.merge', 'check.split',
               'driver.payout', 'driver.shortage', 'driver.adjust',
               'account.adjust', 'account.overlimit', 'loyalty.adjust',
               'refund.daily_limit', 'discount.daily_limit',
               'retail.cashback', 'retail.credit_adjust'];
$$;

alter table public.approval_grants drop constraint approval_grants_action_check;
alter table public.approval_grants add constraint approval_grants_action_check
  check (action = any (app.approval_actions()));

-- =============================================================================
-- 4. RETAIL
-- =============================================================================

-- 4a. Weight / price embedded barcodes (EAN-13 "2x" in-store codes).
--     Layout: prefix | item code | value | check digit.
create table public.retail_scale_formats (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  name             text not null check (length(trim(name)) between 1 and 80),
  prefix           text not null check (prefix ~ '^[0-9]{1,3}$'),
  code_digits      smallint not null default 5 check (code_digits between 4 and 6),
  value_kind       text not null default 'weight' check (value_kind in ('weight', 'price')),
  -- weight: grams when 3 (value 01250 = 1.250 kg); price: minor-unit decimals.
  value_decimals   smallint not null default 3 check (value_decimals between 0 and 3),
  total_length     smallint not null default 13 check (total_length in (12, 13)),
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  unique (organization_id, prefix),
  constraint retail_scale_formats_fits check (length(prefix) + code_digits + 1 < total_length)
);

alter table public.retail_variants
  add column scale_code            text check (scale_code ~ '^[0-9]{4,6}$'),
  add column reorder_qty           numeric(14,3) not null default 0 check (reorder_qty >= 0),
  add column preferred_supplier_id uuid references public.retail_suppliers(id) on delete set null;
create unique index retail_variants_scale_code_unique
  on public.retail_variants(organization_id, scale_code)
  where scale_code is not null and deleted_at is null;

-- 4b. Alternate barcodes: a second supplier code, or a carton that scans as N units.
create table public.retail_barcodes (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  variant_id       uuid not null references public.retail_variants(id) on delete cascade,
  barcode          text not null check (barcode ~ '^[0-9A-Za-z._-]{3,64}$'),
  pack_qty         numeric(14,3) not null default 1 check (pack_qty > 0),
  label            text check (label is null or length(label) <= 80),
  created_by       uuid references public.profiles(id),
  created_at       timestamptz not null default now(),
  unique (organization_id, barcode)
);
create index retail_barcodes_variant_idx on public.retail_barcodes(variant_id);

-- One code, one meaning: an alternate barcode may not shadow a variant's own.
create or replace function app.retail_barcode_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'retail_barcodes' then
    if not exists (select 1 from public.retail_variants v
                    where v.id = new.variant_id and v.organization_id = new.organization_id) then
      raise exception 'الصنف لا يتبع هذه المؤسسة' using errcode = 'check_violation';
    end if;
    if exists (select 1 from public.retail_variants v
                where v.organization_id = new.organization_id and v.deleted_at is null
                  and v.barcode = new.barcode) then
      raise exception 'الباركود مستخدم لصنف آخر' using errcode = 'unique_violation';
    end if;
  elsif new.barcode is not null and exists (
    select 1 from public.retail_barcodes b
     where b.organization_id = new.organization_id and b.barcode = new.barcode
       and b.variant_id <> new.id) then
    raise exception 'الباركود مستخدم كباركود بديل' using errcode = 'unique_violation';
  end if;
  return new;
end;
$$;
create trigger retail_barcodes_guard before insert or update on public.retail_barcodes
  for each row execute function app.retail_barcode_guard();
create trigger retail_variants_barcode_guard before insert or update of barcode on public.retail_variants
  for each row execute function app.retail_barcode_guard();

-- 4c. Promotions: percent, fixed amount, buy-X-get-Y and bundle price.
--     A code makes it a coupon; a window makes it seasonal.
create table public.retail_promotions (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null references public.organizations(id) on delete cascade,
  branch_id               uuid references public.branches(id) on delete cascade, -- null = every branch
  name                    text not null check (length(trim(name)) between 1 and 120),
  kind                    text not null check (kind in ('percent', 'amount', 'bogo', 'bundle')),
  code                    citext check (code is null or code ~ '^[A-Za-z0-9_-]{3,32}$'),
  percent_off             numeric(5,2) check (percent_off > 0 and percent_off <= 100),
  amount_off_cents        bigint check (amount_off_cents > 0),
  buy_qty                 integer check (buy_qty > 0),
  get_qty                 integer check (get_qty > 0),
  get_percent_off         numeric(5,2) not null default 100 check (get_percent_off > 0 and get_percent_off <= 100),
  bundle_price_cents      bigint check (bundle_price_cents >= 0),
  min_subtotal_cents      bigint not null default 0 check (min_subtotal_cents >= 0),
  max_discount_cents      bigint check (max_discount_cents > 0),
  -- Loyalty hooks: members-only offers and bonus points on promoted lines.
  requires_customer       boolean not null default false,
  points_multiplier       numeric(4,2) not null default 1 check (points_multiplier between 0 and 10),
  starts_at               timestamptz,
  ends_at                 timestamptz,
  max_uses                integer check (max_uses > 0),
  max_uses_per_customer   integer check (max_uses_per_customer > 0),
  uses_count              integer not null default 0 check (uses_count >= 0),
  priority                smallint not null default 0,
  stackable               boolean not null default false,
  is_active               boolean not null default true,
  created_by              uuid references public.profiles(id),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  deleted_at              timestamptz,
  constraint retail_promotions_window check (ends_at is null or starts_at is null or ends_at > starts_at),
  constraint retail_promotions_shape check (
       (kind = 'percent' and percent_off is not null)
    or (kind = 'amount'  and amount_off_cents is not null)
    or (kind = 'bogo'    and buy_qty is not null and get_qty is not null)
    or (kind = 'bundle'  and bundle_price_cents is not null))
);
create unique index retail_promotions_code_unique
  on public.retail_promotions(organization_id, code) where code is not null and deleted_at is null;
create index retail_promotions_active_idx
  on public.retail_promotions(organization_id, starts_at, ends_at) where is_active and deleted_at is null;
create trigger retail_promotions_touch before update on public.retail_promotions
  for each row execute function app.touch_updated_at();

-- What a promotion applies to (percent/amount/bogo), or what a bundle contains.
create table public.retail_promotion_items (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  promotion_id     uuid not null references public.retail_promotions(id) on delete cascade,
  product_id       uuid references public.retail_products(id) on delete cascade,
  variant_id       uuid references public.retail_variants(id) on delete cascade,
  category_id      uuid references public.retail_categories(id) on delete cascade,
  quantity         numeric(14,3) not null default 1 check (quantity > 0),
  constraint retail_promotion_items_one_target
    check (num_nonnulls(product_id, variant_id, category_id) = 1)
);
create index retail_promotion_items_promo_idx on public.retail_promotion_items(promotion_id);

-- Every application of a promotion to a sale. Append-only; feeds limits and reports.
create table public.retail_sale_promotions (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  branch_id        uuid not null references public.branches(id) on delete cascade,
  invoice_id       uuid not null references public.invoices(id) on delete cascade,
  promotion_id     uuid not null references public.retail_promotions(id) on delete restrict,
  customer_id      uuid references public.customers(id) on delete set null,
  code             citext,
  discount_cents   bigint not null check (discount_cents >= 0),
  created_at       timestamptz not null default now(),
  unique (invoice_id, promotion_id)
);
create index retail_sale_promotions_promo_idx on public.retail_sale_promotions(promotion_id, customer_id);

-- 4d. Transfer workflow on the existing document.
--     requested → approved → in_transit → received; requested → rejected;
--     requested|approved → cancelled. Old immediate transfers are 'received'.
alter table public.retail_stock_transfers
  add column status        text not null default 'received'
                           check (status in ('requested', 'approved', 'in_transit', 'received', 'cancelled', 'rejected')),
  add column number        text,
  add column reason        text check (reason is null or length(reason) <= 300),
  add column auto_generated boolean not null default false,
  add column requested_at  timestamptz,
  add column approved_by   uuid references public.profiles(id),
  add column approved_at   timestamptz,
  add column dispatched_by uuid references public.profiles(id),
  add column dispatched_at timestamptz,
  add column received_by   uuid references public.profiles(id),
  add column received_at   timestamptz,
  add column cancelled_by  uuid references public.profiles(id),
  add column cancelled_at  timestamptz,
  add column cancel_reason text check (cancel_reason is null or length(cancel_reason) <= 300);
create unique index retail_stock_transfers_number_unique
  on public.retail_stock_transfers(organization_id, number) where number is not null;
create index retail_stock_transfers_open_idx
  on public.retail_stock_transfers(organization_id, status)
  where status in ('requested', 'approved', 'in_transit');

alter table public.retail_stock_transfer_lines
  add column quantity_received numeric(14,3) check (quantity_received >= 0);

create or replace function app.retail_transfer_state()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status is distinct from old.status and not (
       (old.status = 'requested'  and new.status in ('approved', 'rejected', 'cancelled'))
    or (old.status = 'approved'   and new.status in ('in_transit', 'cancelled'))
    or (old.status = 'in_transit' and new.status = 'received')
  ) then
    raise exception 'لا يمكن نقل التحويل من % إلى %', old.status, new.status using errcode = 'check_violation';
  end if;
  if new.from_branch_id <> old.from_branch_id or new.to_branch_id <> old.to_branch_id
     or new.organization_id <> old.organization_id then
    raise exception 'لا يمكن تغيير فروع التحويل' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger retail_stock_transfers_state before update on public.retail_stock_transfers
  for each row execute function app.retail_transfer_state();

alter table public.retail_purchase_orders
  add column auto_generated boolean not null default false;

-- 4e. Receipt-based returns and exchanges.
create table public.retail_returns (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references public.organizations(id) on delete cascade,
  branch_id            uuid not null references public.branches(id) on delete restrict,
  number               text not null,
  original_invoice_id  uuid not null references public.invoices(id) on delete restrict,
  customer_id          uuid references public.customers(id) on delete set null,
  resolution           text not null check (resolution in ('cash', 'card', 'store_credit', 'exchange')),
  refund_cents         bigint not null default 0 check (refund_cents >= 0),
  store_credit_cents   bigint not null default 0 check (store_credit_cents >= 0),
  exchange_invoice_id  uuid references public.invoices(id) on delete set null,
  reason               text check (reason is null or length(reason) <= 300),
  -- Cash leaving the drawer needs a manager (approval action 'retail.cashback').
  cashback_approved_by uuid references public.profiles(id),
  created_by           uuid references public.profiles(id),
  created_at           timestamptz not null default now(),
  unique (organization_id, branch_id, number),
  constraint retail_returns_cash_approved
    check (resolution <> 'cash' or refund_cents = 0 or cashback_approved_by is not null),
  constraint retail_returns_credit_needs_customer
    check (store_credit_cents = 0 or customer_id is not null)
);
create index retail_returns_invoice_idx on public.retail_returns(original_invoice_id);
create index retail_returns_branch_idx on public.retail_returns(branch_id, created_at desc);

create table public.retail_return_lines (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  return_id        uuid not null references public.retail_returns(id) on delete cascade,
  variant_id       uuid not null references public.retail_variants(id) on delete restrict,
  quantity         numeric(14,3) not null check (quantity > 0),
  unit_price_cents bigint not null check (unit_price_cents >= 0),
  -- resellable goes back on the shelf; damaged is written off (movement 'damage').
  condition        text not null default 'resellable' check (condition in ('resellable', 'damaged')),
  note             text check (note is null or length(note) <= 300)
);
create index retail_return_lines_return_idx on public.retail_return_lines(return_id);

-- 4f. Store credit: append-only signed ledger, never negative per customer.
create table public.retail_store_credits (
  id               bigint generated always as identity primary key,
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  customer_id      uuid not null references public.customers(id) on delete cascade,
  branch_id        uuid references public.branches(id) on delete set null,
  kind             text not null check (kind in ('issue', 'redeem', 'adjust', 'expire')),
  delta_cents      bigint not null check (delta_cents <> 0),
  ref_type         text check (ref_type in ('return', 'invoice', 'manual')),
  ref_id           uuid,
  note             text check (note is null or length(note) <= 300),
  created_by       uuid references public.profiles(id),
  approved_by      uuid references public.profiles(id),
  created_at       timestamptz not null default now(),
  constraint retail_store_credits_sign check (
       (kind = 'issue'  and delta_cents > 0)
    or (kind in ('redeem', 'expire') and delta_cents < 0)
    or  kind = 'adjust')
);
create index retail_store_credits_customer_idx on public.retail_store_credits(customer_id, created_at desc);

create or replace function app.retail_store_credit_balance(p_org uuid, p_customer uuid)
returns bigint language sql stable security definer set search_path = '' as $$
  select coalesce(sum(delta_cents), 0)::bigint from public.retail_store_credits
   where organization_id = p_org and customer_id = p_customer;
$$;

create or replace function app.retail_store_credit_write()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if not exists (select 1 from public.customers c
                    where c.id = new.customer_id and c.organization_id = new.organization_id) then
      raise exception 'العميل لا يتبع هذه المؤسسة' using errcode = 'check_violation';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('store_credit:' || new.customer_id::text, 0));
    if app.retail_store_credit_balance(new.organization_id, new.customer_id) + new.delta_cents < 0 then
      raise exception 'رصيد العميل غير كافٍ' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' and not exists (select 1 from public.customers where id = old.customer_id) then
    return old;
  end if;
  raise exception 'store credit is append-only; record a correcting entry instead' using errcode = 'check_violation';
end;
$$;
create trigger retail_store_credits_write before insert or update or delete on public.retail_store_credits
  for each row execute function app.retail_store_credit_write();

-- =============================================================================
-- 5. CLINIC
-- =============================================================================

-- Medical supplies are consumed from their own location in each branch.
alter table public.inventory_locations drop constraint inventory_locations_kind_check;
alter table public.inventory_locations add constraint inventory_locations_kind_check
  check (kind in ('warehouse', 'kitchen', 'bar', 'transit', 'waste', 'clinic'));

create table public.clinic_rooms (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  branch_id        uuid not null references public.branches(id) on delete cascade,
  name             text not null check (length(trim(name)) between 1 and 80),
  kind             text not null default 'consultation'
                   check (kind in ('consultation', 'procedure', 'imaging', 'lab', 'other')),
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  unique (branch_id, name)
);

create table public.clinic_doctors (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null references public.organizations(id) on delete cascade,
  -- The doctor's login, when they have one. A visiting doctor may not.
  member_id               uuid references public.organization_members(id) on delete set null,
  display_name            text not null check (length(trim(display_name)) between 1 and 120),
  specialty               text check (specialty is null or length(specialty) <= 120),
  license_number          text check (license_number is null or length(license_number) <= 60),
  phone                   text,
  consultation_fee_cents  bigint not null default 0 check (consultation_fee_cents >= 0),
  commission_mode         text not null default 'none' check (commission_mode in ('percent', 'fixed', 'none')),
  commission_percent      numeric(5,2) check (commission_percent between 0 and 100),
  commission_fixed_cents  bigint check (commission_fixed_cents >= 0),
  color                   text check (color is null or color ~ '^#[0-9A-Fa-f]{6}$'),
  is_active               boolean not null default true,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  deleted_at              timestamptz,
  constraint clinic_doctors_commission check (
       commission_mode = 'none'
    or (commission_mode = 'percent' and commission_percent is not null)
    or (commission_mode = 'fixed'   and commission_fixed_cents is not null))
);
create unique index clinic_doctors_member_unique
  on public.clinic_doctors(organization_id, member_id) where member_id is not null and deleted_at is null;
create trigger clinic_doctors_touch before update on public.clinic_doctors
  for each row execute function app.touch_updated_at();

create table public.clinic_doctor_shifts (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  branch_id        uuid not null references public.branches(id) on delete cascade,
  doctor_id        uuid not null references public.clinic_doctors(id) on delete cascade,
  room_id          uuid references public.clinic_rooms(id) on delete set null,
  weekday          smallint not null check (weekday between 0 and 6), -- 0 = Sunday
  starts_at        time not null,
  ends_at          time not null,
  slot_minutes     smallint not null default 15 check (slot_minutes between 5 and 240),
  valid_from       date,
  valid_to         date,
  created_at       timestamptz not null default now(),
  constraint clinic_shifts_order check (ends_at > starts_at),
  constraint clinic_shifts_validity check (valid_to is null or valid_from is null or valid_to >= valid_from)
);
create index clinic_doctor_shifts_doctor_idx on public.clinic_doctor_shifts(doctor_id, weekday);
create index clinic_doctor_shifts_branch_idx on public.clinic_doctor_shifts(branch_id, weekday);

create table public.clinic_services (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null references public.organizations(id) on delete cascade,
  name                    text not null check (length(trim(name)) between 1 and 160),
  code                    text check (code is null or length(code) <= 40),
  category                text check (category is null or length(category) <= 80),
  price_cents             bigint not null check (price_cents >= 0),
  duration_minutes        smallint not null default 15 check (duration_minutes between 5 and 600),
  -- Overrides the doctor's commission rule for this procedure; null = doctor default.
  commission_mode         text check (commission_mode in ('percent', 'fixed', 'none')),
  commission_percent      numeric(5,2) check (commission_percent between 0 and 100),
  commission_fixed_cents  bigint check (commission_fixed_cents >= 0),
  is_active               boolean not null default true,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  deleted_at              timestamptz,
  constraint clinic_services_commission check (
       commission_mode is null or commission_mode = 'none'
    or (commission_mode = 'percent' and commission_percent is not null)
    or (commission_mode = 'fixed'   and commission_fixed_cents is not null))
);
create unique index clinic_services_name_unique
  on public.clinic_services(organization_id, lower(trim(name))) where deleted_at is null;
create trigger clinic_services_touch before update on public.clinic_services
  for each row execute function app.touch_updated_at();

-- The procedure's bill of materials: what leaves stock each time it is performed.
create table public.clinic_service_supplies (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  service_id       uuid not null references public.clinic_services(id) on delete cascade,
  item_id          uuid not null references public.inventory_items(id) on delete restrict,
  qty              numeric(14,3) not null check (qty > 0),
  unique (service_id, item_id)
);

create table public.clinic_patients (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references public.organizations(id) on delete cascade,
  -- Registering branch: provenance, not a fence. Patients are org-wide.
  branch_id                uuid not null references public.branches(id) on delete restrict,
  file_number              text not null,
  customer_id              uuid references public.customers(id) on delete set null,
  full_name                text not null check (length(trim(full_name)) between 1 and 160),
  phone                    text,
  phone_key                text,
  national_id              text check (national_id is null or length(national_id) <= 30),
  gender                   text check (gender in ('male', 'female')),
  date_of_birth            date check (date_of_birth is null or date_of_birth >= date '1900-01-01'),
  blood_type               text check (blood_type in ('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-')),
  allergies                text check (allergies is null or length(allergies) <= 2000),
  chronic_conditions       text check (chronic_conditions is null or length(chronic_conditions) <= 2000),
  emergency_contact_name   text check (emergency_contact_name is null or length(emergency_contact_name) <= 120),
  emergency_contact_phone  text,
  notes                    text check (notes is null or length(notes) <= 2000),
  created_by               uuid references public.profiles(id),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  deleted_at               timestamptz,
  unique (organization_id, branch_id, file_number)
);
create index clinic_patients_phone_idx on public.clinic_patients(organization_id, phone_key) where deleted_at is null;
create index clinic_patients_name_idx on public.clinic_patients(organization_id, lower(full_name)) where deleted_at is null;
create trigger clinic_patients_touch before update on public.clinic_patients
  for each row execute function app.touch_updated_at();

create or replace function app.clinic_patient_defaults()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.phone_key := case when new.phone is null then null else app.phone_key(new.phone) end;
  if tg_op = 'INSERT' and coalesce(new.file_number, '') = '' then
    new.file_number := 'P-' || app.next_document_number(new.organization_id, new.branch_id, 'clinic_patient');
  end if;
  return new;
end;
$$;
create trigger clinic_patients_defaults before insert or update of phone on public.clinic_patients
  for each row execute function app.clinic_patient_defaults();

create table public.clinic_appointments (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations(id) on delete cascade,
  branch_id          uuid not null references public.branches(id) on delete restrict,
  patient_id         uuid not null references public.clinic_patients(id) on delete restrict,
  doctor_id          uuid not null references public.clinic_doctors(id) on delete restrict,
  room_id            uuid references public.clinic_rooms(id) on delete set null,
  starts_at          timestamptz not null,
  ends_at            timestamptz not null,
  status             text not null default 'booked'
                     check (status in ('booked', 'checked_in', 'in_session', 'completed', 'cancelled', 'no_show')),
  source             text not null default 'staff' check (source in ('staff', 'phone', 'walk_in', 'online')),
  reason             text check (reason is null or length(reason) <= 300),
  booked_by          uuid references public.profiles(id),
  checked_in_at      timestamptz,
  session_started_at timestamptz,
  completed_at       timestamptz,
  cancelled_at       timestamptz,
  cancelled_by       uuid references public.profiles(id),
  cancel_reason      text check (cancel_reason is null or length(cancel_reason) <= 300),
  invoice_id         uuid references public.invoices(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint clinic_appointments_order check (ends_at > starts_at),
  constraint clinic_appointments_length check (ends_at - starts_at <= interval '12 hours')
);
create index clinic_appointments_branch_idx on public.clinic_appointments(branch_id, starts_at);
create index clinic_appointments_doctor_idx on public.clinic_appointments(doctor_id, starts_at);
create index clinic_appointments_room_idx on public.clinic_appointments(room_id, starts_at) where room_id is not null;
create index clinic_appointments_patient_idx on public.clinic_appointments(patient_id, starts_at desc);
create trigger clinic_appointments_touch before update on public.clinic_appointments
  for each row execute function app.touch_updated_at();

-- Same-tenant references, no double booking, and a one-way status machine.
create or replace function app.clinic_appointment_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_active constant text[] := array['booked', 'checked_in', 'in_session'];
begin
  if tg_op = 'UPDATE' then
    if new.organization_id <> old.organization_id or new.patient_id <> old.patient_id then
      raise exception 'لا يمكن نقل الموعد لمريض أو مؤسسة أخرى' using errcode = 'check_violation';
    end if;
    if new.status is distinct from old.status and not (
         (old.status = 'booked'     and new.status in ('checked_in', 'cancelled', 'no_show'))
      or (old.status = 'checked_in' and new.status in ('in_session', 'cancelled'))
      or (old.status = 'in_session' and new.status = 'completed')
    ) then
      raise exception 'لا يمكن نقل الموعد من % إلى %', old.status, new.status using errcode = 'check_violation';
    end if;
    if old.status not in ('booked', 'checked_in')
       and (new.starts_at <> old.starts_at or new.ends_at <> old.ends_at or new.doctor_id <> old.doctor_id) then
      raise exception 'لا يمكن تعديل موعد بدأ بالفعل' using errcode = 'check_violation';
    end if;
    case new.status
      when 'checked_in' then new.checked_in_at := coalesce(new.checked_in_at, now());
      when 'in_session' then new.session_started_at := coalesce(new.session_started_at, now());
      when 'completed'  then new.completed_at := coalesce(new.completed_at, now());
      when 'cancelled'  then new.cancelled_at := coalesce(new.cancelled_at, now());
      else null;
    end case;
  elsif new.status <> 'booked' then
    raise exception 'الموعد الجديد يبدأ محجوزًا' using errcode = 'check_violation';
  end if;

  if not exists (select 1 from public.clinic_patients p
                  where p.id = new.patient_id and p.organization_id = new.organization_id and p.deleted_at is null)
     or not exists (select 1 from public.clinic_doctors d
                     where d.id = new.doctor_id and d.organization_id = new.organization_id and d.deleted_at is null)
     or not exists (select 1 from public.branches b
                     where b.id = new.branch_id and b.organization_id = new.organization_id)
     or (new.room_id is not null and not exists (
           select 1 from public.clinic_rooms r where r.id = new.room_id and r.branch_id = new.branch_id)) then
    raise exception 'بيانات الموعد لا تتبع هذه المؤسسة أو الفرع' using errcode = 'check_violation';
  end if;

  if new.status = any (v_active) then
    perform pg_advisory_xact_lock(hashtextextended('clinic_doctor:' || new.doctor_id::text, 0));
    if exists (
      select 1 from public.clinic_appointments a
       where a.doctor_id = new.doctor_id and a.id <> new.id and a.status = any (v_active)
         and tstzrange(a.starts_at, a.ends_at) && tstzrange(new.starts_at, new.ends_at)) then
      raise exception 'الطبيب لديه موعد آخر في هذا الوقت' using errcode = 'LB409';
    end if;
    if new.room_id is not null then
      perform pg_advisory_xact_lock(hashtextextended('clinic_room:' || new.room_id::text, 0));
      if exists (
        select 1 from public.clinic_appointments a
         where a.room_id = new.room_id and a.id <> new.id and a.status = any (v_active)
           and tstzrange(a.starts_at, a.ends_at) && tstzrange(new.starts_at, new.ends_at)) then
        raise exception 'الغرفة محجوزة في هذا الوقت' using errcode = 'LB409';
      end if;
    end if;
  end if;
  return new;
end;
$$;
create trigger clinic_appointments_guard before insert or update on public.clinic_appointments
  for each row execute function app.clinic_appointment_guard();

-- Billable procedure lines of a visit. Priced from clinic_services at booking.
create table public.clinic_appointment_services (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references public.organizations(id) on delete cascade,
  appointment_id        uuid not null references public.clinic_appointments(id) on delete cascade,
  service_id            uuid not null references public.clinic_services(id) on delete restrict,
  -- Who performed it; defaults to the appointment's doctor.
  doctor_id             uuid not null references public.clinic_doctors(id) on delete restrict,
  quantity              integer not null default 1 check (quantity between 1 and 100),
  unit_price_cents      bigint not null check (unit_price_cents >= 0),
  discount_cents        bigint not null default 0 check (discount_cents >= 0),
  supplies_consumed_at  timestamptz,
  created_at            timestamptz not null default now(),
  constraint clinic_appointment_services_discount check (discount_cents <= quantity * unit_price_cents)
);
create index clinic_appointment_services_appt_idx on public.clinic_appointment_services(appointment_id);

-- Commission accrues once per performed line, when the visit completes.
create table public.clinic_doctor_commissions (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references public.organizations(id) on delete cascade,
  branch_id                uuid not null references public.branches(id) on delete cascade,
  doctor_id                uuid not null references public.clinic_doctors(id) on delete restrict,
  appointment_id           uuid not null references public.clinic_appointments(id) on delete cascade,
  appointment_service_id   uuid not null unique references public.clinic_appointment_services(id) on delete cascade,
  mode                     text not null check (mode in ('percent', 'fixed')),
  base_cents               bigint not null check (base_cents >= 0),
  commission_cents         bigint not null check (commission_cents >= 0),
  paid_at                  timestamptz,
  created_at               timestamptz not null default now()
);
create index clinic_doctor_commissions_doctor_idx on public.clinic_doctor_commissions(doctor_id, created_at desc);

-- Completion: consume each line's supplies from the branch 'clinic' location
-- and accrue the performer's commission. Idempotent per line.
create or replace function app.clinic_complete_appointment(p_appointment uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_appt record;
  v_line record;
  v_sup  record;
  v_loc  uuid;
  v_mode text;
  v_base bigint;
  v_amt  bigint;
begin
  select id, organization_id, branch_id into v_appt from public.clinic_appointments where id = p_appointment;
  if v_appt.id is null then return; end if;

  for v_line in
    select l.*, s.commission_mode as s_mode, s.commission_percent as s_pct, s.commission_fixed_cents as s_fixed,
           d.commission_mode as d_mode, d.commission_percent as d_pct, d.commission_fixed_cents as d_fixed
      from public.clinic_appointment_services l
      join public.clinic_services s on s.id = l.service_id
      join public.clinic_doctors d on d.id = l.doctor_id
     where l.appointment_id = p_appointment and l.supplies_consumed_at is null
     for update of l
  loop
    for v_sup in select item_id, qty from public.clinic_service_supplies where service_id = v_line.service_id loop
      v_loc := coalesce(v_loc, app.inventory_location(v_appt.organization_id, v_appt.branch_id, 'clinic'));
      perform app.inventory_move(v_appt.organization_id, v_appt.branch_id, v_loc, v_sup.item_id,
                                 -(v_sup.qty * v_line.quantity), 'consumption',
                                 'clinic_appointment', p_appointment, null, null, v_line.id);
    end loop;

    v_base := v_line.quantity * v_line.unit_price_cents - v_line.discount_cents;
    v_mode := coalesce(v_line.s_mode, v_line.d_mode);
    v_amt := case v_mode
               when 'percent' then round(v_base * coalesce(case when v_line.s_mode is not null then v_line.s_pct else v_line.d_pct end, 0) / 100.0)::bigint
               when 'fixed'   then v_line.quantity * coalesce(case when v_line.s_mode is not null then v_line.s_fixed else v_line.d_fixed end, 0)
               else 0
             end;
    if v_mode in ('percent', 'fixed') then
      insert into public.clinic_doctor_commissions
        (organization_id, branch_id, doctor_id, appointment_id, appointment_service_id, mode, base_cents, commission_cents)
      values (v_appt.organization_id, v_appt.branch_id, v_line.doctor_id, p_appointment, v_line.id,
              v_mode, v_base, greatest(v_amt, 0))
      on conflict (appointment_service_id) do nothing;
    end if;

    update public.clinic_appointment_services set supplies_consumed_at = now() where id = v_line.id;
  end loop;
end;
$$;

create or replace function app.clinic_appointment_after()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'completed' and old.status is distinct from 'completed' then
    perform app.clinic_complete_appointment(new.id);
  end if;
  return null;
end;
$$;
create trigger clinic_appointments_after after update of status on public.clinic_appointments
  for each row execute function app.clinic_appointment_after();

-- Medical record entries. Append-only: a correction is an 'amendment' row.
create table public.clinic_emr_records (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations(id) on delete cascade,
  branch_id          uuid not null references public.branches(id) on delete restrict,
  patient_id         uuid not null references public.clinic_patients(id) on delete cascade,
  appointment_id     uuid references public.clinic_appointments(id) on delete set null,
  doctor_id          uuid references public.clinic_doctors(id) on delete set null,
  author_id          uuid not null references public.profiles(id),
  record_type        text not null check (record_type in ('note', 'diagnosis', 'vitals', 'history', 'attachment', 'amendment')),
  title              text check (title is null or length(title) <= 200),
  body               text check (body is null or length(body) <= 20000),
  diagnosis_code     text check (diagnosis_code is null or diagnosis_code ~ '^[A-Z][0-9]{2}(\.[0-9A-Z]{1,4})?$'),
  temperature_c      numeric(4,1) check (temperature_c between 30 and 45),
  pulse_bpm          smallint check (pulse_bpm between 20 and 250),
  systolic_mmhg      smallint check (systolic_mmhg between 50 and 260),
  diastolic_mmhg     smallint check (diastolic_mmhg between 30 and 160),
  respiratory_rate   smallint check (respiratory_rate between 5 and 80),
  spo2_percent       smallint check (spo2_percent between 50 and 100),
  weight_kg          numeric(5,2) check (weight_kg between 0.3 and 400),
  height_cm          numeric(5,1) check (height_cm between 20 and 250),
  glucose_mg_dl      smallint check (glucose_mg_dl between 10 and 1000),
  attachment_path    text check (attachment_path is null or length(attachment_path) <= 400),
  attachment_mime    text check (attachment_mime is null or length(attachment_mime) <= 100),
  attachment_bytes   bigint check (attachment_bytes is null or attachment_bytes > 0),
  amends_id          uuid references public.clinic_emr_records(id) on delete restrict,
  created_at         timestamptz not null default now(),
  constraint clinic_emr_shape check (
       (record_type = 'vitals' and num_nonnulls(temperature_c, pulse_bpm, systolic_mmhg, diastolic_mmhg,
                                                respiratory_rate, spo2_percent, weight_kg, height_cm, glucose_mg_dl) > 0)
    or (record_type = 'attachment' and attachment_path is not null)
    or (record_type = 'amendment'  and amends_id is not null and body is not null)
    or (record_type = 'diagnosis'  and (diagnosis_code is not null or body is not null))
    or (record_type in ('note', 'history') and body is not null)),
  constraint clinic_emr_bp check (systolic_mmhg is null or diastolic_mmhg is null or systolic_mmhg > diastolic_mmhg)
);
create index clinic_emr_patient_idx on public.clinic_emr_records(patient_id, created_at desc);
create index clinic_emr_appointment_idx on public.clinic_emr_records(appointment_id) where appointment_id is not null;

create or replace function app.clinic_emr_immutable()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' and (
       not exists (select 1 from public.clinic_patients where id = old.patient_id)
    or not exists (select 1 from public.organizations where id = old.organization_id)) then
    return old;
  end if;
  raise exception 'medical records are append-only; add an amendment instead' using errcode = 'check_violation';
end;
$$;
create trigger clinic_emr_no_update before update or delete on public.clinic_emr_records
  for each row execute function app.clinic_emr_immutable();

create table public.clinic_prescriptions (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations(id) on delete cascade,
  branch_id          uuid not null references public.branches(id) on delete restrict,
  patient_id         uuid not null references public.clinic_patients(id) on delete cascade,
  appointment_id     uuid references public.clinic_appointments(id) on delete set null,
  doctor_id          uuid not null references public.clinic_doctors(id) on delete restrict,
  number             text not null,
  status             text not null default 'issued' check (status in ('issued', 'cancelled')),
  notes              text check (notes is null or length(notes) <= 2000),
  -- Opaque token for the printable / WhatsApp share link. Never a uuid.
  public_token       text not null unique default app.new_public_token(),
  token_expires_at   timestamptz not null default now() + interval '30 days',
  issued_by          uuid references public.profiles(id),
  issued_at          timestamptz not null default now(),
  cancelled_by       uuid references public.profiles(id),
  cancelled_at       timestamptz,
  cancel_reason      text check (cancel_reason is null or length(cancel_reason) <= 300),
  unique (organization_id, branch_id, number)
);
create index clinic_prescriptions_patient_idx on public.clinic_prescriptions(patient_id, issued_at desc);

create table public.clinic_prescription_items (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  prescription_id  uuid not null references public.clinic_prescriptions(id) on delete cascade,
  position         smallint not null default 0,
  drug_name        text not null check (length(trim(drug_name)) between 1 and 160),
  strength         text check (strength is null or length(strength) <= 60),
  dosage_form      text check (dosage_form is null or length(dosage_form) <= 60),
  dose             text check (dose is null or length(dose) <= 60),
  route            text check (route is null or length(route) <= 40),
  frequency        text check (frequency is null or length(frequency) <= 80),
  duration         text check (duration is null or length(duration) <= 60),
  instructions     text check (instructions is null or length(instructions) <= 500)
);
create index clinic_prescription_items_rx_idx on public.clinic_prescription_items(prescription_id, position);

-- =============================================================================
-- 6. RLS
-- =============================================================================
do $$
declare t text;
begin
  foreach t in array array[
    'retail_scale_formats', 'retail_barcodes', 'retail_promotions', 'retail_promotion_items',
    'retail_sale_promotions', 'retail_returns', 'retail_return_lines', 'retail_store_credits',
    'clinic_rooms', 'clinic_doctors', 'clinic_doctor_shifts', 'clinic_services', 'clinic_service_supplies',
    'clinic_patients', 'clinic_appointments', 'clinic_appointment_services', 'clinic_doctor_commissions',
    'clinic_emr_records', 'clinic_prescriptions', 'clinic_prescription_items'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;

-- Anyone on the clinic team may read its setup (rooms, doctors, shifts, prices).
create or replace function app.clinic_staff(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select app.has_permission(p_org, 'clinic.appointment.read')
      or app.has_permission(p_org, 'clinic.patient.read')
      or app.has_permission(p_org, 'clinic.emr.read')
      or app.has_permission(p_org, 'clinic.service.manage')
      or app.has_permission(p_org, 'clinic.doctor.manage');
$$;

-- The clinic_doctors row of the signed-in user in this org, if any.
create or replace function app.clinic_my_doctor(p_org uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select d.id from public.clinic_doctors d
    join public.organization_members m on m.id = d.member_id
   where d.organization_id = p_org and m.user_id = auth.uid() and m.status = 'active'
     and d.deleted_at is null
   limit 1;
$$;

create policy retail_scale_formats_select on public.retail_scale_formats
  for select to authenticated using (app.is_member_of(organization_id));
create policy retail_barcodes_select on public.retail_barcodes
  for select to authenticated using (app.is_member_of(organization_id));
create policy retail_promotions_select on public.retail_promotions
  for select to authenticated using (app.is_member_of(organization_id));
create policy retail_promotion_items_select on public.retail_promotion_items
  for select to authenticated using (app.is_member_of(organization_id));
create policy retail_sale_promotions_select on public.retail_sale_promotions
  for select to authenticated using (
    app.has_branch_permission(organization_id, branch_id, 'retail.promotion.manage')
    or app.has_branch_permission(organization_id, branch_id, 'retail.pos.use'));

create policy retail_returns_select on public.retail_returns
  for select to authenticated using (
    app.has_branch_permission(organization_id, branch_id, 'retail.return.manage')
    or app.has_branch_permission(organization_id, branch_id, 'retail.pos.use'));
create policy retail_return_lines_select on public.retail_return_lines
  for select to authenticated using (exists (
    select 1 from public.retail_returns r
     where r.id = return_id
       and (app.has_branch_permission(r.organization_id, r.branch_id, 'retail.return.manage')
         or app.has_branch_permission(r.organization_id, r.branch_id, 'retail.pos.use'))));
create policy retail_store_credits_select on public.retail_store_credits
  for select to authenticated using (app.has_permission(organization_id, 'retail.credit.manage'));

create policy clinic_rooms_select on public.clinic_rooms
  for select to authenticated using (app.clinic_staff(organization_id));
create policy clinic_doctors_select on public.clinic_doctors
  for select to authenticated using (app.clinic_staff(organization_id));
create policy clinic_doctor_shifts_select on public.clinic_doctor_shifts
  for select to authenticated using (app.clinic_staff(organization_id));
create policy clinic_services_select on public.clinic_services
  for select to authenticated using (app.clinic_staff(organization_id));
create policy clinic_service_supplies_select on public.clinic_service_supplies
  for select to authenticated using (
    app.has_permission(organization_id, 'clinic.service.manage')
    or app.has_permission(organization_id, 'inventory.read'));

create policy clinic_patients_select on public.clinic_patients
  for select to authenticated using (app.has_permission(organization_id, 'clinic.patient.read'));

create policy clinic_appointments_select on public.clinic_appointments
  for select to authenticated using (
    app.has_branch_permission(organization_id, branch_id, 'clinic.appointment.read')
    or doctor_id = app.clinic_my_doctor(organization_id));
create policy clinic_appointment_services_select on public.clinic_appointment_services
  for select to authenticated using (exists (
    select 1 from public.clinic_appointments a
     where a.id = appointment_id
       and (app.has_branch_permission(a.organization_id, a.branch_id, 'clinic.appointment.read')
         or a.doctor_id = app.clinic_my_doctor(a.organization_id))));
create policy clinic_doctor_commissions_select on public.clinic_doctor_commissions
  for select to authenticated using (
    app.has_branch_permission(organization_id, branch_id, 'clinic.commission.read')
    or doctor_id = app.clinic_my_doctor(organization_id));

create policy clinic_emr_records_select on public.clinic_emr_records
  for select to authenticated using (app.has_permission(organization_id, 'clinic.emr.read'));
create policy clinic_prescriptions_select on public.clinic_prescriptions
  for select to authenticated using (
    app.has_permission(organization_id, 'clinic.emr.read')
    or app.has_permission(organization_id, 'clinic.prescription.write'));
create policy clinic_prescription_items_select on public.clinic_prescription_items
  for select to authenticated using (
    app.has_permission(organization_id, 'clinic.emr.read')
    or app.has_permission(organization_id, 'clinic.prescription.write'));

-- =============================================================================
-- 7. Storage: PRIVATE clinic-records bucket, path {org}/{patient}/{file}
--    No public read, no update, no delete: files are records, served by
--    short-lived signed URLs to members holding clinic.emr.read.
-- =============================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('clinic-records', 'clinic-records', false, 20 * 1024 * 1024,
        array['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'application/dicom'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Org id from the first path segment; null (never an error) for a malformed path.
create or replace function app.clinic_path_org(p_name text)
returns uuid language sql immutable set search_path = '' as $$
  select case when (storage.foldername(p_name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              and (storage.foldername(p_name))[2] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then ((storage.foldername(p_name))[1])::uuid end;
$$;

create policy clinic_records_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'clinic-records'
              and app.has_permission(app.clinic_path_org(name), 'clinic.emr.write')
              and exists (select 1 from public.clinic_patients p
                           where p.organization_id = app.clinic_path_org(name)
                             and p.id::text = lower((storage.foldername(name))[2])));
create policy clinic_records_select on storage.objects for select to authenticated
  using (bucket_id = 'clinic-records' and app.has_permission(app.clinic_path_org(name), 'clinic.emr.read'));

-- =============================================================================
-- 8. RPCs
-- =============================================================================
create or replace function public.branch_set_module(p_org uuid, p_branch uuid, p_module text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_old text;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_permission(p_org, 'branch.manage') then raise exception 'not permitted' using errcode = '42501'; end if;
  if p_module is not null and p_module not in ('retail', 'restaurant', 'medical', 'workshop') then
    raise exception 'نشاط غير معروف' using errcode = '22023';
  end if;
  select module_key into v_old from public.branches
   where id = p_branch and organization_id = p_org and deleted_at is null for update;
  if not found then raise exception 'الفرع غير موجود' using errcode = 'P0002'; end if;
  update public.branches set module_key = p_module where id = p_branch;
  insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, before, after)
  values (p_org, p_branch, auth.uid(), 'branch.module_set', 'branch', p_branch::text,
          jsonb_build_object('module', v_old), jsonb_build_object('module', p_module));
end;
$$;

-- Scanner / manual lookup: own barcode, SKU, alternate barcode, then scale code.
create or replace function public.retail_barcode_lookup(p_org uuid, p_code text)
returns table (variant_id uuid, product_id uuid, product_name text, variant_name text,
               quantity numeric, unit_price_cents bigint, line_price_cents bigint, matched_by text)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_code text := trim(coalesce(p_code, ''));
  f      record;
  v_item text;
  v_val  bigint;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_permission(p_org, 'retail.pos.use') then raise exception 'not permitted' using errcode = '42501'; end if;
  if v_code = '' or length(v_code) > 64 then return; end if;

  return query
    select v.id, p.id, p.name, v.name, 1::numeric, v.price_cents, v.price_cents,
           case when v.barcode = v_code then 'barcode' else 'sku' end
      from public.retail_variants v join public.retail_products p on p.id = v.product_id
     where v.organization_id = p_org and v.deleted_at is null and v.is_active
       and (v.barcode = v_code or v.sku = v_code)
     order by (v.barcode = v_code) desc
     limit 1;
  if found then return; end if;

  return query
    select v.id, p.id, p.name, v.name, b.pack_qty, v.price_cents,
           round(v.price_cents * b.pack_qty)::bigint, 'alternate'
      from public.retail_barcodes b
      join public.retail_variants v on v.id = b.variant_id and v.deleted_at is null and v.is_active
      join public.retail_products p on p.id = v.product_id
     where b.organization_id = p_org and b.barcode = v_code;
  if found then return; end if;

  if v_code ~ '^[0-9]{12,13}$' then
    for f in
      select * from public.retail_scale_formats s
       where s.organization_id = p_org and s.is_active and s.total_length = length(v_code)
         and left(v_code, length(s.prefix)) = s.prefix
       order by length(s.prefix) desc
    loop
      v_item := substr(v_code, length(f.prefix) + 1, f.code_digits);
      v_val  := substr(v_code, length(f.prefix) + f.code_digits + 1,
                       f.total_length - length(f.prefix) - f.code_digits - 1)::bigint;
      return query
        select v.id, p.id, p.name, v.name,
               case when f.value_kind = 'weight' then round(v_val / power(10, f.value_decimals)::numeric, 3)
                    when v.price_cents > 0 then round((v_val * 100 / power(10, f.value_decimals)::numeric) / v.price_cents, 3)
                    else 0 end,
               v.price_cents,
               case when f.value_kind = 'weight' then round(v.price_cents * v_val / power(10, f.value_decimals)::numeric)::bigint
                    else round(v_val * 100 / power(10, f.value_decimals)::numeric)::bigint end,
               'scale'
          from public.retail_variants v join public.retail_products p on p.id = v.product_id
         where v.organization_id = p_org and v.deleted_at is null and v.is_active and v.scale_code = v_item;
      if found then return; end if;
    end loop;
  end if;
end;
$$;

-- Register or edit a patient. p_id null = new (file number auto-assigned).
create or replace function public.clinic_patient_save(p_org uuid, p_branch uuid, p_id uuid, p_data jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_branch_permission(p_org, p_branch, 'clinic.patient.manage') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  perform app.rate_limit('rl_clinic_patient', auth.uid()::text, 300, 3600);

  if p_id is null then
    insert into public.clinic_patients
      (organization_id, branch_id, file_number, full_name, phone, national_id, gender, date_of_birth, blood_type,
       allergies, chronic_conditions, emergency_contact_name, emergency_contact_phone, notes, created_by)
    values (p_org, p_branch, coalesce(nullif(trim(p_data->>'file_number'), ''), ''),
            trim(p_data->>'full_name'), nullif(trim(p_data->>'phone'), ''), nullif(trim(p_data->>'national_id'), ''),
            nullif(p_data->>'gender', ''), nullif(p_data->>'date_of_birth', '')::date, nullif(p_data->>'blood_type', ''),
            nullif(trim(p_data->>'allergies'), ''), nullif(trim(p_data->>'chronic_conditions'), ''),
            nullif(trim(p_data->>'emergency_contact_name'), ''), nullif(trim(p_data->>'emergency_contact_phone'), ''),
            nullif(trim(p_data->>'notes'), ''), auth.uid())
    returning id into v_id;
  else
    update public.clinic_patients set
      full_name = trim(p_data->>'full_name'), phone = nullif(trim(p_data->>'phone'), ''),
      national_id = nullif(trim(p_data->>'national_id'), ''), gender = nullif(p_data->>'gender', ''),
      date_of_birth = nullif(p_data->>'date_of_birth', '')::date, blood_type = nullif(p_data->>'blood_type', ''),
      allergies = nullif(trim(p_data->>'allergies'), ''), chronic_conditions = nullif(trim(p_data->>'chronic_conditions'), ''),
      emergency_contact_name = nullif(trim(p_data->>'emergency_contact_name'), ''),
      emergency_contact_phone = nullif(trim(p_data->>'emergency_contact_phone'), ''),
      notes = nullif(trim(p_data->>'notes'), '')
     where id = p_id and organization_id = p_org and deleted_at is null
    returning id into v_id;
    if v_id is null then raise exception 'المريض غير موجود' using errcode = 'P0002'; end if;
  end if;

  -- Audit names the record, never its medical content.
  insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id)
  values (p_org, p_branch, auth.uid(), case when p_id is null then 'clinic.patient.created' else 'clinic.patient.updated' end,
          'clinic_patient', v_id::text);
  return v_id;
end;
$$;

create or replace function public.clinic_appointment_book(
  p_org uuid, p_branch uuid, p_patient uuid, p_doctor uuid, p_starts_at timestamptz,
  p_services uuid[] default '{}', p_duration_minutes integer default null, p_room uuid default null,
  p_reason text default null, p_source text default 'staff'
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id   uuid;
  v_mins integer;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_branch_permission(p_org, p_branch, 'clinic.appointment.manage') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if coalesce(app.branch_module(p_branch), '') <> 'medical' then
    raise exception 'هذا الفرع لا يعمل كعيادة' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(coalesce(p_services, '{}')) sid
              where not exists (select 1 from public.clinic_services s
                                 where s.id = sid and s.organization_id = p_org and s.is_active and s.deleted_at is null)) then
    raise exception 'خدمة غير معروفة' using errcode = '22023';
  end if;

  select coalesce(p_duration_minutes, nullif(sum(s.duration_minutes), 0), 15) into v_mins
    from public.clinic_services s where s.id = any (coalesce(p_services, '{}'));
  if v_mins not between 5 and 720 then raise exception 'مدة غير صالحة' using errcode = '22023'; end if;

  insert into public.clinic_appointments
    (organization_id, branch_id, patient_id, doctor_id, room_id, starts_at, ends_at, source, reason, booked_by)
  values (p_org, p_branch, p_patient, p_doctor, p_room, p_starts_at, p_starts_at + make_interval(mins => v_mins),
          coalesce(p_source, 'staff'), nullif(left(trim(coalesce(p_reason, '')), 300), ''), auth.uid())
  returning id into v_id;

  insert into public.clinic_appointment_services (organization_id, appointment_id, service_id, doctor_id, unit_price_cents)
  select p_org, v_id, s.id, p_doctor, s.price_cents
    from unnest(coalesce(p_services, '{}')) with ordinality u(sid, ord)
    join public.clinic_services s on s.id = u.sid
   order by u.ord;

  insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, p_branch, auth.uid(), 'clinic.appointment.booked', 'clinic_appointment', v_id::text,
          jsonb_build_object('doctor', p_doctor, 'starts_at', p_starts_at, 'minutes', v_mins));
  return v_id;
end;
$$;

-- Status moves. Front desk: check in, cancel, no-show. Clinical staff (or the
-- appointment's own doctor): start and complete the session.
create or replace function public.clinic_appointment_set_status(
  p_org uuid, p_appointment uuid, p_status text, p_reason text default null
) returns void language plpgsql security definer set search_path = '' as $$
declare v record;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into v from public.clinic_appointments where id = p_appointment and organization_id = p_org for update;
  if v.id is null then raise exception 'الموعد غير موجود' using errcode = 'P0002'; end if;

  if p_status in ('checked_in', 'cancelled', 'no_show') then
    if not app.has_branch_permission(p_org, v.branch_id, 'clinic.appointment.manage') then
      raise exception 'not permitted' using errcode = '42501';
    end if;
  elsif p_status in ('in_session', 'completed') then
    if not (app.has_branch_permission(p_org, v.branch_id, 'clinic.emr.write')
            and (v.doctor_id = app.clinic_my_doctor(p_org)
                 or app.clinic_my_doctor(p_org) is null
                 or app.has_branch_permission(p_org, v.branch_id, 'clinic.appointment.manage'))) then
      raise exception 'not permitted' using errcode = '42501';
    end if;
  else
    raise exception 'حالة غير معروفة' using errcode = '22023';
  end if;
  if p_status = 'cancelled' and coalesce(trim(p_reason), '') = '' then
    raise exception 'سبب الإلغاء مطلوب' using errcode = '22023';
  end if;

  update public.clinic_appointments
     set status = p_status,
         cancelled_by  = case when p_status = 'cancelled' then auth.uid() else cancelled_by end,
         cancel_reason = case when p_status = 'cancelled' then left(trim(p_reason), 300) else cancel_reason end
   where id = p_appointment;

  insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, before, after)
  values (p_org, v.branch_id, auth.uid(), 'clinic.appointment.' || p_status, 'clinic_appointment', p_appointment::text,
          jsonb_build_object('status', v.status), jsonb_build_object('status', p_status));
end;
$$;

-- Add one medical record entry. Fields come in p_data and are validated by
-- the table's CHECKs; the attachment must already be in this patient's folder.
create or replace function public.clinic_emr_add(
  p_org uuid, p_patient uuid, p_type text, p_data jsonb, p_appointment uuid default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_branch uuid;
  v_doctor uuid;
  v_id     uuid;
  v_path   text := nullif(trim(p_data->>'attachment_path'), '');
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not exists (select 1 from public.clinic_patients
                  where id = p_patient and organization_id = p_org and deleted_at is null) then
    raise exception 'المريض غير موجود' using errcode = 'P0002';
  end if;

  if p_appointment is not null then
    select branch_id, doctor_id into v_branch, v_doctor from public.clinic_appointments
     where id = p_appointment and organization_id = p_org and patient_id = p_patient;
    if v_branch is null then raise exception 'الموعد لا يخص هذا المريض' using errcode = '22023'; end if;
  else
    select branch_id into v_branch from public.clinic_patients where id = p_patient;
    v_doctor := app.clinic_my_doctor(p_org);
  end if;
  if not app.has_branch_permission(p_org, v_branch, 'clinic.emr.write') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_path is not null and v_path not like p_org::text || '/' || p_patient::text || '/%' then
    raise exception 'مسار المرفق غير صالح' using errcode = '22023';
  end if;
  if (p_data->>'amends_id') is not null and not exists (
       select 1 from public.clinic_emr_records
        where id = (p_data->>'amends_id')::uuid and patient_id = p_patient) then
    raise exception 'السجل المعدّل غير موجود' using errcode = '22023';
  end if;
  perform app.rate_limit('rl_clinic_emr', auth.uid()::text, 600, 3600);

  insert into public.clinic_emr_records
    (organization_id, branch_id, patient_id, appointment_id, doctor_id, author_id, record_type, title, body,
     diagnosis_code, temperature_c, pulse_bpm, systolic_mmhg, diastolic_mmhg, respiratory_rate, spo2_percent,
     weight_kg, height_cm, glucose_mg_dl, attachment_path, attachment_mime, attachment_bytes, amends_id)
  values (p_org, v_branch, p_patient, p_appointment, v_doctor, auth.uid(), p_type,
          nullif(trim(p_data->>'title'), ''), nullif(trim(p_data->>'body'), ''),
          upper(nullif(trim(p_data->>'diagnosis_code'), '')),
          (p_data->>'temperature_c')::numeric, (p_data->>'pulse_bpm')::smallint,
          (p_data->>'systolic_mmhg')::smallint, (p_data->>'diastolic_mmhg')::smallint,
          (p_data->>'respiratory_rate')::smallint, (p_data->>'spo2_percent')::smallint,
          (p_data->>'weight_kg')::numeric, (p_data->>'height_cm')::numeric, (p_data->>'glucose_mg_dl')::smallint,
          v_path, nullif(p_data->>'attachment_mime', ''), (p_data->>'attachment_bytes')::bigint,
          (p_data->>'amends_id')::uuid)
  returning id into v_id;

  insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, v_branch, auth.uid(), 'clinic.emr.added', 'clinic_patient', p_patient::text,
          jsonb_build_object('record', v_id, 'type', p_type));
  return v_id;
end;
$$;

-- =============================================================================
-- 9. Grants
-- =============================================================================
do $$
declare f text;
begin
  foreach f in array array[
    'app.branch_module_guard()', 'app.branch_module(uuid)', 'app.approval_actions()',
    'app.retail_barcode_guard()', 'app.retail_transfer_state()',
    'app.retail_store_credit_balance(uuid, uuid)', 'app.retail_store_credit_write()',
    'app.clinic_patient_defaults()', 'app.clinic_appointment_guard()',
    'app.clinic_complete_appointment(uuid)', 'app.clinic_appointment_after()', 'app.clinic_emr_immutable()'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;

  -- RLS helpers: policies run as the caller, so authenticated must execute them.
  foreach f in array array[
    'app.clinic_staff(uuid)', 'app.clinic_my_doctor(uuid)', 'app.clinic_path_org(text)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;

  foreach f in array array[
    'public.branch_set_module(uuid, uuid, text)',
    'public.retail_barcode_lookup(uuid, text)',
    'public.clinic_patient_save(uuid, uuid, uuid, jsonb)',
    'public.clinic_appointment_book(uuid, uuid, uuid, uuid, timestamptz, uuid[], integer, uuid, text, text)',
    'public.clinic_appointment_set_status(uuid, uuid, text, text)',
    'public.clinic_emr_add(uuid, uuid, text, jsonb, uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
