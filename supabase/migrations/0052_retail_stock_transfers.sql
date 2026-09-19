-- =============================================================================
-- LOCAL BASIC — 0052 Retail stock transfers between branches
--
-- 0012 listed 'transfer_in' and 'transfer_out' among the movement reasons, but
-- nothing ever paired them. Moving stock between two branches meant recording
-- two unrelated manual adjustments, which left two real problems:
--
--   1. NOTHING TIED THE LEGS TOGETHER. A storekeeper could record the stock
--      leaving branch A and never record it arriving at branch B, or record a
--      different quantity. The ledger balanced per branch and lied overall.
--
--   2. 'transfer_in' WAS UNAUDITED STOCK CREATION. Anyone holding
--      retail.inventory.adjust could add any quantity to their own branch and
--      call it an incoming transfer, with no source branch to reconcile
--      against. That is the same authority as a stocktake, but without a
--      stocktake's meaning.
--
-- THE MODEL
--
--   retail_stock_transfers        the movement of goods, as a document
--   retail_stock_transfer_lines   what moved, per variant
--
-- One function writes all of it in one transaction: the header, the lines, and
-- both movement legs. 0012's trigger already takes the row lock and refuses to
-- drive stock negative, so a transfer that exceeds what the source branch
-- actually holds aborts entirely — no partial transfer, no phantom arrival.
--
-- Transfers are immediate: stock leaves and arrives in the same commit. There
-- is no in-transit state, because modelling one means deciding who owns goods
-- on a van and what happens when they never arrive, and that is a business
-- decision nobody has made yet. The document is here so a future in-transit
-- status can be added to it rather than replacing it.
--
-- WHAT THIS DOES NOT CHANGE
--
-- Nothing in 0012, 0013, 0014 or 0015 is altered. The reasons were already
-- legal values; they simply now have to come from a transfer.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. The permission.
--
-- Separate from retail.inventory.adjust on purpose. Adjusting is a statement
-- about one branch's own shelves — a breakage, a recount. A transfer reaches
-- into a second branch and changes ITS stock, which is a different authority
-- and belongs to whoever is trusted with both.
-- ---------------------------------------------------------------------------
insert into public.permissions (key, group_key, module_key, description, is_elevated) values
  ('retail.inventory.transfer', 'retail', 'retail',
   'Move stock between branches', false)
on conflict (key) do update
  set description = excluded.description,
      group_key   = excluded.group_key,
      module_key  = excluded.module_key;

-- Templates that already manage stock across a business gain it. A cashier
-- does not, and neither does anyone holding only retail.inventory.adjust.
with tpl as (
  select id, key from public.roles where organization_id is null
)
insert into public.role_permissions (role_id, permission_key)
select tpl.id, 'retail.inventory.transfer'
from tpl where tpl.key in ('admin', 'manager', 'storekeeper')
on conflict do nothing;

-- Organizations provisioned before this migration keep their owner role in
-- sync with the catalog, so a new permission is never locked away from them.
-- Same statement 0019 used, for the same reason.
insert into public.role_permissions (role_id, permission_key)
select r.id, p.key
from public.roles r
cross join public.permissions p
where r.is_owner and r.organization_id is not null
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 2. The transfer document.
--
-- Financial and inventory history: no cascade from branches, so retiring a
-- branch can never silently erase the record of stock that moved through it.
-- The organization cascade is deliberate and matches every other tenant table
-- — deleting a customer removes the customer.
-- ---------------------------------------------------------------------------
create table public.retail_stock_transfers (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  from_branch_id  uuid not null references public.branches(id) on delete restrict,
  to_branch_id    uuid not null references public.branches(id) on delete restrict,
  note            text check (note is null or length(note) <= 500),
  created_by      uuid references public.profiles(id),
  created_at      timestamptz not null default now(),

  -- Stock cannot move to where it already is.
  constraint retail_transfer_distinct_branches check (from_branch_id <> to_branch_id)
);

