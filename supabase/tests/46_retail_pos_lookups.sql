-- =============================================================================
-- LOCAL BASIC — retail POS lookups (0114): customer by phone with store credit
-- and loyalty points; receipt by number with returnable quantities and the
-- refund value retail_process_return will pay
-- =============================================================================
\set ON_ERROR_STOP on

do $$
declare
  u_owner uuid; u_cash uuid; u_other uuid;
  org uuid; br uuid; org_b uuid; br_b uuid; m uuid;
  p1 uuid; v1 uuid; cust uuid; r record; j jsonb; refused boolean;
begin
  insert into auth.users (email) values ('r46-owner@test.local') returning id into u_owner;
  insert into auth.users (email) values ('r46-cash@test.local')  returning id into u_cash;
  insert into auth.users (email) values ('r46-other@test.local') returning id into u_other;
  perform auth.login_as(u_owner);
  select out_organization_id, out_branch_id into org, br from public.provision_workspace('R46 Shop', 'r46shop', 'retail');
  perform auth.login_as(u_other);
  select out_organization_id, out_branch_id into org_b, br_b from public.provision_workspace('R46 Other', 'r46other', 'retail');

  perform auth.as_admin();
  insert into public.organization_members (organization_id, user_id, status, all_branches, joined_at)
  values (org, u_cash, 'active', true, now()) returning id into m;
  insert into public.user_roles (member_id, role_id) select m, id from public.roles where organization_id = org and key = 'cashier';
  insert into public.retail_products (organization_id, name) values (org, 'شاحن') returning id into p1;
  insert into public.retail_variants (organization_id, product_id, sku, price_cents) values (org, p1, 'CH', 5000) returning id into v1;
  insert into public.retail_stock_movements (organization_id, branch_id, variant_id, quantity_delta, reason, ref_type)
  values (org, br, v1, 20, 'initial', 'manual');
  insert into public.customers (organization_id, name, phone) values (org, 'نادر', '01012345678') returning id into cust;
  insert into public.restaurant_loyalty_settings (organization_id, enabled, cents_per_point) values (org, true, 1000);
  insert into public.retail_store_credits (organization_id, customer_id, kind, delta_cents, ref_type) values (org, cust, 'issue', 2500, 'manual');

  -- ---- customer lookup -------------------------------------------------------------
  perform auth.login_as(u_cash);
  select * into r from public.retail_customer_lookup(org, '+20 101 234 5678');
  assert r.customer_id = cust and r.store_credit_cents = 2500 and r.loyalty_enabled and r.loyalty_points = 0,
         'customer found by normalised phone with credit';
  assert not exists (select 1 from public.retail_customer_lookup(org, '123')), 'a short number finds nothing';

  select * into r from public.retail_checkout(org, br,
    jsonb_build_array(jsonb_build_object('variant_id', v1, 'quantity', 3)), 'cash', 15000, cust);
  select * into r from public.retail_customer_lookup(org, '01012345678');
  assert r.loyalty_points = 15, 'points from the sale show up, got ' || r.loyalty_points;

  perform auth.login_as(u_other);
  refused := false;
  begin perform public.retail_customer_lookup(org, '01012345678'); exception when insufficient_privilege then refused := true; end;
  assert refused, 'another org cannot look up customers';

  -- ---- receipt lookup ---------------------------------------------------------------
  perform auth.login_as(u_owner);
  select out_invoice_number into r from public.retail_checkout(org, br,
    jsonb_build_array(jsonb_build_object('variant_id', v1, 'quantity', 2)), 'cash', 10000);
  perform public.retail_process_return(org, br,
    (select id from public.invoices where number = r.out_invoice_number and organization_id = org),
    jsonb_build_array(jsonb_build_object('variant_id', v1, 'quantity', 1)), 'cash');

  perform auth.login_as(u_cash);
  j := public.retail_receipt_lookup(org, br, lower(r.out_invoice_number));
  assert j ->> 'number' = r.out_invoice_number, 'found case-insensitively';
  assert (j -> 'lines' -> 0 ->> 'quantity')::numeric = 2 and (j -> 'lines' -> 0 ->> 'returned')::numeric = 1,
         'sold and already-returned quantities';
  assert (j -> 'lines' -> 0 ->> 'unit_refund_cents')::bigint = 5000, 'refund value per unit';
  assert public.retail_receipt_lookup(org, br, 'INV-NOPE') is null, 'unknown receipt';

  perform auth.as_admin();
  delete from public.role_permissions rp using public.roles ro
   where rp.role_id = ro.id and ro.organization_id = org and ro.key = 'cashier' and rp.permission_key = 'retail.return.manage';
  perform auth.login_as(u_cash);
  refused := false;
  begin perform public.retail_receipt_lookup(org, br, r.out_invoice_number); exception when insufficient_privilege then refused := true; end;
  assert refused, 'receipt lookup needs retail.return.manage';

  raise notice 'RETAIL POS LOOKUPS: all assertions passed';
end $$;
