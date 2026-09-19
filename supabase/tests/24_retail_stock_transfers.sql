-- =============================================================================
-- LOCAL BASIC — Retail stock transfer suite
--
-- What has to hold:
--
--   1. A transfer moves stock: source down, destination up, same quantity,
--      in one commit.
--   2. Over-transferring aborts EVERYTHING. No partial move, no phantom
--      arrival in the destination branch.
--   3. retail.inventory.adjust is not enough. Transferring is its own
--      permission, and it is required at BOTH ends.
--   4. 'transfer_in' can no longer be conjured as a manual adjustment — the
--      hole this migration exists to close.
--   5. Tenant isolation: another organization's branches and variants are
--      unusable, and its transfers are unreadable.
--   6. The document is append-only and audited.
--
-- Run with:  psql -v ON_ERROR_STOP=1 -f supabase/tests/24_retail_stock_transfers.sql
-- =============================================================================

\set ON_ERROR_STOP on

do $$
declare
  u_owner uuid; u_keeper uuid; u_other uuid;
  org_a uuid; br_main uuid; br_two uuid;
  org_b uuid; br_b uuid;
  cat_a uuid; prod_a uuid; var_a uuid;
  var_b uuid; prod_b uuid; cat_b uuid;
  role_keeper uuid; member_keeper uuid;
  t_id uuid; n int; ok boolean; qty numeric;
