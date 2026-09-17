-- =============================================================================
-- LOCAL BASIC — 0045 Retail purchasing
--
-- Suppliers already exist (0011) with their RLS (0013). What was missing is the
-- document that brings stock IN: the purchase order, its receipts, and the
-- money that leaves the treasury to pay for it.
--
-- Design decisions, stated once here:
--
--   * RECEIVING WRITES THE SAME LEDGER AS EVERYTHING ELSE. A receipt inserts
--     into retail_stock_movements with reason 'purchase'. There is no second
--     path into stock, so POS, the storefront and purchasing cannot disagree
--     about what is on the shelf. 0012's projection trigger does the rest.
--
--   * COST IS SUPPLIED, PRICE IS NOT. Unlike a sale, the client legitimately
--     names the unit cost — it is what the supplier charged, and no database
--     row can know it. Every TOTAL is still recomputed here from quantity ×
--     cost, and the caller needs `retail.purchase.manage` to state one.
--
--   * TOTALS ARE DERIVED, NEVER WRITTEN. Like restaurant order totals (0026)
--     and treasury balances (0005), the order total is recomputed by trigger
--     from its lines. A number that can be written directly eventually is.
--
--   * PARTIAL RECEIPTS ARE NORMAL. quantity_received accumulates and the
--     status follows it, so a short delivery is an ordinary state, not an
--     error. Over-receiving is refused: it means the paperwork is wrong.
--
--   * SUPPLIER PAYMENT IS TREASURY, NOT A CORE PAYMENT. Core `payments` are
--     money coming IN against a customer invoice. Paying a supplier is money
--     going OUT, so it is a treasury transaction with category 'purchase',
--     the same shape as an expense.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Purchase orders.
-- ---------------------------------------------------------------------------
create table public.retail_purchase_orders (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  branch_id        uuid not null references public.branches(id) on delete restrict,
  supplier_id      uuid references public.retail_suppliers(id) on delete restrict,
  number           text not null,
  status           text not null default 'draft'
                   check (status in ('draft','ordered','partially_received','received','cancelled')),
  currency         char(3) not null,
  -- Derived from the lines by trigger. Never written by a client.
  subtotal_cents   bigint not null default 0 check (subtotal_cents >= 0),
  total_cents      bigint not null default 0 check (total_cents >= 0),
  -- What has actually been paid out against this order, also derived.
  paid_cents       bigint not null default 0 check (paid_cents >= 0),
  expected_at      timestamptz,
  ordered_at       timestamptz,
  received_at      timestamptz,
  cancelled_at     timestamptz,
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid references public.profiles(id)
);
create unique index retail_purchase_orders_number_unique
  on public.retail_purchase_orders(organization_id, branch_id, number);
create index retail_purchase_orders_branch_idx
  on public.retail_purchase_orders(organization_id, branch_id, created_at desc);
create index retail_purchase_orders_supplier_idx
  on public.retail_purchase_orders(supplier_id, created_at desc);
create trigger retail_purchase_orders_touch before update
  on public.retail_purchase_orders
  for each row execute function app.touch_updated_at();

create table public.retail_purchase_order_items (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations(id) on delete cascade,
  purchase_order_id  uuid not null references public.retail_purchase_orders(id) on delete cascade,
  variant_id         uuid not null references public.retail_variants(id) on delete restrict,
  -- Snapshots, so the document still reads correctly after the catalog moves on.
  product_name       text not null,
  variant_name       text not null,
  quantity_ordered   numeric(14,3) not null check (quantity_ordered > 0),
  quantity_received  numeric(14,3) not null default 0 check (quantity_received >= 0),
  unit_cost_cents    bigint not null check (unit_cost_cents >= 0),
  line_total_cents   bigint not null default 0 check (line_total_cents >= 0),
  position           int not null default 0,
  created_at         timestamptz not null default now(),
  -- A line can never be received beyond what was ordered: a mismatch means the
  -- paperwork is wrong, and silently accepting it would put phantom stock on
  -- the shelf.
  constraint retail_po_items_not_over_received
    check (quantity_received <= quantity_ordered)
);
create index retail_po_items_order_idx
  on public.retail_purchase_order_items(purchase_order_id, position);
create index retail_po_items_variant_idx
  on public.retail_purchase_order_items(variant_id);

