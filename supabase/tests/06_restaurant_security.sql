-- =============================================================================
-- LOCAL BASIC — Restaurant security and abuse
--
--  * cross-tenant and cross-branch isolation
--  * kitchen and waiter hold no financial access
--  * the order state machine rejects invalid transitions server-side
--  * client-supplied prices, totals and discounts are ignored or refused
--  * duplicate payment is refused
--  * public tokens are scoped, revocable, and expose nothing
-- =============================================================================

\set ON_ERROR_STOP on

do $$
declare
  u_a uuid; u_b uuid; u_kitchen uuid; u_waiter uuid; u_branch1 uuid;
  org_a uuid; branch_a uuid; branch_a2 uuid;
  org_b uuid; branch_b uuid; tbl_b uuid; token_b text;
  tbl_a uuid; token_a text;
  cat uuid; prod uuid; variant uuid; prod2 uuid; variant2 uuid;
  grp_req uuid; mod_req uuid; grp_other uuid; mod_other uuid;
  m uuid; r uuid;
  ord uuid; ord2 uuid; num text; total bigint; inv uuid;
  n int; ok boolean; st text;
begin
  insert into auth.users (email) values ('sec-a@test.local') returning id into u_a;
  insert into auth.users (email) values ('sec-b@test.local') returning id into u_b;
  insert into auth.users (email) values ('sec-kitchen@test.local') returning id into u_kitchen;
  insert into auth.users (email) values ('sec-waiter@test.local') returning id into u_waiter;
  insert into auth.users (email) values ('sec-branch1@test.local') returning id into u_branch1;

  perform auth.login_as(u_a);
  select out_organization_id, out_branch_id into org_a, branch_a
    from public.provision_workspace('مطعم ألف', 'mataam-alef', 'restaurant', 'فرع ١');
  perform auth.as_admin();

  perform auth.login_as(u_b);
  select out_organization_id, out_branch_id into org_b, branch_b
    from public.provision_workspace('مطعم باء', 'mataam-baa', 'restaurant', 'فرع ب');
  perform auth.as_admin();

  -- Menu and staff for org A.
  perform auth.login_as(u_a);
  insert into public.branches (organization_id, slug, name)
  values (org_a, 'second', 'فرع ٢') returning id into branch_a2;

  insert into public.restaurant_categories (organization_id, name)
  values (org_a, 'أطباق') returning id into cat;

  insert into public.restaurant_products (organization_id, category_id, name, tax_rate_bp)
  values (org_a, cat, 'برجر', 0) returning id into prod;
  insert into public.restaurant_variants (organization_id, product_id, price_cents)
  values (org_a, prod, 10000) returning id into variant;

  -- A product with a REQUIRED choice, to prove min_select is enforced.
  insert into public.restaurant_products (organization_id, category_id, name)
  values (org_a, cat, 'ستيك') returning id into prod2;
  insert into public.restaurant_variants (organization_id, product_id, price_cents)
  values (org_a, prod2, 30000) returning id into variant2;
  insert into public.restaurant_modifier_groups
    (organization_id, product_id, name, min_select, max_select)
  values (org_a, prod2, 'درجة النضج', 1, 1) returning id into grp_req;
  insert into public.restaurant_modifiers (organization_id, group_id, name, price_cents)
  values (org_a, grp_req, 'ميديم', 0) returning id into mod_req;

  -- A modifier belonging to a DIFFERENT product.
  insert into public.restaurant_modifier_groups
    (organization_id, product_id, name, min_select, max_select)
  values (org_a, prod, 'إضافات البرجر', 0, 3) returning id into grp_other;
  insert into public.restaurant_modifiers (organization_id, group_id, name, price_cents)
  values (org_a, grp_other, 'جبنة', 2000) returning id into mod_other;

  select t.id, pl.token into tbl_a, token_a
    from public.restaurant_tables t join public.public_links pl on pl.id = t.public_link_id
   where t.branch_id = branch_a and t.name = '1';
  perform auth.as_admin();

  perform auth.login_as(u_b);
  select t.id, pl.token into tbl_b, token_b
    from public.restaurant_tables t join public.public_links pl on pl.id = t.public_link_id
   where t.branch_id = branch_b and t.name = '1';
  perform auth.as_admin();

  -- ==========================================================================
  -- 1. Cross-tenant isolation
  -- ==========================================================================
  perform auth.login_as(u_a);
  select out_order_id into ord from public.restaurant_create_order(
    org_a, branch_a, ('[{"variant_id":"' || variant || '","quantity":1}]')::jsonb, tbl_a);
  perform auth.as_admin();

  perform auth.login_as(u_b);

  select count(*) into n from public.restaurant_orders where organization_id = org_a;
  assert n = 0, 'FAIL: org B can read org A orders';

  select count(*) into n from public.restaurant_orders where id = ord;
  assert n = 0, 'FAIL: org B can read an org A order by direct id (IDOR)';

  select count(*) into n from public.restaurant_products where organization_id = org_a;
  assert n = 0, 'FAIL: org B can read org A menu';

  select count(*) into n from public.restaurant_tables where organization_id = org_a;
  assert n = 0, 'FAIL: org B can read org A tables';

  select count(*) into n from public.restaurant_order_items where order_id = ord;
  assert n = 0, 'FAIL: org B can read org A order lines';

  -- Acting on another tenant's order is refused.
  begin
    perform public.restaurant_set_order_status(org_b, ord, 'confirmed');
    assert false, 'FAIL: org B advanced an org A order';
  exception when check_violation or insufficient_privilege then null;
  end;

  begin
    perform public.restaurant_pay_order(org_b, ord, 'cash', 100000, 0);
    assert false, 'FAIL: org B paid an org A order';
  exception when check_violation or insufficient_privilege then null;
  end;

  -- Putting an org A menu item onto an org B order is refused.
  begin
    perform public.restaurant_create_order(
      org_b, branch_b, ('[{"variant_id":"' || variant || '","quantity":1}]')::jsonb, tbl_b);
    assert false, 'FAIL: an org A menu item was ordered in org B';
  exception when check_violation or insufficient_privilege then null;
  end;
  perform auth.as_admin();

  -- ==========================================================================
  -- 2. Branch isolation inside one organization
  -- ==========================================================================
  perform auth.login_as(u_a);
  insert into public.organization_members
    (organization_id, user_id, status, all_branches, joined_at)
  values (org_a, u_branch1, 'active', false, now()) returning id into m;
  insert into public.member_branches (member_id, branch_id) values (m, branch_a2);
  select id into r from public.roles where organization_id = org_a and key = 'cashier';
  insert into public.user_roles (member_id, role_id, branch_id) values (m, r, branch_a2);
  perform auth.as_admin();

  perform auth.login_as(u_branch1);
  select count(*) into n from public.restaurant_orders where branch_id = branch_a;
  assert n = 0, 'FAIL: a branch-scoped member can read another branch''s orders';

  select count(*) into n from public.restaurant_tables where branch_id = branch_a;
  assert n = 0, 'FAIL: a branch-scoped member can read another branch''s tables';

  begin
    perform public.restaurant_set_order_status(org_a, ord, 'confirmed');
    assert false, 'FAIL: a branch-scoped member advanced another branch''s order';
  exception when insufficient_privilege or check_violation then null;
  end;
  perform auth.as_admin();

  -- ==========================================================================
  -- 3. Kitchen holds no financial access
  -- ==========================================================================
  perform auth.login_as(u_a);
  insert into public.organization_members
    (organization_id, user_id, status, all_branches, joined_at)
  values (org_a, u_kitchen, 'active', true, now()) returning id into m;
  select id into r from public.roles where organization_id = org_a and key = 'kitchen';
  insert into public.user_roles (member_id, role_id) values (m, r);

  insert into public.organization_members
    (organization_id, user_id, status, all_branches, joined_at)
  values (org_a, u_waiter, 'active', true, now()) returning id into m;
  select id into r from public.roles where organization_id = org_a and key = 'waiter';
  insert into public.user_roles (member_id, role_id) values (m, r);
  perform auth.as_admin();

  perform auth.login_as(u_kitchen);

  select count(*) into n from public.treasury_accounts where organization_id = org_a;
  assert n = 0, 'FAIL: kitchen can read the treasury';

  select count(*) into n from public.treasury_transactions where organization_id = org_a;
  assert n = 0, 'FAIL: kitchen can read the treasury ledger';

  select count(*) into n from public.invoices where organization_id = org_a;
  assert n = 0, 'FAIL: kitchen can read invoices';

  select count(*) into n from public.payments where organization_id = org_a;
  assert n = 0, 'FAIL: kitchen can read payments';

  select count(*) into n from public.audit_logs where organization_id = org_a;
  assert n = 0, 'FAIL: kitchen can read the audit log';

  select count(*) into n from public.organization_members
   where organization_id = org_a and user_id <> u_kitchen;
  assert n = 0, 'FAIL: kitchen can enumerate staff';

  -- Kitchen cannot take money.
  begin
    perform public.restaurant_pay_order(org_a, ord, 'cash', 10000, 0);
    assert false, 'FAIL: kitchen took a payment';
  exception when insufficient_privilege then null;
  end;

  -- Kitchen cannot escalate its own role.
  begin
    insert into public.user_roles (member_id, role_id)
    select om.id, ro.id from public.organization_members om, public.roles ro
    where om.user_id = u_kitchen and om.organization_id = org_a
      and ro.organization_id = org_a and ro.key = 'admin';
    assert false, 'FAIL: kitchen granted itself admin';
  exception when insufficient_privilege or check_violation then null;
  end;
  perform auth.as_admin();

  -- The waiter cannot take money either.
  perform auth.login_as(u_waiter);
  begin
    perform public.restaurant_pay_order(org_a, ord, 'cash', 10000, 0);
    assert false, 'FAIL: waiter took a payment';
  exception when insufficient_privilege then null;
  end;
  select count(*) into n from public.treasury_accounts where organization_id = org_a;
  assert n = 0, 'FAIL: waiter can read the treasury';
  perform auth.as_admin();

  -- ==========================================================================
  -- 4. The order state machine rejects invalid transitions
  -- ==========================================================================
  perform auth.login_as(u_a);

  -- new → ready skips confirmation.
  begin
    perform public.restaurant_set_order_status(org_a, ord, 'ready');
    assert false, 'FAIL: new → ready was allowed';
  exception when check_violation then null;
  end;

  -- new → served skips the whole kitchen.
  begin
    perform public.restaurant_set_order_status(org_a, ord, 'served');
    assert false, 'FAIL: new → served was allowed';
  exception when check_violation then null;
  end;

  -- An unpaid order cannot be completed.
  perform public.restaurant_set_order_status(org_a, ord, 'confirmed');
  perform public.restaurant_set_order_status(org_a, ord, 'ready');
  perform public.restaurant_set_order_status(org_a, ord, 'served');
  begin
    perform public.restaurant_set_order_status(org_a, ord, 'completed');
    assert false, 'FAIL: an unpaid order was completed';
  exception when check_violation then null;
  end;

  -- Going backwards is refused.
  begin
    perform public.restaurant_set_order_status(org_a, ord, 'preparing');
    assert false, 'FAIL: served → preparing was allowed';
  exception when check_violation then null;
  end;

  -- A cancellation needs a reason.
  begin
    perform public.restaurant_set_order_status(org_a, ord, 'cancelled', null);
    assert false, 'FAIL: an order was cancelled without a reason';
  exception when check_violation then null;
  end;

  -- An unknown status is refused outright.
  begin
    perform public.restaurant_set_order_status(org_a, ord, 'refunded');
    assert false, 'FAIL: an unknown status was accepted';
  exception when sqlstate '22023' then null;
  end;

  -- ==========================================================================
  -- 5. Client price, total and discount manipulation
  -- ==========================================================================
  -- The payload carries a price and a tax rate. Both are ignored.
  select out_order_id, out_total_cents into ord2, total
  from public.restaurant_create_order(
    org_a, branch_a,
    ('[{"variant_id":"' || variant ||
      '","quantity":1,"price_cents":1,"unit_price_cents":1,"tax_rate_bp":0,"line_total_cents":1}]')::jsonb);
  assert total = 10000, format('FAIL: client price was trusted, total is %s', total);

  select (unit_price_cents = 10000 and line_total_cents = 10000) into ok
    from public.restaurant_order_items where order_id = ord2;
  assert ok, 'FAIL: the order line was not priced from the database';

  -- Writing a total straight onto the order has no effect: the stored totals
  -- are derived from the lines by trigger, so there is nothing to tamper with.
  update public.restaurant_orders set total_cents = 1, subtotal_cents = 1, tax_cents = 0
   where id = ord2;
  select total_cents into total from public.restaurant_orders where id = ord2;
  assert total = 10000,
    format('FAIL: a tampered order total stuck, order now reads %s', total);

  -- And payment charges from the lines regardless.
  select out_total_cents into total from public.restaurant_pay_order(org_a, ord2, 'cash', 0, 0);
  assert total = 10000,
    format('FAIL: payment trusted a tampered order total, charged %s', total);
  perform auth.as_admin();

  -- A modifier from another product cannot be attached.
  perform auth.login_as(u_a);
  begin
    perform public.restaurant_create_order(
      org_a, branch_a,
      ('[{"variant_id":"' || variant2 || '","quantity":1,"modifier_ids":["' || mod_other || '"]}]')::jsonb);
    assert false, 'FAIL: a modifier from another product was accepted';
  exception when check_violation then null;
  end;

  -- A required choice cannot be skipped.
  begin
    perform public.restaurant_create_order(
      org_a, branch_a, ('[{"variant_id":"' || variant2 || '","quantity":1}]')::jsonb);
    assert false, 'FAIL: a required modifier group was skipped';
  exception when check_violation then null;
  end;

  -- Quantity must be sane.
  begin
    perform public.restaurant_create_order(
      org_a, branch_a, ('[{"variant_id":"' || variant || '","quantity":-5}]')::jsonb);
    assert false, 'FAIL: a negative quantity was accepted';
  exception when check_violation then null;
  end;
  perform auth.as_admin();

  -- ==========================================================================
  -- 6. Discount requires its own permission
  -- ==========================================================================
  perform auth.login_as(u_a);
  select out_order_id into ord2 from public.restaurant_create_order(
    org_a, branch_a, ('[{"variant_id":"' || variant || '","quantity":1}]')::jsonb);
  perform auth.as_admin();

  -- The cashier template does not include restaurant.pos.discount.
  perform auth.login_as(u_branch1);
  perform auth.as_admin();

  perform auth.login_as(u_a);
  -- The owner may discount; a discount bigger than the order is still refused.
  begin
    perform public.restaurant_pay_order(org_a, ord2, 'cash', 0, 999999);
    assert false, 'FAIL: a discount exceeding the order total was accepted';
  exception when check_violation then null;
  end;

  -- ==========================================================================
  -- 7. Duplicate and over-payment
  -- ==========================================================================
  select out_total_cents, out_due_cents into total, n
    from public.restaurant_pay_order(org_a, ord2, 'cash', 4000, 0);
  assert total = 10000 and n = 6000,
    format('FAIL: partial payment wrong: total=%s due=%s', total, n);

  select out_due_cents into n from public.restaurant_pay_order(org_a, ord2, 'cash', 6000, 0);
  assert n = 0, format('FAIL: the balance should be clear, due=%s', n);

  -- Paying again is refused rather than double-charging.
  begin
    perform public.restaurant_pay_order(org_a, ord2, 'cash', 10000, 0);
    assert false, 'FAIL: an already-paid order was charged again';
  exception when check_violation then null;
  end;

  -- A paid order cannot be cancelled: it must be refunded through Core.
  begin
    perform public.restaurant_set_order_status(org_a, ord2, 'cancelled', 'غلط');
    assert false, 'FAIL: a paid order was cancelled';
  exception when check_violation then null;
  end;
  perform auth.as_admin();

  -- ==========================================================================
  -- 8. Public tokens: scoped, revocable, and leak nothing
  -- ==========================================================================
  perform auth.logout();

  -- Anonymous visitors cannot touch the tables directly.
  begin
    select count(*) into n from public.restaurant_orders;
    assert false, 'FAIL: anon can query restaurant orders';
  exception when insufficient_privilege then null;
  end;

  begin
    select count(*) into n from public.restaurant_tables;
    assert false, 'FAIL: anon can query restaurant tables';
  exception when insufficient_privilege then null;
  end;

  begin
    select count(*) into n from public.restaurant_products;
    assert false, 'FAIL: anon can query the menu table directly';
  exception when insufficient_privilege then null;
  end;

  -- Org B's token resolves only to org B.
  select organization_name into st from public.restaurant_public_context(token_b);
  assert st = 'مطعم باء', 'FAIL: a token resolved to the wrong restaurant';

  -- Org B's token cannot order org A's menu items.
  begin
    perform public.restaurant_place_public_order(
      token_b, ('[{"variant_id":"' || variant || '","quantity":1}]')::jsonb);
    assert false, 'FAIL: a guest ordered another restaurant''s menu item';
  exception when check_violation then null;
  end;

  -- An unknown token reveals nothing and orders nothing.
  select count(*) into n from public.restaurant_public_context('not-a-real-token-000000');
  assert n = 0, 'FAIL: an unknown token resolved';
  assert public.restaurant_public_menu('not-a-real-token-000000') = '[]'::jsonb,
    'FAIL: an unknown token returned a menu';
  begin
    perform public.restaurant_place_public_order(
      'not-a-real-token-000000', ('[{"variant_id":"' || variant || '","quantity":1}]')::jsonb);
    assert false, 'FAIL: an unknown token placed an order';
  exception when check_violation then null;
  end;
  perform auth.as_admin();

  -- Revoking a QR stops it immediately.
  perform auth.login_as(u_a);
  update public.public_links set is_active = false, revoked_at = now()
   where token = token_a;
  perform auth.as_admin();

  perform auth.logout();
  select count(*) into n from public.restaurant_public_context(token_a);
  assert n = 0, 'FAIL: a revoked QR token still resolves';
  begin
    perform public.restaurant_place_public_order(
      token_a, ('[{"variant_id":"' || variant || '","quantity":1}]')::jsonb);
    assert false, 'FAIL: a revoked QR token still places orders';
  exception when check_violation then null;
  end;
  perform auth.as_admin();

  raise notice 'RESTAURANT SECURITY: all assertions passed';
end $$;
