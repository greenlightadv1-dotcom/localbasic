-- =============================================================================
-- LOCAL BASIC — 0013 Retail RLS and grants
-- =============================================================================

alter table public.retail_categories      enable row level security;
alter table public.retail_suppliers       enable row level security;
alter table public.retail_products        enable row level security;
alter table public.retail_variants        enable row level security;
alter table public.retail_stock_levels    enable row level security;
alter table public.retail_stock_movements enable row level security;

alter table public.retail_categories      force row level security;
alter table public.retail_suppliers       force row level security;
alter table public.retail_products        force row level security;
alter table public.retail_variants        force row level security;
alter table public.retail_stock_levels    force row level security;
alter table public.retail_stock_movements force row level security;

-- ---------------------------------------------------------------------------
-- Catalog — organization-wide: a product is not owned by one branch.
-- ---------------------------------------------------------------------------
create policy retail_categories_select on public.retail_categories for select to authenticated
  using (app.has_permission(organization_id, 'retail.product.read'));

create policy retail_categories_write on public.retail_categories for all to authenticated
  using (app.has_permission(organization_id, 'retail.product.manage'))
  with check (app.has_permission(organization_id, 'retail.product.manage'));

create policy retail_products_select on public.retail_products for select to authenticated
  using (app.has_permission(organization_id, 'retail.product.read') and deleted_at is null);

create policy retail_products_insert on public.retail_products for insert to authenticated
  with check (app.has_permission(organization_id, 'retail.product.manage'));

create policy retail_products_update on public.retail_products for update to authenticated
  using (app.has_permission(organization_id, 'retail.product.manage'))
  with check (app.has_permission(organization_id, 'retail.product.manage'));

create policy retail_variants_select on public.retail_variants for select to authenticated
  using (app.has_permission(organization_id, 'retail.product.read') and deleted_at is null);

create policy retail_variants_insert on public.retail_variants for insert to authenticated
  with check (app.has_permission(organization_id, 'retail.product.manage'));

create policy retail_variants_update on public.retail_variants for update to authenticated
  using (app.has_permission(organization_id, 'retail.product.manage'))
  with check (app.has_permission(organization_id, 'retail.product.manage'));

-- ---------------------------------------------------------------------------
-- Suppliers
-- ---------------------------------------------------------------------------
create policy retail_suppliers_select on public.retail_suppliers for select to authenticated
  using (app.has_permission(organization_id, 'retail.purchase.read')
      or app.has_permission(organization_id, 'retail.supplier.manage'));

create policy retail_suppliers_write on public.retail_suppliers for all to authenticated
  using (app.has_permission(organization_id, 'retail.supplier.manage'))
  with check (app.has_permission(organization_id, 'retail.supplier.manage'));

-- ---------------------------------------------------------------------------
-- Stock levels — READ ONLY for everyone.
--
-- There is deliberately no insert/update/delete policy and no privilege: the
-- projection is maintained solely by the trigger on retail_stock_movements,
-- so a stock figure cannot be edited into something the ledger does not
-- support.
-- ---------------------------------------------------------------------------
create policy retail_stock_levels_select on public.retail_stock_levels for select to authenticated
  using (app.has_branch_permission(organization_id, branch_id, 'retail.inventory.read'));

-- ---------------------------------------------------------------------------
-- Stock movements — append only.
--
-- 'sale' and 'return' movements come from the POS and the storefront, which
-- need only the POS permission; everything else is a stock operation and
-- requires retail.inventory.adjust.
-- ---------------------------------------------------------------------------
create policy retail_movements_select on public.retail_stock_movements for select to authenticated
  using (app.has_branch_permission(organization_id, branch_id, 'retail.inventory.read'));

create policy retail_movements_insert on public.retail_stock_movements for insert to authenticated
  with check (
    case
      when reason in ('sale', 'return')
        then app.has_branch_permission(organization_id, branch_id, 'retail.pos.use')
      when reason in ('purchase', 'purchase_return')
        then app.has_branch_permission(organization_id, branch_id, 'retail.purchase.manage')
      else app.has_branch_permission(organization_id, branch_id, 'retail.inventory.adjust')
    end
  );

-- ---------------------------------------------------------------------------
-- Grants. anon gets nothing; the storefront reads through SECURITY DEFINER
-- projections added with the online store.
-- ---------------------------------------------------------------------------
grant select, insert, update on
  public.retail_categories, public.retail_suppliers,
  public.retail_products, public.retail_variants
to authenticated;

grant select on public.retail_stock_levels to authenticated;
grant select, insert on public.retail_stock_movements to authenticated;

-- Append-only and projection-only, stated as privileges as well as policies.
revoke update, delete on public.retail_stock_movements from authenticated;
revoke insert, update, delete on public.retail_stock_levels from authenticated;
revoke delete on public.retail_categories, public.retail_suppliers,
                 public.retail_products, public.retail_variants from authenticated;

revoke all on public.retail_categories, public.retail_suppliers,
               public.retail_products, public.retail_variants,
               public.retail_stock_levels, public.retail_stock_movements
from anon;