-- ---------------------------------------------------------------------------
-- 2. Tenancy guards.
--
-- Composite foreign keys would be neater, but the referenced tables predate
-- this migration and adding unique (id, organization_id) to them is a wider
-- change than this batch should make. A trigger states the same rule.
-- ---------------------------------------------------------------------------
create or replace function app.check_purchase_order_tenancy()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_org uuid;
begin
  select organization_id into v_org from public.branches where id = new.branch_id;
  if v_org is distinct from new.organization_id then
    raise exception 'purchase order crosses organizations' using errcode = 'check_violation';
  end if;

  if new.supplier_id is not null then
    select organization_id into v_org
      from public.retail_suppliers where id = new.supplier_id;
    if v_org is distinct from new.organization_id then
      raise exception 'supplier belongs to another organization'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

create trigger retail_purchase_orders_tenancy
  before insert or update on public.retail_purchase_orders
  for each row execute function app.check_purchase_order_tenancy();

create or replace function app.check_purchase_item_tenancy()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_org uuid;
begin
  select organization_id into v_org
    from public.retail_purchase_orders where id = new.purchase_order_id;
  if v_org is distinct from new.organization_id then
    raise exception 'purchase line crosses organizations' using errcode = 'check_violation';
  end if;

  select organization_id into v_org
    from public.retail_variants where id = new.variant_id;
  if v_org is distinct from new.organization_id then
    raise exception 'variant belongs to another organization'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger retail_purchase_order_items_tenancy
  before insert or update on public.retail_purchase_order_items
  for each row execute function app.check_purchase_item_tenancy();

-- ---------------------------------------------------------------------------
-- 3. Derived line and order totals.
-- ---------------------------------------------------------------------------
create or replace function app.derive_purchase_line_total()
returns trigger language plpgsql set search_path = '' as $$
begin
  -- round(), not trunc(): a half-unit cost on a fractional quantity should not
  -- quietly lose money in the supplier's favour.
  new.line_total_cents := round(new.quantity_ordered * new.unit_cost_cents)::bigint;
  return new;
end;
$$;

create trigger retail_purchase_order_items_total
  before insert or update on public.retail_purchase_order_items
  for each row execute function app.derive_purchase_line_total();

create or replace function app.derive_purchase_order_total()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_order uuid := coalesce(new.purchase_order_id, old.purchase_order_id);
  v_sum   bigint;
begin
  select coalesce(sum(line_total_cents), 0) into v_sum
    from public.retail_purchase_order_items where purchase_order_id = v_order;

  update public.retail_purchase_orders
     set subtotal_cents = v_sum, total_cents = v_sum
   where id = v_order;
  return null;
end;
$$;

create trigger retail_purchase_order_items_rollup
  after insert or update or delete on public.retail_purchase_order_items
  for each row execute function app.derive_purchase_order_total();

-- ---------------------------------------------------------------------------
-- 4. The state machine.
--
-- Enumerated, like every other one in this codebase. Receiving moves the
-- status; nothing else may set it, and a received or cancelled order is final.
-- ---------------------------------------------------------------------------
create or replace function app.check_purchase_order_transition()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.organization_id <> old.organization_id or new.branch_id <> old.branch_id then
    raise exception 'a purchase order cannot move between tenants'
      using errcode = 'check_violation';
  end if;

  if new.status = old.status then return new; end if;

  if not (
       (old.status = 'draft'              and new.status in ('ordered','cancelled'))
    or (old.status = 'ordered'            and new.status in ('partially_received','received','cancelled'))
    or (old.status = 'partially_received' and new.status in ('partially_received','received','cancelled'))
  ) then
    raise exception 'cannot move a purchase order from % to %', old.status, new.status
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger retail_purchase_orders_transition
  before update on public.retail_purchase_orders
  for each row execute function app.check_purchase_order_transition();

-- ---------------------------------------------------------------------------
-- 5. RLS.
--
-- Reads need `retail.purchase.read`; every write goes through the functions
-- below, which is why there is no insert/update policy on either table.
-- ---------------------------------------------------------------------------
alter table public.retail_purchase_orders      enable row level security;
alter table public.retail_purchase_orders      force row level security;
alter table public.retail_purchase_order_items enable row level security;
alter table public.retail_purchase_order_items force row level security;

create policy retail_purchase_orders_select
  on public.retail_purchase_orders for select to authenticated
  using (app.has_branch_permission(organization_id, branch_id, 'retail.purchase.read'));

create policy retail_purchase_order_items_select
  on public.retail_purchase_order_items for select to authenticated
  using (exists (
    select 1 from public.retail_purchase_orders o
     where o.id = purchase_order_id
       and app.has_branch_permission(o.organization_id, o.branch_id, 'retail.purchase.read')
  ));

grant select on public.retail_purchase_orders      to authenticated;
grant select on public.retail_purchase_order_items to authenticated;
revoke all on public.retail_purchase_orders        from anon;
revoke all on public.retail_purchase_order_items   from anon;

