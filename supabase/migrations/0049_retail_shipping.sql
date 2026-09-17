-- =============================================================================
-- LOCAL BASIC — 0049 Shipping
--
-- A delivery order already knows where it is going (0046). What it could not
-- say is who is carrying it, what it cost to carry, and where it is now.
--
-- The decisions, stated once:
--
--   * NO COURIER IS NAMED IN THE SCHEMA. `provider_key` is free text with one
--     row in a providers table today — 'manual', the shop's own rider or a
--     courier whose tracking a human types in. Integrating a real courier is a
--     new row and an adapter in the application, not a migration.
--
--   * A SHIPMENT IS NOT AN ORDER. The order's state machine is about the
--     customer's purchase; a shipment's is about a parcel. A parcel can fail
--     and be re-sent without the customer's order changing status, and that is
--     a distinction a single status column cannot make.
--
--   * MONEY STAYS WHERE MONEY LIVES. What the customer PAID for delivery is
--     the order's `delivery_fee_cents` and is already on the receipt. What the
--     shop PAID the courier is a cost, recorded here and settled through the
--     treasury like any other expense. Conflating the two would make the
--     shop's margin wrong in the one place it is most tempting to fudge.
--
--   * PROVIDERS ARE PER ORGANIZATION. One shop's rider is not another's, and a
--     courier account is a tenant's commercial relationship.
--
-- Everything additive.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Who can carry a parcel.
--
-- `settings` holds no credentials and neither does this: a courier API key is
-- server-side configuration, never a tenant-writable column. What lives here
-- is the shop's own list of the options it offers.
-- ---------------------------------------------------------------------------
create table public.retail_shipping_providers (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  -- Which adapter handles it. 'manual' is the only one the application
  -- implements today; a courier integration adds a key here and a class there.
  provider_key     text not null default 'manual'
                   check (provider_key ~ '^[a-z][a-z0-9_]{1,30}$'),
  name             text not null check (length(trim(name)) between 2 and 120),
  -- The shop's default charge to the customer is the store setting; this is
  -- what the shop expects to PAY, used to prefill a shipment's cost.
  default_cost_cents bigint not null default 0 check (default_cost_cents >= 0),
  phone            text,
  notes            text,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid references public.profiles(id)
);
create index retail_shipping_providers_org_idx
  on public.retail_shipping_providers(organization_id) where is_active;
create trigger retail_shipping_providers_touch before update
  on public.retail_shipping_providers
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 2. The parcel.
--
-- One shipment per attempt, not one per order: a failed delivery is a closed
-- shipment and a new one, so the history says what actually happened rather
-- than being overwritten by the retry.
-- ---------------------------------------------------------------------------
create table public.retail_shipments (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  branch_id        uuid not null references public.branches(id) on delete restrict,
  order_id         uuid not null references public.retail_orders(id) on delete cascade,
  provider_id      uuid references public.retail_shipping_providers(id) on delete restrict,
  provider_key     text not null default 'manual',
  status           text not null default 'pending'
                   check (status in ('pending','dispatched','delivered','failed','cancelled')),
  -- Whatever the carrier calls it. Typed in for a manual provider, returned by
  -- the adapter for an integrated one. Never generated here: inventing a
  -- tracking number would make the shop promise something it cannot honour.
  tracking_code    text,
  tracking_url     text check (tracking_url is null or tracking_url ~* '^https://'),
  -- What the SHOP pays the carrier. Not what the customer paid for delivery.
  cost_cents       bigint not null default 0 check (cost_cents >= 0),
  currency         char(3) not null,
  recipient_name   text not null,
  phone            text not null,
  city             text not null,
  address_line     text not null,
  note             text,
  failure_reason   text,
  dispatched_at    timestamptz,
  delivered_at     timestamptz,
  failed_at        timestamptz,
  cancelled_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid references public.profiles(id)
);
create index retail_shipments_order_idx on public.retail_shipments(order_id, created_at desc);
create index retail_shipments_branch_idx
  on public.retail_shipments(organization_id, branch_id, created_at desc);
create index retail_shipments_status_idx
  on public.retail_shipments(organization_id, branch_id, status)
  where status in ('pending', 'dispatched');
