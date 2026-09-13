-- =============================================================================
-- LOCAL BASIC — 0005 Core money
-- customers, document numbering, invoices, invoice_items, payments, treasury
--
-- Money rule: every monetary value is a bigint of MINOR UNITS (cents/piastres).
-- No numeric, no float, anywhere, ever.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- customers — Core entity. Verticals attach satellite tables keyed by
-- customers.id (e.g. medical_patient_profiles); they never fork this table.
-- ---------------------------------------------------------------------------
create table public.customers (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  -- Branch that created the customer. Customers are visible org-wide; the
  -- branch is provenance, not a fence.
  branch_id        uuid references public.branches(id) on delete set null,
  name             text not null check (length(trim(name)) between 1 and 160),
  phone            text,
  email            citext,
  tax_id           text,
  address          text,
  notes            text,
  -- Linked platform account, when the customer signs in to a portal.
  user_id          uuid references public.profiles(id) on delete set null,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid references public.profiles(id),
  deleted_at       timestamptz
);
create unique index customers_org_phone_unique
  on public.customers(organization_id, phone)
  where phone is not null and deleted_at is null;
create index customers_org_name_idx on public.customers(organization_id, name);
create index customers_user_idx on public.customers(user_id) where user_id is not null;
create trigger customers_touch before update on public.customers
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Document numbering — gapless per (organization, branch, doc_type).
-- Uses an UPDATE ... RETURNING on a counter row, which takes a row lock, so
-- two concurrent sales can never be handed the same invoice number.
-- ---------------------------------------------------------------------------
create table public.document_counters (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id       uuid not null references public.branches(id) on delete cascade,
  doc_type        text not null,
  prefix          text not null default '',
  next_number     bigint not null default 1 check (next_number > 0),
  primary key (organization_id, branch_id, doc_type)
);

create or replace function app.next_document_number(
  p_org uuid, p_branch uuid, p_doc_type text
) returns text language plpgsql security definer set search_path = '' as $$
declare
  v_number bigint;
  v_prefix text;
begin
  insert into public.document_counters (organization_id, branch_id, doc_type)
  values (p_org, p_branch, p_doc_type)
  on conflict (organization_id, branch_id, doc_type) do nothing;

  update public.document_counters
     set next_number = next_number + 1
   where organization_id = p_org
     and branch_id = p_branch
     and doc_type = p_doc_type
  returning next_number - 1, prefix into v_number, v_prefix;

  return v_prefix || lpad(v_number::text, 6, '0');
end;
$$;

-- ---------------------------------------------------------------------------
-- invoices — never hard-deleted. Cancellation is a void, with a reason.
-- ---------------------------------------------------------------------------
create table public.invoices (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  branch_id        uuid not null references public.branches(id) on delete restrict,
  number           text not null,
  customer_id      uuid references public.customers(id) on delete set null,
  status           text not null default 'draft'
                   check (status in ('draft','issued','partially_paid','paid','void')),
  -- Which surface produced it: pos | online | back_office | medical | workshop | restaurant
  source           text not null default 'back_office',
  currency         char(3) not null,
  subtotal_cents   bigint not null default 0 check (subtotal_cents >= 0),
  discount_cents   bigint not null default 0 check (discount_cents >= 0),
  tax_cents        bigint not null default 0 check (tax_cents >= 0),
  total_cents      bigint not null default 0 check (total_cents >= 0),
  -- Maintained by trigger from payments; never written by application code.
  paid_cents       bigint not null default 0,
  notes            text,
  issued_at        timestamptz,
  due_at           timestamptz,
  voided_at        timestamptz,
  void_reason      text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid references public.profiles(id),
  unique (organization_id, branch_id, number),
  constraint invoices_void_needs_reason
    check (voided_at is null or (void_reason is not null and status = 'void'))
);
create index invoices_branch_created_idx
  on public.invoices(organization_id, branch_id, created_at desc);
create index invoices_customer_idx on public.invoices(customer_id);
create index invoices_status_idx on public.invoices(organization_id, status);
create trigger invoices_touch before update on public.invoices
  for each row execute function app.touch_updated_at();

create table public.invoice_items (
  id                uuid primary key default gen_random_uuid(),
  invoice_id        uuid not null references public.invoices(id) on delete cascade,
  organization_id   uuid not null references public.organizations(id) on delete cascade,
  -- What this line points at, without Core needing to know the vertical:
  -- 'retail_variant', 'medical_service', 'workshop_part', 'restaurant_product'…
  ref_type          text,
  ref_id            uuid,
  description       text not null,
  quantity          numeric(14,3) not null check (quantity > 0),
  unit_price_cents  bigint not null check (unit_price_cents >= 0),
  discount_cents    bigint not null default 0 check (discount_cents >= 0),
  tax_rate_bp       int not null default 0 check (tax_rate_bp between 0 and 10000), -- basis points
  total_cents       bigint not null check (total_cents >= 0),
  position          int not null default 0,
  created_at        timestamptz not null default now()
);
create index invoice_items_invoice_idx on public.invoice_items(invoice_id);
create index invoice_items_ref_idx on public.invoice_items(ref_type, ref_id);

