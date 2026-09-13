-- =============================================================================
-- LOCAL BASIC — Retail inventory invariants
--
--  * the projection always equals the sum of the ledger
--  * stock cannot be driven negative
--  * stock levels cannot be written directly, only through movements
--  * movements cannot cross the tenant line
--  * POS and stock-adjustment permissions are enforced separately
-- =============================================================================

\set ON_ERROR_STOP on

do $$
declare
  u_owner uuid; u_keeper uuid;
  org uuid; branch uuid; branch2 uuid;
  org_b uuid; branch_b uuid; u_b uuid; variant_b uuid;
  cat uuid; prod uuid; variant uuid;
  member_k uuid; role_keeper uuid;
  qty numeric; ledger numeric;
  n int;
begin
  insert into auth.users (email) values ('inv-owner@test.local') returning id into u_owner;
  insert into auth.users (email) values ('inv-keeper@test.local') returning id into u_keeper;
  insert into auth.users (email) values ('inv-other@test.local') returning id into u_b;

  perform auth.login_as(u_owner);
  select out_organization_id, out_branch_id into org, branch
    from public.provision_workspace('Inv Store', 'invstore', 'retail', 'Main');
  perform auth.as_admin();

  perform auth.login_as(u_b);
  select out_organization_id, out_branch_id into org_b, branch_b
    from public.provision_workspace('Other Store', 'othstore', 'retail', 'Main');
  perform auth.as_admin();

  -- ==========================================================================
  -- Catalog
  -- ==========================================================================
  perform auth.login_as(u_owner);

  insert into public.branches (organization_id, slug, name)
  values (org, 'second', 'Second') returning id into branch2;

  insert into public.retail_categories (organization_id, name)
  values (org, 'مشروبات') returning id into cat;

  insert into public.retail_products (organization_id, category_id, name, unit)
  values (org, cat, 'قهوة', 'piece') returning id into prod;

  insert into public.retail_variants
    (organization_id, product_id, name, sku, barcode, price_cents, cost_cents)
  values (org, prod, '250g', 'COF-250', '6221000000017', 12000, 8000)
  returning id into variant;

  -- ==========================================================================
  -- 1. Opening stock, and the projection tracks the ledger
  -- ==========================================================================
  insert into public.retail_stock_movements
    (organization_id, branch_id, variant_id, quantity_delta, reason, unit_cost_cents)
  values (org, branch, variant, 10, 'initial', 8000);

  select quantity into qty from public.retail_stock_levels
   where branch_id = branch and variant_id = variant;
  assert qty = 10, 'FAIL: projection not created by the first movement';

  insert into public.retail_stock_movements
    (organization_id, branch_id, variant_id, quantity_delta, reason, ref_type)
  values (org, branch, variant, -2, 'sale', 'invoice');

  insert into public.retail_stock_movements
    (organization_id, branch_id, variant_id, quantity_delta, reason, ref_type)
  values (org, branch, variant, -1, 'sale', 'retail_order');

  select quantity into qty from public.retail_stock_levels
   where branch_id = branch and variant_id = variant;
  select sum(quantity_delta) into ledger from public.retail_stock_movements
   where branch_id = branch and variant_id = variant;

  -- The POS sale and the online sale hit the same stock: 10 - 2 - 1 = 7.
  assert qty = 7, format('FAIL: expected stock 7, got %s', qty);
  assert qty = ledger, 'FAIL: projection disagrees with the ledger';

  -- ==========================================================================
  -- 2. Stock is per branch, not per organization
  -- ==========================================================================
  select count(*) into n from public.retail_stock_levels
   where branch_id = branch2 and variant_id = variant;
  assert n = 0, 'FAIL: stock leaked across branches';

  -- ==========================================================================
  -- 3. Stock cannot go negative
  -- ==========================================================================
  begin
    insert into public.retail_stock_movements
      (organization_id, branch_id, variant_id, quantity_delta, reason)
    values (org, branch, variant, -8, 'sale');
    assert false, 'FAIL: stock was driven negative';
  exception when check_violation then null;
  end;

  select quantity into qty from public.retail_stock_levels
   where branch_id = branch and variant_id = variant;
  assert qty = 7, 'FAIL: failed oversell left the projection modified';

  -- ==========================================================================
  -- 4. The projection is not directly writable, even by the owner
  -- ==========================================================================
  begin
    update public.retail_stock_levels set quantity = 9999
     where branch_id = branch and variant_id = variant;
    assert false, 'FAIL: stock levels are directly editable';
  exception when insufficient_privilege then null;
  end;

  begin
    insert into public.retail_stock_levels (organization_id, branch_id, variant_id, quantity)
    values (org, branch2, variant, 500);
    assert false, 'FAIL: stock levels can be inserted directly';
  exception when insufficient_privilege then null;
  end;

  -- The ledger is append-only.
  begin
    update public.retail_stock_movements set quantity_delta = 100 where variant_id = variant;
    assert false, 'FAIL: stock movements are editable';
  exception when insufficient_privilege then null;
  end;

  begin
    delete from public.retail_stock_movements where variant_id = variant;
    assert false, 'FAIL: stock movements are deletable';
  exception when insufficient_privilege then null;
  end;

  perform auth.as_admin();

  -- ==========================================================================
  -- 5. Cross-tenant: movements and catalog stay inside the organization
  -- ==========================================================================
  perform auth.login_as(u_b);

  select count(*) into n from public.retail_products where organization_id = org;
  assert n = 0, 'FAIL: another organization can read the catalog';

  select count(*) into n from public.retail_stock_levels where organization_id = org;
  assert n = 0, 'FAIL: another organization can read stock levels';

  select count(*) into n from public.retail_stock_movements where organization_id = org;
  assert n = 0, 'FAIL: another organization can read the stock ledger';

  -- Even with the variant id in hand, a movement into someone else's branch
  -- is refused twice over: by RLS, and by the tenancy check in the trigger.
  begin
    insert into public.retail_stock_movements
      (organization_id, branch_id, variant_id, quantity_delta, reason)
    values (org_b, branch_b, variant, 5, 'adjustment');
    assert false, 'FAIL: a variant from another organization was stocked';
  exception when insufficient_privilege or check_violation then null;
  end;
  perform auth.as_admin();

  -- ==========================================================================
  -- 6. Permission separation: a storekeeper adjusts stock but cannot sell,
  --    and holds no financial permission at all.
  -- ==========================================================================
  perform auth.login_as(u_owner);
  insert into public.organization_members
    (organization_id, user_id, status, all_branches, joined_at)
  values (org, u_keeper, 'active', true, now()) returning id into member_k;

  select id into role_keeper from public.roles
   where organization_id = org and key = 'storekeeper';
  insert into public.user_roles (member_id, role_id) values (member_k, role_keeper);
  perform auth.as_admin();

  perform auth.login_as(u_keeper);

  -- Allowed: an inventory adjustment.
  insert into public.retail_stock_movements
    (organization_id, branch_id, variant_id, quantity_delta, reason, note)
  values (org, branch, variant, -1, 'damage', 'تالف');

  select quantity into qty from public.retail_stock_levels
   where branch_id = branch and variant_id = variant;
  assert qty = 6, format('FAIL: adjustment not applied, stock is %s', qty);

  -- Refused: a sale, which needs retail.pos.use.
  begin
    insert into public.retail_stock_movements
      (organization_id, branch_id, variant_id, quantity_delta, reason)
    values (org, branch, variant, -1, 'sale');
    assert false, 'FAIL: storekeeper recorded a sale without retail.pos.use';
  exception when insufficient_privilege then null;
  end;

  -- Refused: anything financial.
  select count(*) into n from public.invoices where organization_id = org;
  assert n = 0, 'FAIL: storekeeper can read invoices';

  select count(*) into n from public.treasury_accounts where organization_id = org;
  assert n = 0, 'FAIL: storekeeper can read the treasury';

  perform auth.as_admin();

  raise notice 'RETAIL INVENTORY: all assertions passed';
end $$;