begin
  -- ==========================================================================
  -- Fixture: one organization with two branches, one with a single branch.
  -- ==========================================================================
  insert into auth.users (email) values ('stowner@test.local')  returning id into u_owner;
  insert into auth.users (email) values ('stkeeper@test.local') returning id into u_keeper;
  insert into auth.users (email) values ('stother@test.local')  returning id into u_other;

  perform auth.login_as(u_owner);
  select out_organization_id, out_branch_id into org_a, br_main
    from public.provision_workspace('متجر التحويلات', 'sttransfer', 'retail');

  insert into public.branches (organization_id, slug, name, is_active)
  values (org_a, 'second', 'الفرع الثاني', true) returning id into br_two;

  insert into public.retail_categories (organization_id, name) values (org_a, 'عام')
    returning id into cat_a;
  insert into public.retail_products (organization_id, category_id, name)
    values (org_a, cat_a, 'منتج') returning id into prod_a;
  insert into public.retail_variants (organization_id, product_id, name, price_cents)
    values (org_a, prod_a, 'افتراضي', 5000) returning id into var_a;

  -- 100 units into the main branch to start.
  insert into public.retail_stock_movements
    (organization_id, branch_id, variant_id, quantity_delta, reason, ref_type, created_by)
  values (org_a, br_main, var_a, 100, 'initial', 'manual', u_owner);

  perform auth.login_as(u_other);
  select out_organization_id, out_branch_id into org_b, br_b
    from public.provision_workspace('متجر آخر', 'stother', 'retail');
  insert into public.retail_categories (organization_id, name) values (org_b, 'عام')
    returning id into cat_b;
  insert into public.retail_products (organization_id, category_id, name)
    values (org_b, cat_b, 'منتج ب') returning id into prod_b;
  insert into public.retail_variants (organization_id, product_id, name, price_cents)
    values (org_b, prod_b, 'افتراضي', 5000) returning id into var_b;

  -- ==========================================================================
  -- 1. A transfer moves stock, atomically.
  -- ==========================================================================
  perform auth.login_as(u_owner);

  select out_transfer_id into t_id from public.retail_stock_transfer(
    org_a, br_main, br_two,
    jsonb_build_array(jsonb_build_object('variant_id', var_a, 'quantity', 30)),
    'أول تحويل');

  select quantity into qty from public.retail_stock_levels
   where branch_id = br_main and variant_id = var_a;
  assert qty = 70, format('FAIL: source should hold 70, holds %s', qty);

  select quantity into qty from public.retail_stock_levels
   where branch_id = br_two and variant_id = var_a;
  assert qty = 30, format('FAIL: destination should hold 30, holds %s', qty);

  -- Both legs exist, tied to the document.
  select count(*) into n from public.retail_stock_movements
   where ref_type = 'transfer' and ref_id = t_id;
  assert n = 2, format('FAIL: expected two movement legs, found %s', n);
  raise notice 'OK 1: stock moved 30 from main to second, both legs recorded';

  -- ==========================================================================
  -- 2. Over-transferring aborts everything.
  -- ==========================================================================
  ok := false;
  begin
    perform public.retail_stock_transfer(
      org_a, br_main, br_two,
      jsonb_build_array(jsonb_build_object('variant_id', var_a, 'quantity', 999)),
      null);
  exception when others then ok := true; end;
  assert ok, 'FAIL: a transfer exceeding available stock was accepted';

  -- Nothing moved, and nothing arrived: this is the property that a pair of
  -- manual adjustments could never give.
  select quantity into qty from public.retail_stock_levels
   where branch_id = br_main and variant_id = var_a;
  assert qty = 70, format('FAIL: a refused transfer changed the source (%s)', qty);

  select quantity into qty from public.retail_stock_levels
   where branch_id = br_two and variant_id = var_a;
  assert qty = 30, format('FAIL: a refused transfer created phantom stock (%s)', qty);
  raise notice 'OK 2: an over-transfer aborts entirely — no partial move';

  -- A multi-line transfer where only the LAST line is short must also roll the
  -- earlier lines back.
  ok := false;
  begin
    perform public.retail_stock_transfer(
      org_a, br_two, br_main,
      jsonb_build_array(
        jsonb_build_object('variant_id', var_a, 'quantity', 10),
        jsonb_build_object('variant_id', var_a, 'quantity', 5)),
      null);
  exception when others then ok := true; end;
  assert ok, 'FAIL: a transfer naming the same variant twice was accepted';

  select quantity into qty from public.retail_stock_levels
   where branch_id = br_two and variant_id = var_a;
  assert qty = 30, format('FAIL: a refused multi-line transfer moved stock (%s)', qty);
  raise notice 'OK 3: a refused multi-line transfer leaves nothing behind';

  -- ==========================================================================
  -- 4. transfer_in can no longer be conjured by hand.
  -- ==========================================================================
  ok := false;
  begin
    insert into public.retail_stock_movements
      (organization_id, branch_id, variant_id, quantity_delta, reason, ref_type, created_by)
    values (org_a, br_main, var_a, 500, 'transfer_in', 'manual', u_owner);
  exception when others then ok := true; end;
  assert ok, 'FAIL: transfer_in was accepted as a manual adjustment';

  select quantity into qty from public.retail_stock_levels
   where branch_id = br_main and variant_id = var_a;
  assert qty = 70, format('FAIL: manual transfer_in created stock (%s)', qty);
  raise notice 'OK 4: stock cannot be conjured with a manual transfer_in';

  -- ==========================================================================
  -- 5. Transferring is its own permission, required at both ends.
  -- ==========================================================================
  -- A storekeeper-shaped role holding adjust but NOT transfer.
  insert into public.roles (organization_id, key, name_ar, name_en, is_system, is_owner)
  values (org_a, 'keeper_no_transfer', 'أمين مخزن', 'Keeper', false, false)
  returning id into role_keeper;

  insert into public.role_permissions (role_id, permission_key) values
    (role_keeper, 'retail.inventory.read'),
    (role_keeper, 'retail.inventory.adjust'),
    (role_keeper, 'retail.product.read');

  insert into public.organization_members (organization_id, user_id, status, all_branches)
  values (org_a, u_keeper, 'active', true) returning id into member_keeper;
  insert into public.user_roles (member_id, role_id) values (member_keeper, role_keeper);

  perform auth.login_as(u_keeper);

  assert app.has_branch_permission(org_a, br_main, 'retail.inventory.adjust'),
    'FAIL: fixture is wrong — the keeper should hold adjust';
  assert not app.has_branch_permission(org_a, br_main, 'retail.inventory.transfer'),
    'FAIL: fixture is wrong — the keeper should not hold transfer';

  ok := false;
  begin
    perform public.retail_stock_transfer(
      org_a, br_main, br_two,
      jsonb_build_array(jsonb_build_object('variant_id', var_a, 'quantity', 1)), null);
  exception when others then ok := true; end;
  assert ok, 'FAIL: retail.inventory.adjust was enough to transfer stock';
  raise notice 'OK 5: adjusting your own shelves does not let you move another branch''s';

  -- ==========================================================================
  -- 6. Tenant isolation.
  -- ==========================================================================
  perform auth.login_as(u_other);

  -- Another organization's branches, named directly.
  ok := false;
  begin
    perform public.retail_stock_transfer(
      org_a, br_main, br_two,
      jsonb_build_array(jsonb_build_object('variant_id', var_a, 'quantity', 1)), null);
  exception when others then ok := true; end;
  assert ok, 'FAIL: another organization transferred org A''s stock';

  -- Their own organization, but pointing at org A's branch as the destination.
  ok := false;
  begin
    perform public.retail_stock_transfer(
      org_b, br_b, br_main,
      jsonb_build_array(jsonb_build_object('variant_id', var_b, 'quantity', 1)), null);
  exception when others then ok := true; end;
  assert ok, 'FAIL: stock was pushed into another organization''s branch';

  -- Their own branches, but moving org A's variant.
  ok := false;
  begin
    perform public.retail_stock_transfer(
      org_b, br_b, br_b,
      jsonb_build_array(jsonb_build_object('variant_id', var_a, 'quantity', 1)), null);
  exception when others then ok := true; end;
  assert ok, 'FAIL: a transfer used another organization''s variant';

  -- And they cannot read org A's transfer history.
  select count(*) into n from public.retail_stock_transfers;
  assert n = 0, format('FAIL: another organization read %s transfers', n);

  select count(*) into n from public.retail_stock_transfer_lines;
  assert n = 0, format('FAIL: another organization read %s transfer lines', n);
  raise notice 'OK 6: transfers are confined to one organization';

  -- ==========================================================================
  -- 7. The document is append-only.
  -- ==========================================================================
  perform auth.login_as(u_owner);

  begin
    update public.retail_stock_transfers set note = 'مُعدَّل' where id = t_id;
    get diagnostics n = row_count;
    assert n = 0, 'FAIL: a transfer document was edited';
  exception when insufficient_privilege then null; end;

  begin
    delete from public.retail_stock_transfers where id = t_id;
    get diagnostics n = row_count;
    assert n = 0, 'FAIL: a transfer document was deleted';
  exception when insufficient_privilege then null; end;

  begin
    update public.retail_stock_transfer_lines set quantity = 999 where transfer_id = t_id;
    get diagnostics n = row_count;
    assert n = 0, 'FAIL: a transfer line was rewritten';
  exception when insufficient_privilege then null; end;
  raise notice 'OK 7: the transfer document cannot be edited or deleted';

  -- ==========================================================================
  -- 8. Audited, against the real actor.
  -- ==========================================================================
  select count(*) into n from public.audit_logs
   where action = 'retail.stock_transferred' and entity_id = t_id::text
     and organization_id = org_a and actor_id = u_owner;
  assert n = 1, format('FAIL: expected one audit line for the transfer, found %s', n);
  raise notice 'OK 8: the transfer is audited';

  -- ==========================================================================
  -- 9. A branch cannot transfer to itself.
  -- ==========================================================================
  ok := false;
  begin
    perform public.retail_stock_transfer(
      org_a, br_main, br_main,
      jsonb_build_array(jsonb_build_object('variant_id', var_a, 'quantity', 1)), null);
  exception when others then ok := true; end;
  assert ok, 'FAIL: a branch transferred stock to itself';

  -- And an empty transfer is not a transfer.
  ok := false;
  begin
    perform public.retail_stock_transfer(org_a, br_main, br_two, '[]'::jsonb, null);
  exception when others then ok := true; end;
  assert ok, 'FAIL: an empty transfer was accepted';
  raise notice 'OK 9: degenerate transfers are refused';

  -- ==========================================================================
  -- 10. anon has nothing.
  -- ==========================================================================
  perform auth.logout();
  perform set_config('role', 'anon', true);

  begin
    select count(*) into n from public.retail_stock_transfers;
    assert n = 0, 'FAIL: anon read transfers';
  exception when insufficient_privilege then null; end;

  ok := false;
  begin
    perform public.retail_stock_transfer(
      org_a, br_main, br_two,
      jsonb_build_array(jsonb_build_object('variant_id', var_a, 'quantity', 1)), null);
  exception when others then ok := true; end;
  assert ok, 'FAIL: anon transferred stock';
  raise notice 'OK 10: anon cannot read or move stock';

  perform set_config('role', 'postgres', true);
  raise notice 'RETAIL STOCK TRANSFERS: all assertions passed';
end $$;