-- ---------------------------------------------------------------------------
-- payments — append only. A refund is a linked row with a negative amount,
-- never an edit or a delete of the original payment.
-- ---------------------------------------------------------------------------
create table public.payments (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references public.organizations(id) on delete cascade,
  branch_id            uuid not null references public.branches(id) on delete restrict,
  invoice_id           uuid references public.invoices(id) on delete restrict,
  customer_id          uuid references public.customers(id) on delete set null,
  kind                 text not null default 'payment' check (kind in ('payment','refund')),
  method               text not null check (method in ('cash','card','transfer','wallet','online','other')),
  amount_cents         bigint not null check (amount_cents <> 0),
  currency             char(3) not null,
  status               text not null default 'completed'
                       check (status in ('pending','completed','failed')),
  treasury_account_id  uuid,
  reference            text,
  provider             text,
  provider_ref         text,
  refund_of_id         uuid references public.payments(id),
  created_at           timestamptz not null default now(),
  created_by           uuid references public.profiles(id),
  constraint payments_sign_matches_kind check (
    (kind = 'payment' and amount_cents > 0) or
    (kind = 'refund'  and amount_cents < 0)
  ),
  constraint payments_refund_needs_origin check (kind <> 'refund' or refund_of_id is not null)
);
create index payments_invoice_idx on public.payments(invoice_id);
create index payments_branch_created_idx
  on public.payments(organization_id, branch_id, created_at desc);

-- Recompute invoice paid_cents + status from the payment ledger. This is the
-- only writer of invoices.paid_cents, so the invoice can never disagree with
-- the payments behind it.
create or replace function app.sync_invoice_payment_state()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_invoice uuid := coalesce(new.invoice_id, old.invoice_id);
  v_paid    bigint;
  v_total   bigint;
  v_status  text;
begin
  if v_invoice is null then return coalesce(new, old); end if;

  select coalesce(sum(p.amount_cents), 0) into v_paid
    from public.payments p
   where p.invoice_id = v_invoice and p.status = 'completed';

  select i.total_cents, i.status into v_total, v_status
    from public.invoices i where i.id = v_invoice;

  update public.invoices
     set paid_cents = v_paid,
         status = case
           when v_status = 'void'   then 'void'
           when v_status = 'draft'  then 'draft'
           when v_paid <= 0         then 'issued'
           when v_paid >= v_total   then 'paid'
           else 'partially_paid'
         end
   where id = v_invoice;

  return coalesce(new, old);
end;
$$;

create trigger payments_sync_invoice
  after insert or update or delete on public.payments
  for each row execute function app.sync_invoice_payment_state();

-- ---------------------------------------------------------------------------
-- treasury — accounts are containers; the ledger is the truth.
-- Balance is always derived from treasury_transactions, never stored as a
-- mutable column, so it cannot be edited into a lie.
-- ---------------------------------------------------------------------------
create table public.treasury_accounts (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  branch_id        uuid not null references public.branches(id) on delete restrict,
  name             text not null,
  type             text not null default 'cash' check (type in ('cash','bank','wallet','other')),
  currency         char(3) not null,
  is_default       boolean not null default false,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create unique index treasury_accounts_default_unique
  on public.treasury_accounts(branch_id) where is_default;
create index treasury_accounts_branch_idx on public.treasury_accounts(organization_id, branch_id);
create trigger treasury_accounts_touch before update on public.treasury_accounts
  for each row execute function app.touch_updated_at();

alter table public.payments
  add constraint payments_treasury_account_fk
  foreign key (treasury_account_id) references public.treasury_accounts(id);

create table public.treasury_transactions (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  branch_id        uuid not null references public.branches(id) on delete restrict,
  account_id       uuid not null references public.treasury_accounts(id) on delete restrict,
  direction        text not null check (direction in ('in','out')),
  amount_cents     bigint not null check (amount_cents > 0),
  currency         char(3) not null,
  -- 'sale','refund','expense','purchase','withdrawal','deposit','transfer','adjustment'
  category         text not null,
  reason           text,
  ref_type         text,
  ref_id           uuid,
  occurred_at      timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  created_by       uuid references public.profiles(id)
);
create index treasury_tx_account_idx
  on public.treasury_transactions(account_id, occurred_at desc);
create index treasury_tx_branch_idx
  on public.treasury_transactions(organization_id, branch_id, occurred_at desc);
create index treasury_tx_ref_idx on public.treasury_transactions(ref_type, ref_id);

-- Derived balance. Reads go through RLS on treasury_transactions because this
-- function is INVOKER, not DEFINER — a user can only sum what they may read.
create or replace function public.treasury_account_balance(p_account uuid)
returns bigint language sql stable security invoker set search_path = '' as $$
  select coalesce(sum(case when direction = 'in' then amount_cents else -amount_cents end), 0)
  from public.treasury_transactions
  where account_id = p_account;
$$;
grant execute on function public.treasury_account_balance(uuid) to authenticated;
