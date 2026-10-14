-- =============================================================================
-- LOCAL BASIC — security invariants, negative access tests and abuse limits (0100)
--
-- Part 1 freezes the attack surface: a new table without forced RLS, a new
-- function anon can call, an internal app.* function anon can call, or a
-- SECURITY DEFINER function without a pinned search_path fails this file
-- until someone adds it on purpose.
-- =============================================================================
\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- Part 1: invariants
-- ---------------------------------------------------------------------------
do $$
declare
  bad text;
  allowed text[] := array[
    'customer_claim_reward(text,text,text)',
    'customer_claim_reward_by_token(text,text,text)',
    'customer_profile(text,text,text)',
    'customer_profile_by_token(text,text,text)',
    'invitation_preview(text)',
    'loyalty_public_info(text)',
    'loyalty_public_info_by_token(text)',
    'resolve_public_link(text)',
    'restaurant_domain_resolve(text)',
    'restaurant_online_cancel_order(text,text)',
    'restaurant_online_edit_order(text,jsonb)',
    'restaurant_online_menu(text,text)',
    'restaurant_online_modifiers(text,text)',
    'restaurant_online_order_items(text)',
    'restaurant_online_order_status(text)',
    'restaurant_online_storefront(text,text)',
    'restaurant_order_verification_info(text)',
    'restaurant_payment_options(text)',
    'restaurant_payment_options_by_token(text)',
    'restaurant_place_online_order(text,text,jsonb,text,text,text,text,jsonb,text,uuid,text,numeric,numeric)',
    'restaurant_place_public_order(text,jsonb,text,text,text,text,numeric,numeric)',
    'restaurant_price_online_cart(text,text,jsonb,text)',
    'restaurant_public_context(text)',
    'restaurant_public_menu(text)',
    'restaurant_public_order_status(text,text)',
    'restaurant_status_theme(text)',
    'restaurant_website(text)',
    'restaurant_website_best_sellers(text,integer)',
    'restaurant_website_branches(text)',
    'restaurant_website_bundles(text,integer)',
    'restaurant_website_layout(text)',
    'restaurant_website_menu(text,text)',
    'retail_order_lines(text)',
    'retail_order_status(text)',
    'retail_place_order(text,text,jsonb,text,text,text,text,text,text,text,text,text,text,text,text)',
    'retail_price_cart(text,text,jsonb,text)',
    'retail_store_catalog(text,text,text)',
    'retail_store_context(text,text)',
    'submit_public_lead(text,text,text,text)'
  ];
begin
  -- Every public table: RLS enabled AND forced (owners do not bypass it).
  select string_agg(c.relname, ', ') into bad
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
     and not (c.relrowsecurity and c.relforcerowsecurity);
  assert bad is null, format('tables without forced RLS: %s', bad);

  -- anon reads no table directly except the public price list.
  select string_agg(table_name || ':' || privilege_type, ', ') into bad
    from information_schema.role_table_grants
   where grantee = 'anon' and table_schema in ('public', 'app')
     and not (table_name = 'plans' and privilege_type = 'SELECT');
  assert bad is null, format('unexpected anon table privileges: %s', bad);

  -- The anonymous entry points are exactly the allowlist above.
  select string_agg(p.oid::regprocedure::text, ', ') into bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    left join pg_depend d on d.objid = p.oid and d.deptype = 'e'
   where n.nspname = 'public' and d.objid is null
     and has_function_privilege('anon', p.oid, 'execute')
     and p.oid::regprocedure::text <> all (allowed);
  assert bad is null, format('functions anon can call that are not on the allowlist: %s', bad);

  -- Every anonymous entry point is SECURITY DEFINER (so it owns its checks)
  -- or touches nothing; none is an invoker function acting with anon's rights.
  select string_agg(p.oid::regprocedure::text, ', ') into bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.oid::regprocedure::text = any (allowed) and not p.prosecdef;
  assert bad is null, format('anonymous entry points that are not SECURITY DEFINER: %s', bad);

  -- No internal helper is callable anonymously.
  select string_agg(p.oid::regprocedure::text, ', ') into bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app' and has_function_privilege('anon', p.oid, 'execute');
  assert bad is null, format('app.* functions anon can call: %s', bad);

  -- Every SECURITY DEFINER function pins search_path (no schema hijacking).
  select string_agg(n.nspname || '.' || p.proname, ', ') into bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'app') and p.prosecdef
     and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%');
  assert bad is null, format('SECURITY DEFINER functions without search_path: %s', bad);

  -- Service-role-only functions stay that way.
  assert not has_function_privilege('anon', 'public.restaurant_whatsapp_verify_webhook(text,text,text)', 'execute'), 'webhook fn: anon';
  assert not has_function_privilege('authenticated', 'public.restaurant_whatsapp_verify_webhook(text,text,text)', 'execute'), 'webhook fn: authenticated';
  assert not has_function_privilege('authenticated', 'app.rate_limit(text,text,int,int)', 'execute'), 'limiter is internal';

  raise notice 'security invariants OK';
