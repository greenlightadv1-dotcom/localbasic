-- =============================================================================
-- LOCAL BASIC — Platform Admin completion suite (leads, services, onboarding)
--
-- Covers the surfaces added in Stage C.5:
--   * leads and the service catalog are invisible to tenants and to anon;
--   * public lead capture writes without granting anon any table privilege;
--   * onboarding is atomic — a failure leaves no workspace and no subscription;
--   * a service that is not on sale cannot be provisioned.
--
-- Run with:  psql -v ON_ERROR_STOP=1 -f supabase/tests/09_platform_admin_completion.sql
-- =============================================================================

\set ON_ERROR_STOP on

do $$
declare
  u_admin    uuid;
  u_owner    uuid;
  u_newowner uuid;
  plan_basic uuid;
  lead_id    uuid;
  org        uuid;
  code       text;
  n          int;
  ok         boolean;
  msg        text;
  r          record;
begin
  insert into auth.users (email) values ('c5admin@test.local')    returning id into u_admin;
  insert into auth.users (email) values ('c5owner@test.local')    returning id into u_owner;
  insert into auth.users (email) values ('c5newowner@test.local') returning id into u_newowner;

  select id into plan_basic from public.plans where key = 'basic';
  insert into public.platform_admins (user_id, role) values (u_admin, 'owner');

  -- A tenant workspace so we have a non-admin signed-in user with real data.
  perform auth.login_as(u_owner);
  perform public.provision_workspace('C5 Diner', 'c5diner', 'restaurant');
  perform auth.as_admin();

  -- ==========================================================================
  -- 1. Service catalog reflects what is actually built
  -- ==========================================================================
  perform auth.login_as(u_admin);

  select count(*) into n from public.platform_services where is_built;
  assert n = 1, 'FAIL: more than one service claims to be built, got ' || n;

  select count(*) into n from public.platform_services
   where module_key = 'restaurant' and is_built and is_available;
  assert n = 1, 'FAIL: restaurant is not the built, available service';

  select count(*) into n from public.platform_services where is_available and not is_built;
  assert n = 0, 'FAIL: an unbuilt service is marked available for sale';

  raise notice 'C5: service catalog is honest about what exists';

  -- ==========================================================================
  -- 2. Leads and services are invisible to tenants
  -- ==========================================================================
  insert into public.platform_leads (name, phone, business_name, requested_service, source)
  values ('عميل تجريبي', '01000000000', 'مطعم الاختبار', 'restaurant', 'whatsapp')
  returning id into lead_id;

  perform auth.login_as(u_owner);

  select count(*) into n from public.platform_leads;
  assert n = 0, 'FAIL: tenant owner can read leads';

  select count(*) into n from public.platform_services;
  assert n = 0, 'FAIL: tenant owner can read the service catalog';

  ok := false;
  begin
    insert into public.platform_leads (name, phone) values ('x', '01111111111');
  exception when others then ok := true;
  end;
  assert ok, 'FAIL: tenant owner created a lead';

  ok := false;
  begin
    update public.platform_leads set status = 'won' where id = lead_id;
  exception when others then ok := true;
  end;
  -- An UPDATE blocked by RLS affects zero rows rather than raising, so check
  -- the row is actually untouched either way.
  select status into msg from public.platform_leads where id = lead_id;
  perform auth.as_admin();
  select status into msg from public.platform_leads where id = lead_id;
  assert msg = 'new', 'FAIL: tenant owner changed a lead status to ' || msg;

  ok := false;
  perform auth.login_as(u_owner);
  begin
    update public.platform_services set is_available = false where module_key = 'restaurant';
  exception when others then ok := true;
  end;
  perform auth.as_admin();
  select count(*) into n from public.platform_services
   where module_key = 'restaurant' and is_available;
  assert n = 1, 'FAIL: tenant owner disabled a service';

  raise notice 'C5: leads and services are invisible and immutable to tenants';

  -- ==========================================================================
  -- 3. Nobody may delete a lead — a finished lead is won or lost, not erased
  -- ==========================================================================
  perform auth.login_as(u_admin);
  ok := false;
  begin
    delete from public.platform_leads where id = lead_id;
  exception when insufficient_privilege then ok := true;
             when others then ok := true;
  end;
  assert ok, 'FAIL: a lead was deleted';

  -- But an admin can work it.
  update public.platform_leads set status = 'contacted', notes = 'اتصلنا اليوم'
   where id = lead_id;
  select status into msg from public.platform_leads where id = lead_id;
  assert msg = 'contacted', 'FAIL: admin could not update a lead';

  raise notice 'C5: leads are admin-writable and never deletable';

  -- ==========================================================================
  -- 4. Public lead capture: anon writes through the function, nothing else
  -- ==========================================================================
  perform auth.logout();

  -- No table privilege at all.
  ok := false;
  begin
    perform 1 from public.platform_leads limit 1;
  exception when others then ok := true;
  end;
  assert ok, 'FAIL: anon can read platform_leads';

  ok := false;
  begin
    insert into public.platform_leads (name, phone) values ('anon', '01222222222');
  exception when others then ok := true;
  end;
  assert ok, 'FAIL: anon inserted into platform_leads directly';

  -- The function is the only door, and it works.
  perform public.submit_public_lead('زائر الموقع', '01555555555', 'كافيه الزاوية', 'restaurant');

  perform auth.as_admin();
  select count(*) into n from public.platform_leads
   where phone = '01555555555' and source = 'website' and status = 'new';
  assert n = 1, 'FAIL: public lead was not captured';

  -- Validation and service gating hold.
  perform auth.logout();
  ok := false;
  begin perform public.submit_public_lead('x', '01555555556'); exception when others then ok := true; end;
  assert ok, 'FAIL: a one-character name was accepted';

  ok := false;
  begin perform public.submit_public_lead('اسم صحيح', '123'); exception when others then ok := true; end;
  assert ok, 'FAIL: a too-short phone was accepted';

  ok := false;
  begin
    perform public.submit_public_lead('اسم صحيح', '01555555557', null, 'medical');
  exception when others then ok := true;
  end;
  assert ok, 'FAIL: anon asked about a service that is not on sale';

  raise notice 'C5: public capture writes safely with no anon table privilege';

  -- ==========================================================================
  -- 5. Onboarding is Platform-Admin only
  -- ==========================================================================
  ok := false;
  begin
    perform public.platform_onboard_customer(
      u_newowner, 'Anon Co', 'anonco', 'restaurant', plan_basic, 'month');
  exception when others then ok := true;
  end;
  assert ok, 'FAIL: anonymous caller onboarded a customer';

  perform auth.login_as(u_owner);
  ok := false;
  begin
    perform public.platform_onboard_customer(
      u_owner, 'Tenant Co', 'tenantco', 'restaurant', plan_basic, 'month');
  exception when others then ok := true;
  end;
  assert ok, 'FAIL: tenant owner onboarded a customer';

  ok := false;
  begin
    perform public.platform_find_user_by_email('c5admin@test.local');
  exception when others then ok := true;
  end;
  assert ok, 'FAIL: tenant owner looked a user up by email';

  raise notice 'C5: onboarding and user lookup refuse non-admins';

  -- ==========================================================================
  -- 6. The happy path, in one transaction
  -- ==========================================================================
  perform auth.login_as(u_admin);

  select * into r from public.platform_onboard_customer(
    u_newowner, 'مطعم الأصيل', 'alaseel', 'restaurant', plan_basic, 'year',
    null, 'cash', 'الفرع الرئيسي', lead_id, 'صفقة أولى'
  );

  assert r.out_organization_id is not null, 'FAIL: onboarding returned no organization';
  assert r.out_customer_code ~ '^LB-[0-9]{6}$',
    'FAIL: onboarding returned a malformed customer code: ' || coalesce(r.out_customer_code, '<null>');
  org := r.out_organization_id;

  -- Owner is the named user, not the admin.
  select owner_user_id into msg from public.organizations where id = org;
  assert msg::uuid = u_newowner, 'FAIL: onboarded owner is wrong';

  -- Subscription is on the sold plan and term, priced by the database.
  select plan_id, billing_period, status into r
    from public.subscriptions where organization_id = org;
  assert r.plan_id = plan_basic, 'FAIL: subscription is not on the sold plan';
  assert r.billing_period = 'year', 'FAIL: subscription term is ' || r.billing_period;
  assert r.status = 'active', 'FAIL: subscription status is ' || r.status;

  -- History records the sale at the catalogue price.
  select gross_cents, net_cents, payment_method into r
    from public.subscription_events
   where organization_id = org
   order by id desc limit 1;
  assert r.gross_cents = 49900 * 12, 'FAIL: first sale gross is ' || r.gross_cents;
  assert r.payment_method = 'cash', 'FAIL: payment method not recorded';

  -- The lead was closed and linked.
  select status, organization_id into r from public.platform_leads where id = lead_id;
  assert r.status = 'won', 'FAIL: lead not marked won, got ' || r.status;
  assert r.organization_id = org, 'FAIL: lead not linked to the new workspace';

  -- A Platform Admin sees billing and identity, NOT the customer's operational
  -- data. They sell and support the workspace; they do not read its menu,
  -- tables or orders.
  select count(*) into n from public.restaurant_tables where organization_id = org;
  assert n = 0, 'FAIL: platform admin can read tenant restaurant tables';
  select count(*) into n from public.restaurant_orders where organization_id = org;
  assert n = 0, 'FAIL: platform admin can read tenant orders';

  -- The bootstrap did run — visible to the owner it was provisioned for.
  perform auth.login_as(u_newowner);
  select count(*) into n from public.restaurant_tables where organization_id = org;
  assert n > 0, 'FAIL: restaurant bootstrap did not run';
  perform auth.login_as(u_admin);

  -- Audited.
  select count(*) into n from public.audit_logs
   where organization_id = org and action = 'platform.customer_onboarded';
  assert n = 1, 'FAIL: onboarding not audited';

  raise notice 'C5: onboarding creates workspace, plan, term, lead link and audit';

  -- ==========================================================================
  -- 7. Failure leaves nothing behind
  -- ==========================================================================
  -- A duplicate slug must abort before anything is written.
  select count(*) into n from public.organizations;
  ok := false;
  begin
    perform public.platform_onboard_customer(
      u_newowner, 'مطعم مكرر', 'alaseel', 'restaurant', plan_basic, 'month');
  exception when others then ok := true;
  end;
  assert ok, 'FAIL: a duplicate slug was accepted';

  select count(*) into r from public.organizations;
  assert (select count(*) from public.organizations) = n,
    'FAIL: a failed onboarding left an orphan organization';

  -- An unknown owner must abort, again leaving nothing.
  ok := false;
  begin
    perform public.platform_onboard_customer(
      '00000000-0000-0000-0000-0000000000aa'::uuid,
      'مطعم بلا مالك', 'noowner', 'restaurant', plan_basic, 'month');
  exception when others then ok := true;
  end;
  assert ok, 'FAIL: onboarding accepted an unknown owner';
  select count(*) into n from public.organizations where slug = 'noowner';
  assert n = 0, 'FAIL: orphan organization left behind for an unknown owner';
  select count(*) into n from public.subscriptions s
    join public.organizations o on o.id = s.organization_id where o.slug = 'noowner';
  assert n = 0, 'FAIL: orphan subscription left behind';

  -- A service that is not on sale must be refused.
  ok := false;
  begin
    perform public.platform_onboard_customer(
      u_newowner, 'عيادة', 'clinicco', 'medical', plan_basic, 'month');
  exception when others then ok := true;
  end;
  assert ok, 'FAIL: an unavailable service was provisioned';
  select count(*) into n from public.organizations where slug = 'clinicco';
  assert n = 0, 'FAIL: orphan organization for an unavailable service';

  raise notice 'C5: failed onboarding leaves no workspace and no subscription';

  -- ==========================================================================
  -- 8. Turning a service off blocks new sales, not existing customers
  -- ==========================================================================
  update public.platform_services set is_available = false where module_key = 'restaurant';

  ok := false;
  begin
    perform public.platform_onboard_customer(
      u_newowner, 'مطعم جديد', 'newresto', 'restaurant', plan_basic, 'month');
  exception when others then ok := true;
  end;
  assert ok, 'FAIL: a withdrawn service was still sold';

  -- The organization provisioned earlier is untouched and still works.
  select count(*) into n from public.organization_modules
   where organization_id = org and module_key = 'restaurant' and enabled;
  assert n = 1, 'FAIL: withdrawing a service disabled an existing customer';

  update public.platform_services set is_available = true where module_key = 'restaurant';

  raise notice 'C5: service availability gates new sales only';

  -- ==========================================================================
  -- 9. Email lookup works for an admin and reveals nothing more
  -- ==========================================================================
  select user_id into msg from public.platform_find_user_by_email('c5newowner@test.local');
  assert msg::uuid = u_newowner, 'FAIL: email lookup returned the wrong user';

  select count(*) into n from public.platform_find_user_by_email('nobody@test.local');
  assert n = 0, 'FAIL: email lookup invented a user';

  -- ==========================================================================
  -- 10. Still no path to create a Platform Admin
  -- ==========================================================================
  perform auth.login_as(u_newowner);
  ok := false;
  begin
    insert into public.platform_admins (user_id, role) values (u_newowner, 'owner');
  exception when others then ok := true;
  end;
  assert ok, 'FAIL: a freshly onboarded owner minted a Platform Admin';

  perform auth.as_admin();
  raise notice 'PLATFORM ADMIN COMPLETION: all assertions passed';
end $$;