-- At most one shipment in flight per order: two riders carrying the same
-- parcel is a mistake, not a workflow.
create unique index retail_shipments_one_in_flight
  on public.retail_shipments(order_id)
  where status in ('pending', 'dispatched');
create trigger retail_shipments_touch before update on public.retail_shipments
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 3. Tenancy guards.
-- ---------------------------------------------------------------------------
create or replace function app.check_shipment_tenancy()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_branch uuid; v_type text;
begin
  select organization_id into v_org from public.branches where id = new.branch_id;
  if v_org is distinct from new.organization_id then
    raise exception 'shipment crosses organizations' using errcode = 'check_violation';
  end if;

  select o.organization_id, o.branch_id, o.fulfillment_type
    into v_org, v_branch, v_type
    from public.retail_orders o where o.id = new.order_id;

  if v_org is distinct from new.organization_id or v_branch is distinct from new.branch_id then
    raise exception 'shipment does not belong to its order''s branch'
      using errcode = 'check_violation';
  end if;

  -- A pickup order has nothing to ship. Enforced here rather than in the
  -- caller, so no future writer can forget it.
  if v_type <> 'delivery' then
    raise exception 'only a delivery order can be shipped' using errcode = 'check_violation';
  end if;

  if new.provider_id is not null then
    select organization_id into v_org
      from public.retail_shipping_providers where id = new.provider_id;
    if v_org is distinct from new.organization_id then
      raise exception 'provider belongs to another organization'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

create trigger retail_shipments_tenancy
  before insert or update on public.retail_shipments
  for each row execute function app.check_shipment_tenancy();

-- ---------------------------------------------------------------------------
-- 4. The shipment state machine.
--
-- pending → dispatched → delivered, with failure reachable from either live
-- state and cancellation only before dispatch. Delivered, failed and cancelled
-- are final: a parcel's history is not edited, a new attempt is a new row.
-- ---------------------------------------------------------------------------
create or replace function app.check_shipment_transition()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.organization_id <> old.organization_id or new.order_id <> old.order_id then
    raise exception 'a shipment cannot move between tenants or orders'
      using errcode = 'check_violation';
  end if;

  if new.status = old.status then return new; end if;

  if not (
       (old.status = 'pending'    and new.status in ('dispatched','failed','cancelled'))
    or (old.status = 'dispatched' and new.status in ('delivered','failed'))
  ) then
    raise exception 'cannot move a shipment from % to %', old.status, new.status
      using errcode = 'check_violation';
  end if;

  if new.status = 'failed' and coalesce(trim(new.failure_reason), '') = '' then
    raise exception 'a failed shipment needs a reason' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger retail_shipments_transition
  before update on public.retail_shipments
  for each row execute function app.check_shipment_transition();

-- ---------------------------------------------------------------------------
-- 5. RLS.
--
-- Shipping is part of running the storefront's orders, so it rides the
-- existing retail.order permissions rather than inventing a pair nobody has
-- been granted. Providers are settings, and are managed with settings.manage.
-- ---------------------------------------------------------------------------
alter table public.retail_shipping_providers enable row level security;
alter table public.retail_shipping_providers force row level security;
alter table public.retail_shipments          enable row level security;
alter table public.retail_shipments          force row level security;

create policy retail_shipping_providers_select
  on public.retail_shipping_providers for select to authenticated
  using (app.has_permission(organization_id, 'retail.order.read')
      or app.has_permission(organization_id, 'settings.manage'));

create policy retail_shipping_providers_write
  on public.retail_shipping_providers for all to authenticated
  using (app.has_permission(organization_id, 'settings.manage'))
  with check (app.has_permission(organization_id, 'settings.manage'));

create policy retail_shipments_select
  on public.retail_shipments for select to authenticated
  using (app.has_branch_permission(organization_id, branch_id, 'retail.order.read'));

grant select, insert, update on public.retail_shipping_providers to authenticated;
revoke delete on public.retail_shipping_providers from authenticated;
grant select on public.retail_shipments to authenticated;
revoke all on public.retail_shipping_providers from anon;
revoke all on public.retail_shipments          from anon;