end $$;

-- ---------------------------------------------------------------------------
-- Part 2: unauthenticated and cross-tenant requests are refused
-- ---------------------------------------------------------------------------
do $$
declare
  u_a uuid; org_a uuid; br_a uuid; u_x uuid;
  t text; refused boolean;
begin
  insert into auth.users (email) values ('s33a@test.local') returning id into u_a;
  insert into auth.users (email) values ('s33x@test.local') returning id into u_x;
  perform auth.login_as(u_a);
  select out_organization_id, out_branch_id into org_a, br_a from public.provision_workspace('S33 Alpha', 's33alpha', 'restaurant');
  perform auth.as_admin();

  -- anon cannot read any sensitive table directly.
  perform auth.logout();
  foreach t in array array[
    'public.restaurant_orders', 'public.customers', 'public.restaurant_guest_devices',
    'public.audit_logs', 'public.restaurant_loyalty_coupons', 'public.restaurant_loyalty_settings',
    'public.restaurant_payment_settings', 'public.profiles', 'public.invitations',
    'public.organization_members', 'app.rate_limit_hits'
  ] loop
    refused := false;
    begin
      execute format('select 1 from %s limit 1', t);
    exception when insufficient_privilege then refused := true; end;
    assert refused, format('anon must not read %s', t);
  end loop;

  -- anon cannot write either.
  refused := false;
  begin
    insert into public.restaurant_orders (organization_id, branch_id, number, currency, channel, type, status)
    values (org_a, br_a, 'X-1', 'EGP', 'online', 'pickup', 'new');
  exception when insufficient_privilege then refused := true; end;
  assert refused, 'anon must not insert orders directly';

  -- anon cannot call any dashboard function.
  foreach t in array array[
    format('select * from public.restaurant_customer_directory(%L)', org_a),
    format('select * from public.restaurant_customer_reset(%L, %L)', org_a, '01012345678'),
    format('select * from public.restaurant_menu_reset(%L)', org_a),
    format('select * from public.restaurant_payment_settings_get(%L)', org_a),
    format('select * from public.restaurant_loyalty_settings_get(%L)', org_a),
    format('select public.restaurant_coupon_redeem(%L, gen_random_uuid(), %L)', org_a, 'LB-XXXXXX'),
    format('select * from public.restaurant_whatsapp_verify_webhook(%L, %L, %L)', 'MAIN', '1234', '01012345678'),
    'select app.write_audit(null, null, ''x'', ''x'', ''x'', null, null, null, null)',
    'select app.next_document_number(null, null, ''x'')'
  ] loop
    refused := false;
    begin
      execute t;
    exception when insufficient_privilege then refused := true;
              when sqlstate '28000' then refused := true; end;
    assert refused, format('anon must be refused: %s', t);
  end loop;

  -- A signed-in user of ANOTHER workspace is refused on every tenant function.
  perform auth.login_as(u_x);
  foreach t in array array[
    format('select * from public.restaurant_customer_directory(%L)', org_a),
    format('select * from public.restaurant_customer_reset(%L, %L)', org_a, '01012345678'),
    format('select * from public.restaurant_menu_reset(%L)', org_a),
    format('select public.restaurant_category_delete(%L, gen_random_uuid())', org_a),
    format('select * from public.restaurant_payment_settings_get(%L)', org_a),
    format('select * from public.restaurant_loyalty_settings_get(%L)', org_a),
    format('select public.restaurant_loyalty_settings_save(%L, true, 1000, 100, 2000, 90)', org_a)
  ] loop
    refused := false;
    begin
      execute t;
    exception when insufficient_privilege then refused := true; end;
    assert refused, format('outsider must be refused: %s', t);
  end loop;

  -- ... and sees none of the workspace's rows through RLS.
  assert (select count(*) from public.restaurant_orders where organization_id = org_a) = 0, 'outsider sees no orders';
  assert (select count(*) from public.customers where organization_id = org_a) = 0, 'outsider sees no customers';
  assert (select count(*) from public.audit_logs where organization_id = org_a) = 0, 'outsider sees no audit log';

  perform auth.as_admin();
  raise notice 'negative access tests OK';
end $$;

-- ---------------------------------------------------------------------------
-- Part 3: abuse limits
-- ---------------------------------------------------------------------------
do $$
declare
  u_a uuid; org_a uuid; br_a uuid; i int; refused boolean; n int;