-- ---------------------------------------------------------------------------
-- 6. Create a purchase order.
--
-- p_items: [{"variant_id": "...", "quantity": 10, "unit_cost_cents": 1500}, ...]
-- ---------------------------------------------------------------------------
create or replace function public.retail_purchase_create(
  p_org         uuid,
  p_branch      uuid,
  p_supplier    uuid,
  p_items       jsonb,
  p_expected_at timestamptz default null,
  p_note        text default null
)
returns table (out_id uuid, out_number text, out_total_cents bigint)
language plpgsql security definer set search_path = '' as $$
declare
  v_user     uuid := auth.uid();
  v_currency char(3);
  v_order    uuid;
  v_number   text;
  v_item     jsonb;
  v_variant  record;
  v_qty      numeric(14,3);
  v_cost     bigint;
  v_position int := 0;
  v_total    bigint;
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not app.has_branch_permission(p_org, p_branch, 'retail.purchase.manage') then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  select o.currency into v_currency
    from public.organizations o
    join public.branches b on b.organization_id = o.id
   where o.id = p_org and b.id = p_branch and b.is_active and b.deleted_at is null;
  if v_currency is null then
    raise exception 'branch does not belong to organization' using errcode = 'check_violation';
  end if;

  if p_supplier is not null and not exists (
    select 1 from public.retail_suppliers s
     where s.id = p_supplier and s.organization_id = p_org and s.is_active
  ) then
    raise exception 'unknown supplier' using errcode = 'check_violation';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'a purchase order needs at least one line' using errcode = 'check_violation';
  end if;

  v_number := app.next_document_number(p_org, p_branch, 'purchase');

  insert into public.retail_purchase_orders
    (organization_id, branch_id, supplier_id, number, status, currency,
     expected_at, notes, created_by)
  values
    (p_org, p_branch, p_supplier, v_number, 'draft', v_currency,
     p_expected_at, p_note, v_user)
  returning id into v_order;

  for v_item in select * from jsonb_array_elements(p_items) loop
    select v.id, v.name as variant_name, pr.name as product_name
      into v_variant
      from public.retail_variants v
      join public.retail_products pr on pr.id = v.product_id
     where v.id = (v_item ->> 'variant_id')::uuid
       and v.organization_id = p_org
       and v.deleted_at is null;

    if v_variant.id is null then
      raise exception 'unknown variant on a purchase line' using errcode = 'check_violation';
    end if;

    v_qty  := coalesce((v_item ->> 'quantity')::numeric, 0);
    v_cost := coalesce((v_item ->> 'unit_cost_cents')::bigint, 0);
    if v_qty <= 0 then
      raise exception 'a purchase line needs a positive quantity' using errcode = 'check_violation';
    end if;
    if v_cost < 0 then
      raise exception 'a purchase line cannot have a negative cost' using errcode = 'check_violation';
    end if;

    v_position := v_position + 1;
    insert into public.retail_purchase_order_items
      (organization_id, purchase_order_id, variant_id, product_name, variant_name,
       quantity_ordered, unit_cost_cents, position)
    values
      (p_org, v_order, v_variant.id, v_variant.product_name, v_variant.variant_name,
       v_qty, v_cost, v_position);
  end loop;

  select total_cents into v_total
    from public.retail_purchase_orders where id = v_order;

  insert into public.audit_logs
    (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values
    (p_org, p_branch, v_user, 'retail.purchase.created', 'retail_purchase_order',
     v_order::text,
     jsonb_build_object('number', v_number, 'total_cents', v_total, 'supplier_id', p_supplier));

  return query select v_order, v_number, v_total;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Send the order to the supplier: draft → ordered.
-- ---------------------------------------------------------------------------
create or replace function public.retail_purchase_submit(
  p_org    uuid,
  p_branch uuid,
  p_order  uuid
)
returns void language plpgsql security definer set search_path = '' as $$
declare v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not app.has_branch_permission(p_org, p_branch, 'retail.purchase.manage') then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  update public.retail_purchase_orders
     set status = 'ordered', ordered_at = now()
   where id = p_order and organization_id = p_org and branch_id = p_branch
     and status = 'draft';

  if not found then
    raise exception 'purchase order not found or not a draft' using errcode = 'check_violation';
  end if;

  insert into public.audit_logs
    (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values
    (p_org, p_branch, v_user, 'retail.purchase.ordered', 'retail_purchase_order',
     p_order::text, jsonb_build_object('status', 'ordered'));
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Receive stock.
--
-- p_lines: [{"item_id": "...", "quantity": 4}, ...]
--
-- This is the only function in the batch that touches stock, and it does so by
-- inserting movements — the projection follows, the non-negative CHECK and the
-- row lock from 0012 still apply, and POS sees the new stock immediately.
-- ---------------------------------------------------------------------------
create or replace function public.retail_purchase_receive(
  p_org    uuid,
  p_branch uuid,
  p_order  uuid,
  p_lines  jsonb,
  p_note   text default null
)
returns table (out_status text, out_received_lines int)
language plpgsql security definer set search_path = '' as $$
declare
  v_user      uuid := auth.uid();
  v_order     record;
  v_line      jsonb;
  v_item      record;
  v_qty       numeric(14,3);
  v_count     int := 0;
  v_outstanding numeric(14,3);
  v_status    text;
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  -- Receiving moves stock, so it needs the inventory privilege as well as the
  -- purchasing one. Someone who may raise an order is not thereby allowed to
  -- declare that goods arrived.
  if not app.has_branch_permission(p_org, p_branch, 'retail.purchase.manage') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if not app.has_branch_permission(p_org, p_branch, 'retail.inventory.adjust') then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  select * into v_order from public.retail_purchase_orders
   where id = p_order and organization_id = p_org and branch_id = p_branch;
  if v_order.id is null then
    raise exception 'purchase order not found' using errcode = 'check_violation';
  end if;
  if v_order.status not in ('ordered','partially_received') then
    raise exception 'cannot receive against a % order', v_order.status
      using errcode = 'check_violation';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'nothing to receive' using errcode = 'check_violation';
  end if;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    select * into v_item from public.retail_purchase_order_items
     where id = (v_line ->> 'item_id')::uuid and purchase_order_id = p_order
     for update;

    if v_item.id is null then
      raise exception 'unknown purchase line' using errcode = 'check_violation';
    end if;

    v_qty := coalesce((v_line ->> 'quantity')::numeric, 0);
    if v_qty <= 0 then
      raise exception 'a receipt needs a positive quantity' using errcode = 'check_violation';
    end if;
    if v_item.quantity_received + v_qty > v_item.quantity_ordered then
      raise exception 'cannot receive more than was ordered' using errcode = 'check_violation';
    end if;

    update public.retail_purchase_order_items
       set quantity_received = quantity_received + v_qty
     where id = v_item.id;

    -- The one and only way stock arrives.
    insert into public.retail_stock_movements
      (organization_id, branch_id, variant_id, quantity_delta, reason,
       ref_type, ref_id, unit_cost_cents, note, created_by)
    values
      (p_org, p_branch, v_item.variant_id, v_qty, 'purchase',
       'retail_purchase', p_order, v_item.unit_cost_cents, p_note, v_user);

    -- Keep the catalog's cost current, so margin reporting reflects what was
    -- actually last paid rather than whatever was typed when the product was
    -- created. The selling price is never touched here.
    update public.retail_variants
       set cost_cents = v_item.unit_cost_cents
     where id = v_item.variant_id and organization_id = p_org;

    v_count := v_count + 1;
  end loop;

  select coalesce(sum(quantity_ordered - quantity_received), 0) into v_outstanding
    from public.retail_purchase_order_items where purchase_order_id = p_order;

  v_status := case when v_outstanding <= 0 then 'received' else 'partially_received' end;

  update public.retail_purchase_orders
     set status = v_status,
         received_at = case when v_status = 'received' then now() else received_at end
   where id = p_order;

  insert into public.audit_logs
    (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values
    (p_org, p_branch, v_user, 'retail.purchase.received', 'retail_purchase_order',
     p_order::text,
     jsonb_build_object('status', v_status, 'lines', v_count));

  return query select v_status, v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Cancel.
--
-- Stock already received stays received: cancelling the paperwork does not
-- un-deliver goods. A wrong receipt is corrected with a compensating movement,
-- exactly as everywhere else in this system.
-- ---------------------------------------------------------------------------
create or replace function public.retail_purchase_cancel(
  p_org    uuid,
  p_branch uuid,
  p_order  uuid,
  p_reason text default null
)
returns void language plpgsql security definer set search_path = '' as $$
declare v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not app.has_branch_permission(p_org, p_branch, 'retail.purchase.manage') then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  update public.retail_purchase_orders
     set status = 'cancelled', cancelled_at = now()
   where id = p_order and organization_id = p_org and branch_id = p_branch
     and status in ('draft','ordered','partially_received');

  if not found then
    raise exception 'purchase order not found or already closed'
      using errcode = 'check_violation';
  end if;

  insert into public.audit_logs
    (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values
    (p_org, p_branch, v_user, 'retail.purchase.cancelled', 'retail_purchase_order',
     p_order::text, jsonb_build_object('reason', p_reason));
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Pay a supplier.
--
-- Money out of the treasury, against the order. `paid_cents` on the order is a
-- projection of these transactions, recomputed here rather than incremented,
-- so it cannot drift from the ledger.
-- ---------------------------------------------------------------------------
create or replace function public.retail_purchase_pay(
  p_org     uuid,
  p_branch  uuid,
  p_order   uuid,
  p_amount_cents bigint,
  p_account uuid default null,
  p_note    text default null
)
returns table (out_paid_cents bigint, out_total_cents bigint)
language plpgsql security definer set search_path = '' as $$
declare
  v_user    uuid := auth.uid();
  v_order   record;
  v_account uuid;
  v_paid    bigint;
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not app.has_branch_permission(p_org, p_branch, 'retail.purchase.manage') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  -- Taking money out of the till is its own privilege.
  if not app.has_branch_permission(p_org, p_branch, 'treasury.create') then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'a payment needs a positive amount' using errcode = 'check_violation';
  end if;

  select * into v_order from public.retail_purchase_orders
   where id = p_order and organization_id = p_org and branch_id = p_branch;
  if v_order.id is null then
    raise exception 'purchase order not found' using errcode = 'check_violation';
  end if;
  if v_order.status = 'cancelled' then
    raise exception 'a cancelled order cannot be paid' using errcode = 'check_violation';
  end if;
  if v_order.paid_cents + p_amount_cents > v_order.total_cents then
    raise exception 'payment exceeds the order total' using errcode = 'check_violation';
  end if;

  v_account := p_account;
  if v_account is null then
    select id into v_account from public.treasury_accounts
     where organization_id = p_org and branch_id = p_branch and is_default and is_active
     limit 1;
  end if;
  if v_account is null or not exists (
    select 1 from public.treasury_accounts a
     where a.id = v_account and a.organization_id = p_org and a.branch_id = p_branch
  ) then
    raise exception 'no treasury account for this branch' using errcode = 'check_violation';
  end if;

  insert into public.treasury_transactions
    (organization_id, branch_id, account_id, direction, amount_cents, currency,
     category, reason, ref_type, ref_id, created_by)
  values
    (p_org, p_branch, v_account, 'out', p_amount_cents, v_order.currency,
     'purchase', coalesce(p_note, 'مشتريات ' || v_order.number),
     'retail_purchase', p_order, v_user);

  -- Recomputed from the ledger, not incremented.
  select coalesce(sum(amount_cents), 0) into v_paid
    from public.treasury_transactions
   where ref_type = 'retail_purchase' and ref_id = p_order and direction = 'out';

  update public.retail_purchase_orders set paid_cents = v_paid where id = p_order;

  insert into public.audit_logs
    (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values
    (p_org, p_branch, v_user, 'retail.purchase.paid', 'retail_purchase_order',
     p_order::text,
     jsonb_build_object('amount_cents', p_amount_cents, 'paid_cents', v_paid));

  return query select v_paid, v_order.total_cents;
end;
$$;

-- ---------------------------------------------------------------------------
-- 11. Grants.
--
-- PostgreSQL grants EXECUTE to PUBLIC on creation, so every revoke comes
-- before its grant — the lesson of 0028.
-- ---------------------------------------------------------------------------
do $$
declare fn text;
begin
  foreach fn in array array[
    'public.retail_purchase_create(uuid, uuid, uuid, jsonb, timestamptz, text)',
    'public.retail_purchase_submit(uuid, uuid, uuid)',
    'public.retail_purchase_receive(uuid, uuid, uuid, jsonb, text)',
    'public.retail_purchase_cancel(uuid, uuid, uuid, text)',
    'public.retail_purchase_pay(uuid, uuid, uuid, bigint, uuid, text)'
  ]
  loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end $$;

revoke all on function app.check_purchase_order_tenancy()      from public, anon, authenticated;
revoke all on function app.check_purchase_item_tenancy()       from public, anon, authenticated;
revoke all on function app.derive_purchase_order_total()       from public, anon, authenticated;
-- The line-total trigger is a plain trigger running as the writer, and all
-- writers are SECURITY DEFINER functions owned by the table owner, so it needs
-- no grant of its own.
revoke all on function app.derive_purchase_line_total()        from public, anon, authenticated;
revoke all on function app.check_purchase_order_transition()   from public, anon, authenticated;