-- ---------------------------------------------------------------------------
-- 6. Create a shipment.
--
-- The address is COPIED from the order's delivery record rather than passed
-- in, for the same reason prices are read back at checkout: the caller should
-- not be able to send a parcel somewhere the customer did not ask for. The
-- snapshot then survives the customer editing their address later.
--
-- A tracking code is accepted, never generated. An adapter that talks to a
-- real courier calls `retail_shipment_set_tracking` with what the courier
-- returned; a manual provider gets whatever the operator typed, or nothing.
-- ---------------------------------------------------------------------------
create or replace function public.retail_shipment_create(
  p_org           uuid,
  p_branch        uuid,
  p_order         uuid,
  p_provider      uuid default null,
  p_cost_cents    bigint default null,
  p_tracking_code text default null,
  p_note          text default null
)
returns table (out_id uuid, out_provider_key text)
language plpgsql security definer set search_path = '' as $$
declare
  v_user     uuid := auth.uid();
  v_order    record;
  v_addr     record;
  v_provider record;
  v_key      text := 'manual';
  v_cost     bigint;
  v_id       uuid;
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not app.has_branch_permission(p_org, p_branch, 'retail.order.manage') then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  select * into v_order from public.retail_orders
   where id = p_order and organization_id = p_org and branch_id = p_branch;
  if v_order.id is null then
    raise exception 'order not found' using errcode = 'check_violation';
  end if;
  if v_order.status in ('completed','cancelled') then
    raise exception 'a % order cannot be shipped', v_order.status
      using errcode = 'check_violation';
  end if;

  select * into v_addr from public.retail_order_deliveries where order_id = p_order;
  if v_addr.order_id is null then
    raise exception 'this order has no delivery address' using errcode = 'check_violation';
  end if;

  if p_provider is not null then
    select * into v_provider from public.retail_shipping_providers
     where id = p_provider and organization_id = p_org and is_active;
    if v_provider.id is null then
      raise exception 'unknown shipping provider' using errcode = 'check_violation';
    end if;
    v_key  := v_provider.provider_key;
    v_cost := coalesce(p_cost_cents, v_provider.default_cost_cents);
  else
    v_cost := coalesce(p_cost_cents, 0);
  end if;

  if v_cost < 0 then
    raise exception 'a shipping cost cannot be negative' using errcode = 'check_violation';
  end if;

  insert into public.retail_shipments
    (organization_id, branch_id, order_id, provider_id, provider_key, status,
     tracking_code, cost_cents, currency,
     recipient_name, phone, city, address_line, note, created_by)
  values
    (p_org, p_branch, p_order, p_provider, v_key, 'pending',
     nullif(trim(coalesce(p_tracking_code, '')), ''), v_cost, v_order.currency,
     v_addr.recipient_name, v_addr.phone, v_addr.city,
     v_addr.address_line
       || case when coalesce(v_addr.area, '') = '' then '' else ' — ' || v_addr.area end
       || case when coalesce(v_addr.landmark, '') = '' then '' else ' (' || v_addr.landmark || ')' end,
     p_note, v_user)
  returning id into v_id;

  insert into public.audit_logs
    (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values
    (p_org, p_branch, v_user, 'retail.shipment.created', 'retail_shipment', v_id::text,
     jsonb_build_object('order', v_order.number, 'provider', v_key, 'cost_cents', v_cost));

  return query select v_id, v_key;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Record what the carrier said.
--
-- An adapter reports; it does not decide. The transition trigger above is what
-- decides whether the reported status is a legal move, so an adapter that
-- returns nonsense is refused rather than believed.
-- ---------------------------------------------------------------------------
create or replace function public.retail_shipment_set_status(
  p_org      uuid,
  p_branch   uuid,
  p_shipment uuid,
  p_status   text,
  p_reason   text default null
)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_row  record;
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not app.has_branch_permission(p_org, p_branch, 'retail.order.manage') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if p_status not in ('dispatched','delivered','failed','cancelled') then
    raise exception 'unknown shipment status %', p_status using errcode = '22023';
  end if;

  select * into v_row from public.retail_shipments
   where id = p_shipment and organization_id = p_org and branch_id = p_branch
   for update;
  if v_row.id is null then
    raise exception 'shipment not found' using errcode = 'check_violation';
  end if;

  update public.retail_shipments
     set status = p_status,
         failure_reason = case when p_status = 'failed' then p_reason else failure_reason end,
         dispatched_at  = case when p_status = 'dispatched' then now() else dispatched_at end,
         delivered_at   = case when p_status = 'delivered'  then now() else delivered_at end,
         failed_at      = case when p_status = 'failed'     then now() else failed_at end,
         cancelled_at   = case when p_status = 'cancelled'  then now() else cancelled_at end
   where id = p_shipment;

  insert into public.audit_logs
    (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values
    (p_org, p_branch, v_user, 'retail.shipment.' || p_status, 'retail_shipment',
     p_shipment::text, jsonb_build_object('status', p_status, 'reason', p_reason));
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Tracking, once the carrier has issued it.
-- ---------------------------------------------------------------------------
create or replace function public.retail_shipment_set_tracking(
  p_org      uuid,
  p_branch   uuid,
  p_shipment uuid,
  p_code     text,
  p_url      text default null
)
returns void language plpgsql security definer set search_path = '' as $$
declare v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not app.has_branch_permission(p_org, p_branch, 'retail.order.manage') then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  update public.retail_shipments
     set tracking_code = nullif(trim(coalesce(p_code, '')), ''),
         tracking_url  = nullif(trim(coalesce(p_url, '')), '')
   where id = p_shipment and organization_id = p_org and branch_id = p_branch;

  if not found then
    raise exception 'shipment not found' using errcode = 'check_violation';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. What the shop paid the carrier.
--
-- A treasury 'out' movement with its own category, so delivery cost is
-- separable from purchases and expenses in every report. Recorded once per
-- shipment: `paid` is derived from the ledger, not incremented.
-- ---------------------------------------------------------------------------
create or replace function public.retail_shipment_pay(
  p_org      uuid,
  p_branch   uuid,
  p_shipment uuid,
  p_account  uuid default null
)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  v_user    uuid := auth.uid();
  v_row     record;
  v_account uuid;
  v_paid    bigint;
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not app.has_branch_permission(p_org, p_branch, 'retail.order.manage') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if not app.has_branch_permission(p_org, p_branch, 'treasury.create') then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  select * into v_row from public.retail_shipments
   where id = p_shipment and organization_id = p_org and branch_id = p_branch;
  if v_row.id is null then
    raise exception 'shipment not found' using errcode = 'check_violation';
  end if;
  if v_row.cost_cents <= 0 then
    raise exception 'this shipment has no cost to settle' using errcode = 'check_violation';
  end if;

  select coalesce(sum(amount_cents), 0) into v_paid
    from public.treasury_transactions
   where ref_type = 'retail_shipment' and ref_id = p_shipment and direction = 'out';
  if v_paid >= v_row.cost_cents then
    raise exception 'this shipment is already settled' using errcode = 'check_violation';
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
    (p_org, p_branch, v_account, 'out', v_row.cost_cents - v_paid, v_row.currency,
     'shipping', 'شحن ' || coalesce(v_row.tracking_code, v_row.recipient_name),
     'retail_shipment', p_shipment, v_user);

  insert into public.audit_logs
    (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values
    (p_org, p_branch, v_user, 'retail.shipment.paid', 'retail_shipment', p_shipment::text,
     jsonb_build_object('amount_cents', v_row.cost_cents - v_paid));

  return v_row.cost_cents;
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Grants. Revoke before grant — the lesson of 0028.
-- ---------------------------------------------------------------------------
do $$
declare fn text;
begin
  foreach fn in array array[
    'public.retail_shipment_create(uuid, uuid, uuid, uuid, bigint, text, text)',
    'public.retail_shipment_set_status(uuid, uuid, uuid, text, text)',
    'public.retail_shipment_set_tracking(uuid, uuid, uuid, text, text)',
    'public.retail_shipment_pay(uuid, uuid, uuid, uuid)'
  ]
  loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end $$;

revoke all on function app.check_shipment_tenancy()    from public, anon, authenticated;
revoke all on function app.check_shipment_transition() from public, anon, authenticated;