begin
  insert into auth.users (email) values ('s33r@test.local') returning id into u_a;
  perform auth.login_as(u_a);
  select out_organization_id, out_branch_id into org_a, br_a from public.provision_workspace('S33 Rate', 's33rate', 'restaurant');
  perform auth.as_admin();

  -- The limiter itself: limit 3, the 4th is refused, another key is not.
  for i in 1..3 loop perform app.rate_limit('rl_test', 'k1', 3, 600); end loop;
  refused := false;
  begin perform app.rate_limit('rl_test', 'k1', 3, 600);
  exception when sqlstate 'LB429' then refused := true; end;
  assert refused, '4th hit over a limit of 3 must be refused';
  perform app.rate_limit('rl_test', 'k2', 3, 600);
  -- Keys are stored hashed, never in clear.
  assert not exists (select 1 from app.rate_limit_hits where key_hash like '%k1%'), 'keys are hashed';

  -- Guest orders: 8 per phone per 10 minutes, across spellings of the number.
  for i in 1..8 loop
    insert into public.restaurant_orders (organization_id, branch_id, number, currency, channel, type, status, guest_phone)
    values (org_a, br_a, 'R-' || i, 'EGP', 'online', 'pickup', 'new',
            case when i % 2 = 0 then '+20 100 111 2222' else '01001112222' end);
  end loop;
  refused := false;
  begin
    insert into public.restaurant_orders (organization_id, branch_id, number, currency, channel, type, status, guest_phone)
    values (org_a, br_a, 'R-9', 'EGP', 'qr', 'dine_in', 'new', '201001112222');
  exception when sqlstate 'LB429' then refused := true; end;
  assert refused, '9th guest order for one phone must be refused';

  -- Staff channels are never limited.
  for i in 1..12 loop
    insert into public.restaurant_orders (organization_id, branch_id, number, currency, channel, type, status, guest_phone)
    values (org_a, br_a, 'C-' || i, 'EGP', 'cashier', 'takeaway', 'new', '01001112222');
  end loop;

  -- At most 3 orders held for verification per phone.
  for i in 1..3 loop
    insert into public.restaurant_orders (organization_id, branch_id, number, currency, channel, type, status, guest_phone)
    values (org_a, br_a, 'P-' || i, 'EGP', 'online', 'pickup', 'pending_verification', '01233334444');
  end loop;
  refused := false;
  begin
    insert into public.restaurant_orders (organization_id, branch_id, number, currency, channel, type, status, guest_phone)
    values (org_a, br_a, 'P-4', 'EGP', 'online', 'pickup', 'pending_verification', '01233334444');
  exception when sqlstate 'LB429' then refused := true; end;
  assert refused, '4th pending-verification order for one phone must be refused';

  -- Per device, whatever phone it claims.
  for i in 1..12 loop
    insert into public.restaurant_orders (organization_id, branch_id, number, currency, channel, type, status, guest_phone, device_id)
    values (org_a, br_a, 'D-' || i, 'EGP', 'online', 'pickup', 'new', '0155000' || lpad(i::text, 4, '0'), 'device-flood-0001');
  end loop;
  refused := false;
  begin
    insert into public.restaurant_orders (organization_id, branch_id, number, currency, channel, type, status, guest_phone, device_id)
    values (org_a, br_a, 'D-13', 'EGP', 'online', 'pickup', 'new', '01559999999', 'device-flood-0001');
  exception when sqlstate 'LB429' then refused := true; end;
  assert refused, '13th order from one device must be refused';

  -- Anonymous profile lookups: 300 per phone per 10 minutes, then refused.
  perform auth.logout();
  for i in 1..300 loop
    perform public.customer_profile('s33rate', 'device-probe-' || i, '01077778888');
  end loop;
  refused := false;
  begin perform public.customer_profile('s33rate', 'device-probe-x', '01077778888');
  exception when sqlstate 'LB429' then refused := true; end;
  assert refused, 'profile lookups for one phone must be capped';
  -- An unknown store returns the plain "not verified" answer and costs nothing.
  assert (public.customer_profile('no-such-store', 'device-probe-1', '01077778888') ->> 'verified') = 'false', 'unknown store';

  -- Anonymous marketing leads: 3 per phone per day.
  for i in 1..3 loop
    perform public.submit_public_lead('Lead ' || i, '01099990000', null, 'restaurant');
  end loop;
  refused := false;
  begin perform public.submit_public_lead('Lead 4', '01099990000', null, 'restaurant');
  exception when sqlstate 'LB429' then refused := true; end;
  assert refused, '4th lead from one phone must be refused';

  -- A guest's reward claim is written to the audit log (last four digits only).
  perform auth.as_admin();
  insert into public.restaurant_loyalty_coupons (organization_id, phone_key, code, points_cost, value_cents, expires_at)
  values (org_a, '012345678', 'LB-S33AAA', 100, 2000, now() + interval '30 days');
  select count(*) into n from public.audit_logs
   where organization_id = org_a and action = 'restaurant.loyalty_coupon.claimed'
     and after ->> 'phone_tail' = '5678' and not (after::text like '%012345678%');
  assert n = 1, 'reward claim audited without the full number';

  raise notice 'abuse limits OK';
end $$;
