-- =============================================================================
-- LOCAL BASIC — 0012 Retail inventory
--
-- The ledger is the truth. `retail_stock_levels` is a projection maintained
-- exclusively by a trigger on `retail_stock_movements`; nothing else may write
-- it, so a stock figure can never disagree with the movements behind it.
--
-- Concurrency: the projection is updated with INSERT … ON CONFLICT DO UPDATE,
-- which takes a row lock on the stock row for the remainder of the
-- transaction. Two simultaneous sales of the last unit therefore serialise,
-- and the second fails the non-negative CHECK rather than overselling.
-- POS and the online store both write through this one path, so their stock
-- cannot drift apart.
-- =============================================================================

create table public.retail_stock_levels (
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  branch_id        uuid not null references public.branches(id) on delete cascade,
  variant_id       uuid not null references public.retail_variants(id) on delete cascade,
  quantity         numeric(14,3) not null default 0,
  updated_at       timestamptz not null default now(),
  primary key (branch_id, variant_id),
  -- The backstop against overselling. If this ever fires, the transaction that
  -- would have driven stock negative is aborted in full.
  constraint retail_stock_non_negative check (quantity >= 0)
);
create index retail_stock_levels_org_idx
  on public.retail_stock_levels(organization_id, branch_id);
create index retail_stock_levels_variant_idx on public.retail_stock_levels(variant_id);

-- ---------------------------------------------------------------------------
-- The ledger. Append-only: no UPDATE or DELETE policy, and no privilege.
-- A correction is a new compensating movement, never an edit.
-- ---------------------------------------------------------------------------
create table public.retail_stock_movements (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  branch_id        uuid not null references public.branches(id) on delete restrict,
  variant_id       uuid not null references public.retail_variants(id) on delete restrict,
  -- Negative for anything leaving the branch, positive for anything arriving.
  quantity_delta   numeric(14,3) not null check (quantity_delta <> 0),
  reason           text not null check (reason in (
    'sale', 'return', 'purchase', 'purchase_return',
    'adjustment', 'transfer_in', 'transfer_out', 'damage', 'stocktake', 'initial'
  )),
  -- What caused it, without inventory needing to know about invoices:
  -- 'invoice', 'retail_order', 'retail_purchase', 'manual'
  ref_type         text,
  ref_id           uuid,
  -- Cost at the time of the movement, for valuation and margin reporting.
  unit_cost_cents  bigint check (unit_cost_cents is null or unit_cost_cents >= 0),
  note             text,
  occurred_at      timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  created_by       uuid references public.profiles(id)
);
create index retail_movements_variant_idx
  on public.retail_stock_movements(variant_id, occurred_at desc);
create index retail_movements_branch_idx
  on public.retail_stock_movements(organization_id, branch_id, occurred_at desc);
create index retail_movements_ref_idx
  on public.retail_stock_movements(ref_type, ref_id);

-- ---------------------------------------------------------------------------
-- Projection maintenance + tenancy guard.
--
-- SECURITY DEFINER so the projection can be written while remaining
-- unwritable by any client, and so the movement's organization is verified
-- against the variant and branch rather than trusted from the row.
-- ---------------------------------------------------------------------------
create or replace function app.apply_stock_movement()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_variant_org uuid;
  v_branch_org  uuid;
begin
  select organization_id into v_variant_org
    from public.retail_variants where id = new.variant_id;
  select organization_id into v_branch_org
    from public.branches where id = new.branch_id;

  if v_variant_org is null or v_variant_org <> new.organization_id
     or v_branch_org is null or v_branch_org <> new.organization_id then
    raise exception 'stock movement crosses organizations'
      using errcode = 'check_violation';
  end if;

  -- UPDATE first, which takes a row lock for the rest of the transaction. A
  -- concurrent movement on the same (branch, variant) blocks here and, once
  -- released, re-evaluates `quantity + delta` against the committed value —
  -- so two simultaneous sales of the last unit serialise and the second is
  -- rejected by the non-negative CHECK rather than overselling.
  --
  -- ON CONFLICT cannot be used as the primary path: PostgreSQL evaluates the
  -- proposed row's CHECK constraints before conflict resolution, so a negative
  -- delta would abort instead of being added to the existing quantity.
  update public.retail_stock_levels
     set quantity   = quantity + new.quantity_delta,
         updated_at = now()
   where branch_id = new.branch_id
     and variant_id = new.variant_id;

  if not found then
    -- First ever movement for this (branch, variant). A negative delta here
    -- is correctly refused by the CHECK: there is nothing to sell from.
    insert into public.retail_stock_levels
      (organization_id, branch_id, variant_id, quantity, updated_at)
    values
      (new.organization_id, new.branch_id, new.variant_id, new.quantity_delta, now())
    on conflict (branch_id, variant_id) do update
      set quantity   = public.retail_stock_levels.quantity + excluded.quantity,
          updated_at = now();
  end if;

  return new;
end;
$$;

create trigger retail_movements_apply
  after insert on public.retail_stock_movements
  for each row execute function app.apply_stock_movement();

-- ---------------------------------------------------------------------------
-- Current stock for a variant in a branch. INVOKER, so it can only sum what
-- the caller is allowed to read.
-- ---------------------------------------------------------------------------
create or replace function public.retail_stock_of(p_branch uuid, p_variant uuid)
returns numeric language sql stable security invoker set search_path = '' as $$
  select coalesce(
    (select quantity from public.retail_stock_levels
      where branch_id = p_branch and variant_id = p_variant), 0);
$$;
grant execute on function public.retail_stock_of(uuid, uuid) to authenticated;