create index retail_stock_transfers_org_idx
  on public.retail_stock_transfers(organization_id, created_at desc);
create index retail_stock_transfers_from_idx
  on public.retail_stock_transfers(from_branch_id, created_at desc);
create index retail_stock_transfers_to_idx
  on public.retail_stock_transfers(to_branch_id, created_at desc);

create table public.retail_stock_transfer_lines (
  id              uuid primary key default gen_random_uuid(),
  transfer_id     uuid not null references public.retail_stock_transfers(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  variant_id      uuid not null references public.retail_variants(id) on delete restrict,
  quantity        numeric(14,3) not null check (quantity > 0),

  -- The same variant twice on one transfer is a mistake, not two movements.
  unique (transfer_id, variant_id)
);

create index retail_stock_transfer_lines_transfer_idx
  on public.retail_stock_transfer_lines(transfer_id);

-- ---------------------------------------------------------------------------
-- 3. A transfer reason may only come from a transfer.
--
-- This is what closes the hole. 'transfer_in' can no longer be written as a
-- manual adjustment, so stock cannot appear in a branch without a document
-- naming where it came from.
--
-- NOT VALID on purpose: rows written before this migration were legal when
-- they were written, and rewriting or rejecting history to satisfy a new rule
-- would be worse than the rule not being retroactive. It is enforced on every
-- row from here on.
-- ---------------------------------------------------------------------------
alter table public.retail_stock_movements
  add constraint retail_movements_transfer_has_document
  check (reason not in ('transfer_in', 'transfer_out') or ref_type = 'transfer')
  not valid;

-- ---------------------------------------------------------------------------
-- 4. RLS.
--
-- Read requires retail.inventory.read on EITHER end: both branches took part,
-- and a branch manager needs to see what left them as well as what arrived.
--
-- No insert, update or delete policy at all. The document is written solely by
-- the function below, so a transfer can never exist without its movements, and
-- a movement can never be edited to disagree with its document.
-- ---------------------------------------------------------------------------
alter table public.retail_stock_transfers       enable row level security;
alter table public.retail_stock_transfer_lines  enable row level security;
alter table public.retail_stock_transfers       force row level security;
alter table public.retail_stock_transfer_lines  force row level security;

create policy retail_stock_transfers_select on public.retail_stock_transfers
  for select to authenticated
  using (
    app.has_branch_permission(organization_id, from_branch_id, 'retail.inventory.read')
    or app.has_branch_permission(organization_id, to_branch_id, 'retail.inventory.read')
  );

create policy retail_stock_transfer_lines_select on public.retail_stock_transfer_lines
  for select to authenticated
  using (exists (
    select 1 from public.retail_stock_transfers t
    where t.id = transfer_id
      and (app.has_branch_permission(t.organization_id, t.from_branch_id, 'retail.inventory.read')
        or app.has_branch_permission(t.organization_id, t.to_branch_id, 'retail.inventory.read'))
  ));

revoke all on public.retail_stock_transfers      from anon;
revoke all on public.retail_stock_transfer_lines from anon;
grant select on public.retail_stock_transfers      to authenticated;
grant select on public.retail_stock_transfer_lines to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Move the stock.
--
-- Both legs, the document and the audit line in one transaction. The caller
-- names branches and quantities; it never names a movement, so the two legs
-- cannot be made to disagree.
--
-- Permission is required on BOTH ends. Holding it in the source branch alone
-- would let someone push stock into a branch they have no business touching,
-- and inflate its inventory from a distance.
-- ---------------------------------------------------------------------------
create or replace function public.retail_stock_transfer(
  p_org         uuid,
  p_from_branch uuid,
  p_to_branch   uuid,
  p_items       jsonb,
  p_note        text default null
)
returns table (out_transfer_id uuid, out_line_count int)
language plpgsql security definer set search_path = '' as $$
declare
  v_user     uuid := auth.uid();
  v_transfer uuid;
  v_item     jsonb;
  v_variant  uuid;
  v_qty      numeric(14,3);
  v_count    int := 0;
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  if p_from_branch = p_to_branch then
    raise exception 'المصدر والوجهة لا يمكن أن يكونا نفس الفرع' using errcode = 'check_violation';
  end if;

  -- Both ends, separately. See the note above.
  if not app.has_branch_permission(p_org, p_from_branch, 'retail.inventory.transfer')
     or not app.has_branch_permission(p_org, p_to_branch, 'retail.inventory.transfer') then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  -- Both branches must belong to this organization and be live. Checked here
  -- rather than trusted from the caller: a branch id is a client-supplied
  -- value like any other.
  if (select count(*) from public.branches b
       where b.id in (p_from_branch, p_to_branch)
         and b.organization_id = p_org
         and b.is_active
         and b.deleted_at is null) <> 2 then
    raise exception 'فرع غير صالح' using errcode = 'check_violation';
  end if;

  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'التحويل يحتاج صنفًا واحدًا على الأقل' using errcode = 'check_violation';
  end if;

  insert into public.retail_stock_transfers
    (organization_id, from_branch_id, to_branch_id, note, created_by)
  values (p_org, p_from_branch, p_to_branch,
          nullif(left(trim(coalesce(p_note, '')), 500), ''), v_user)
  returning id into v_transfer;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_variant := (v_item ->> 'variant_id')::uuid;
    v_qty     := (v_item ->> 'quantity')::numeric;

    if v_qty is null or v_qty <= 0 then
      raise exception 'الكمية يجب أن تكون أكبر من صفر' using errcode = 'check_violation';
    end if;

    -- The variant must be this organization's. Without this a caller could
    -- move another tenant's product and write rows against their catalog.
    if not exists (
      select 1 from public.retail_variants v
      where v.id = v_variant and v.organization_id = p_org and v.deleted_at is null
    ) then
      raise exception 'صنف غير صالح' using errcode = 'check_violation';
    end if;

    insert into public.retail_stock_transfer_lines
      (transfer_id, organization_id, variant_id, quantity)
    values (v_transfer, p_org, v_variant, v_qty);

    -- Out first. 0012's trigger takes the row lock and refuses to drive the
    -- source branch negative, so an over-transfer aborts the whole statement
    -- before anything arrives anywhere.
    insert into public.retail_stock_movements
      (organization_id, branch_id, variant_id, quantity_delta, reason,
       ref_type, ref_id, note, created_by)
    values (p_org, p_from_branch, v_variant, -v_qty, 'transfer_out',
            'transfer', v_transfer, null, v_user);

    insert into public.retail_stock_movements
      (organization_id, branch_id, variant_id, quantity_delta, reason,
       ref_type, ref_id, note, created_by)
    values (p_org, p_to_branch, v_variant, v_qty, 'transfer_in',
            'transfer', v_transfer, null, v_user);

    v_count := v_count + 1;
  end loop;

  insert into public.audit_logs
    (organization_id, branch_id, actor_id, actor_label, action,
     entity_type, entity_id, after)
  values (
    p_org, p_from_branch, v_user,
    (select p.full_name from public.profiles p where p.id = v_user),
    'retail.stock_transferred', 'retail_stock_transfer', v_transfer::text,
    jsonb_build_object('from_branch', p_from_branch, 'to_branch', p_to_branch,
                       'lines', v_count)
  );

  return query select v_transfer, v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Grants. PUBLIC first — Postgres grants EXECUTE to PUBLIC on creation and
-- a later narrower grant does not take it away (the lesson of 0028).
-- ---------------------------------------------------------------------------
revoke all on function public.retail_stock_transfer(uuid, uuid, uuid, jsonb, text)
  from public, anon;
grant execute on function public.retail_stock_transfer(uuid, uuid, uuid, jsonb, text)
  to authenticated;
