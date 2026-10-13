-- =============================================================================
-- LOCAL BASIC — menu stock tracking and prep notes (0094)
-- =============================================================================
\set ON_ERROR_STOP on

do $$
declare
  u uuid; org uuid; br uuid; br2 uuid;
  prod uuid; var uuid; ord uuid; ord2 uuid; qty int; avail boolean; n int;
begin
  insert into auth.users (email) values ('i29@test.local') returning id into u;
  perform auth.login_as(u);
  select out_organization_id, out_branch_id into org, br
    from public.provision_workspace('I29', 'i29shop', 'restaurant');
  perform auth.as_admin();
  insert into public.branches (organization_id, slug, name) values (org, 'second', 'ثاني') returning id into br2;
  insert into public.restaurant_products (organization_id, name, prep_notes)
  values (org, 'لاتيه', '18g بن') returning id into prod;
  insert into public.restaurant_variants (organization_id, product_id, name, price_cents)
  values (org, prod, 'default', 5000) returning id into var;

  -- Staff turns tracking on with 2 in stock at the first branch.
  perform auth.login_as(u);
  perform public.restaurant_set_stock(org, br, prod, true, 2);
  perform auth.as_admin();
  assert (select quantity from public.restaurant_branch_stock where branch_id = br and product_id = prod) = 2, 'stock set';
  assert not exists (select 1 from public.restaurant_branch_stock where branch_id = br2), 'other branch untouched';

  -- Ordering more than is in stock is refused; exactly the stock is allowed.
  insert into public.restaurant_orders (organization_id, branch_id, number, currency, channel, type, status)
  values (org, br, 'I-1', 'EGP', 'online', 'pickup', 'new') returning id into ord;
  begin
    insert into public.restaurant_order_items (order_id, organization_id, variant_id, product_name, quantity, unit_price_cents, line_total_cents)
    values (ord, org, var, 'لاتيه', 3, 5000, 15000);
    assert false, 'over-stock line must be refused';
  exception when check_violation then null; end;
  insert into public.restaurant_order_items (order_id, organization_id, variant_id, product_name, quantity, unit_price_cents, line_total_cents)
  values (ord, org, var, 'لاتيه', 2, 5000, 10000);
  -- a second line for the same product in the same order counts the first
  begin
    insert into public.restaurant_order_items (order_id, organization_id, variant_id, product_name, quantity, unit_price_cents, line_total_cents)
    values (ord, org, var, 'لاتيه', 1, 5000, 5000);
    assert false, 'lines of one order share the stock';
  exception when check_violation then null; end;

  -- Placing does not take stock; confirming does, and sells the item out.
  assert (select quantity from public.restaurant_branch_stock where branch_id = br and product_id = prod) = 2, 'no decrement before confirm';
  update public.restaurant_orders set status = 'confirmed' where id = ord;
  assert (select quantity from public.restaurant_branch_stock where branch_id = br and product_id = prod) = 0, 'confirm takes stock';
  select is_available into avail from public.restaurant_branch_availability where branch_id = br and variant_id = var;
  assert avail = false, 'zero stock closes the variant at that branch';

  -- A sold-out item cannot be ordered at all.
  insert into public.restaurant_orders (organization_id, branch_id, number, currency, channel, type, status)
  values (org, br, 'I-2', 'EGP', 'online', 'pickup', 'new') returning id into ord2;
  begin
    insert into public.restaurant_order_items (order_id, organization_id, variant_id, product_name, quantity, unit_price_cents, line_total_cents)
    values (ord2, org, var, 'لاتيه', 1, 5000, 5000);
    assert false, 'sold-out item must not be orderable';
  exception when check_violation then null; end;

  -- Cancelling a confirmed order puts the stock back and reopens the item.
  update public.restaurant_orders set status = 'cancelled', cancel_reason = 'test' where id = ord;
  assert (select quantity from public.restaurant_branch_stock where branch_id = br and product_id = prod) = 2, 'cancel restores stock';
  select is_available into avail from public.restaurant_branch_availability where branch_id = br and variant_id = var;
  assert avail = true, 'restock reopens the variant';

  -- A manual 86 is not lifted by stock changes.
  update public.restaurant_branch_availability set is_available = false, unavailable_note = 'manual' where branch_id = br and variant_id = var;
  perform auth.login_as(u);
  perform public.restaurant_set_stock(org, br, prod, true, 5);
  perform auth.as_admin();
  select is_available into avail from public.restaurant_branch_availability where branch_id = br and variant_id = var;
  assert avail = false, 'a manual 86 survives a restock';

  -- Untracked products are never limited.
  perform auth.login_as(u);
  perform public.restaurant_set_stock(org, br, prod, false, 0);
  perform auth.as_admin();
  assert (select track_inventory from public.restaurant_products where id = prod) = false, 'tracking off';

  -- Guests cannot reach stock or notes.
  perform auth.logout();
  begin
    perform 1 from public.restaurant_branch_stock limit 1;
    assert false, 'anon reads stock';
  exception when insufficient_privilege then null; end;
  begin
    perform public.restaurant_set_stock(org, br, prod, true, 99);
    assert false, 'anon sets stock';
  exception when others then null; end;
  perform auth.as_admin();
  raise notice 'I29: stock guard, decrement on confirm, restore on cancel, sold-out sync';
end $$;
