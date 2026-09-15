-- =============================================================================
-- LOCAL BASIC — Platform Admin + billing test suite
--
-- Two things must hold, and everything else is detail:
--   1. A tenant user — owner included — can neither become a Platform Admin
--      nor reach any platform surface.
--   2. Money is decided by the database. A caller who names a plan and a term
--      cannot influence the price, the discount, or the period end.
--
-- Run with:  psql -v ON_ERROR_STOP=1 -f supabase/tests/08_platform_admin.sql
-- =============================================================================

\set ON_ERROR_STOP on

do $$
declare
  u_admin    uuid;   -- platform admin
  u_owner    uuid;   -- ordinary tenant owner
  u_stranger uuid;   -- signed in, no platform role, no membership
  org        uuid;
  org2       uuid;
  plan_basic uuid;
  plan_growth uuid;
  promo30    uuid;
  promo_trial uuid;
  ev         bigint;
  q          record;
  s          record;
  n          int;
  ok         boolean;
  msg        text;
begin
  -- ==========================================================================
  -- Fixture
  -- ==========================================================================
  insert into auth.users (email) values ('padmin@test.local')   returning id into u_admin;
  insert into auth.users (email) values ('powner@test.local')   returning id into u_owner;
  insert into auth.users (email) values ('pstranger@test.local') returning id into u_stranger;

  select id into plan_basic  from public.plans where key = 'basic';
  select id into plan_growth from public.plans where key = 'growth';

  -- The first Platform Admin is created out-of-band, exactly as the migration
  -- documents: a privileged connection, never an in-app path.
  insert into public.platform_admins (user_id, role) values (u_admin, 'owner');

  -- A tenant workspace, provisioned the ordinary self-service way.
  perform auth.login_as(u_owner);
  select out_organization_id into org
    from public.provision_workspace('Test Diner', 'testdiner', 'restaurant');
  perform auth.as_admin();

  -- ==========================================================================
  -- 1. Customer code: issued, well-formed, unique, permanent
  -- ==========================================================================
  select customer_code into msg from public.organizations where id = org;
  assert msg ~ '^LB-[0-9]{6}$', 'FAIL: customer_code malformed: ' || coalesce(msg, '<null>');

  select count(*) into n from public.organizations
   where customer_code is null;
  assert n = 0, 'FAIL: an organization has no customer_code';

  select count(*) into n from (
    select customer_code from public.organizations group by customer_code having count(*) > 1
  ) d;
  assert n = 0, 'FAIL: duplicate customer_code';

  ok := false;
  begin
    update public.organizations set customer_code = 'LB-999999' where id = org;
  exception when others then ok := true;
  end;
  assert ok, 'FAIL: customer_code was changed — it must be permanent';

  raise notice 'PLATFORM: customer code issued, unique and immutable';

  -- ==========================================================================
  -- 2. A tenant user cannot become, see, or create a Platform Admin
  -- ==========================================================================
  perform auth.login_as(u_owner);

  assert not app.is_platform_admin(), 'FAIL: tenant owner reports as platform admin';

  -- No INSERT privilege at all: escalation fails on grants, before policies.
  ok := false;
  begin
    insert into public.platform_admins (user_id, role) values (u_owner, 'owner');
  exception when insufficient_privilege then ok := true;
             when others then ok := true;
  end;
  assert ok, 'FAIL: a tenant owner minted a Platform Admin';

  -- The roster is not even enumerable.
  select count(*) into n from public.platform_admins;
  assert n = 0, 'FAIL: tenant owner can see the platform admin roster';

  -- Platform tables are invisible.
  select count(*) into n from public.promo_codes;
  assert n = 0, 'FAIL: tenant owner can read promo codes';

  -- Platform functions refuse a tenant caller.
  ok := false;
  begin
    perform public.platform_quote_renewal(org, plan_basic, 'month', null);
  exception when others then ok := true;
  end;
  assert ok, 'FAIL: tenant owner priced a renewal';

  ok := false;
  begin
    perform public.platform_renew_subscription(org, plan_basic, 'year', null, 'cash', null);
  exception when others then ok := true;
  end;
  assert ok, 'FAIL: tenant owner renewed a subscription';

  ok := false;
  begin
    perform public.platform_create_workspace(u_owner, 'Sneaky', 'sneaky', 'restaurant');
  exception when others then ok := true;
  end;
  assert ok, 'FAIL: tenant owner provisioned a workspace for another owner';

  -- Subscriptions remain read-only to tenants (no DML privilege).
  ok := false;
  begin
    update public.subscriptions set current_period_end = now() + interval '10 years'
     where organization_id = org;
  exception when others then ok := true;
  end;
  assert ok, 'FAIL: tenant owner extended their own subscription';

  raise notice 'PLATFORM: tenant users are fully walled off';

  -- A signed-in stranger fares no better.
  perform auth.login_as(u_stranger);
  assert not app.is_platform_admin(), 'FAIL: stranger reports as platform admin';
  select count(*) into n from public.organizations;
  assert n = 0, 'FAIL: stranger can see organizations';

  -- ==========================================================================
  -- 3. Pricing is computed server-side from the catalogue
  -- ==========================================================================
  perform auth.login_as(u_admin);

  assert app.is_platform_admin(), 'FAIL: platform admin not recognised';

  -- basic = 49900/month. A year must be twelve times that, not whatever a
  -- client might like it to be.
  select * into q from public.platform_quote_renewal(org, plan_basic, 'year', null);
  assert q.valid, 'FAIL: clean quote rejected';
  assert q.months = 12, 'FAIL: year is not 12 months';
  assert q.gross_cents = 49900 * 12,
    'FAIL: annual gross wrong: ' || q.gross_cents;
  assert q.discount_cents = 0, 'FAIL: phantom discount';
  assert q.net_cents = q.gross_cents, 'FAIL: net <> gross with no promo';

  select * into q from public.platform_quote_renewal(org, plan_basic, 'quarter', null);
  assert q.months = 3 and q.gross_cents = 49900 * 3, 'FAIL: quarter mispriced';

  select * into q from public.platform_quote_renewal(org, plan_basic, 'semiannual', null);
  assert q.months = 6 and q.gross_cents = 49900 * 6, 'FAIL: semiannual mispriced';

  select * into q from public.platform_quote_renewal(org, plan_basic, 'month', null);
  assert q.months = 1 and q.gross_cents = 49900, 'FAIL: month mispriced';

  ok := false;
  begin
    perform public.platform_quote_renewal(org, plan_basic, 'fortnight', null);
  exception when others then ok := true;
  end;
  assert ok, 'FAIL: an unknown billing period was accepted';

  raise notice 'PLATFORM: every term priced from the plan, server-side';

  -- ==========================================================================
  -- 4. Promo codes
  -- ==========================================================================
  insert into public.promo_codes (code, kind, percent_off, created_by)
  values ('DEMO30', 'percent', 30, u_admin) returning id into promo30;

  insert into public.promo_codes (code, kind, trial_days, created_by)
  values ('TRIAL14', 'trial_days', 14, u_admin) returning id into promo_trial;

  select * into q from public.platform_quote_renewal(org, plan_basic, 'year', 'DEMO30');
  assert q.valid, 'FAIL: DEMO30 rejected';
  assert q.discount_cents = floor(49900 * 12 * 0.30),
    'FAIL: 30% discount wrong: ' || q.discount_cents;
  assert q.net_cents = q.gross_cents - q.discount_cents, 'FAIL: net mismatch';

  -- Codes are case-insensitive (citext) — an admin typing lowercase still works.
  select * into q from public.platform_quote_renewal(org, plan_basic, 'year', 'demo30');
  assert q.valid and q.discount_cents > 0, 'FAIL: lowercase code rejected';

  select * into q from public.platform_quote_renewal(org, plan_basic, 'month', 'TRIAL14');
  assert q.valid and q.trial_days = 14, 'FAIL: trial code did not grant days';

  select * into q from public.platform_quote_renewal(org, plan_basic, 'month', 'NOPE404');
  assert not q.valid and q.reason = 'code_not_found', 'FAIL: unknown code accepted';
  assert q.discount_cents = 0, 'FAIL: invalid code still discounted';

  -- Inactive
  update public.promo_codes set is_active = false where id = promo30;
  select * into q from public.platform_quote_renewal(org, plan_basic, 'month', 'DEMO30');
  assert not q.valid and q.reason = 'code_inactive', 'FAIL: inactive code accepted';
  update public.promo_codes set is_active = true where id = promo30;

  -- Expired. Both bounds move into the past: ends_at > starts_at is a real
  -- constraint, so a code cannot be "expired" by ending before it began.
  update public.promo_codes
     set starts_at = now() - interval '30 days', ends_at = now() - interval '1 day'
   where id = promo30;
  select * into q from public.platform_quote_renewal(org, plan_basic, 'month', 'DEMO30');
  assert not q.valid and q.reason = 'code_expired', 'FAIL: expired code accepted';
  update public.promo_codes set starts_at = now(), ends_at = null where id = promo30;

  -- Not yet started
  update public.promo_codes set starts_at = now() + interval '7 days' where id = promo30;
  select * into q from public.platform_quote_renewal(org, plan_basic, 'month', 'DEMO30');
  assert not q.valid and q.reason = 'code_not_started', 'FAIL: future code accepted';
  update public.promo_codes set starts_at = now() - interval '1 minute' where id = promo30;

  -- Wrong plan
  update public.promo_codes set plan_id = plan_growth where id = promo30;
  select * into q from public.platform_quote_renewal(org, plan_basic, 'month', 'DEMO30');
  assert not q.valid and q.reason = 'code_wrong_plan', 'FAIL: code used on the wrong plan';
  update public.promo_codes set plan_id = null where id = promo30;

  -- Exhausted
  update public.promo_codes set max_redemptions = 1, redeemed_count = 1 where id = promo30;
  select * into q from public.platform_quote_renewal(org, plan_basic, 'month', 'DEMO30');
  assert not q.valid and q.reason = 'code_exhausted', 'FAIL: exhausted code accepted';
  update public.promo_codes set max_redemptions = null, redeemed_count = 0 where id = promo30;

  raise notice 'PLATFORM: promo validation covers inactive/expired/plan/limit';

  -- ==========================================================================
  -- 5. Renewal writes history and moves the subscription forward
  -- ==========================================================================
  select current_period_end into msg from public.subscriptions where organization_id = org;

  ev := public.platform_renew_subscription(org, plan_basic, 'year', 'DEMO30', 'cash', 'أول تجديد');
  assert ev is not null, 'FAIL: renewal returned no event';

  select * into s from public.subscriptions where organization_id = org;
  assert s.status = 'active', 'FAIL: status after paid renewal is ' || s.status;
  assert s.billing_period = 'year', 'FAIL: billing_period not stored';
  assert s.plan_id = plan_basic, 'FAIL: plan not applied';
  assert s.current_period_end > now() + interval '360 days',
    'FAIL: annual term did not extend a year';

  select * into s from public.subscription_events where id = ev;
  assert s.event_type = 'renewed', 'FAIL: event_type is ' || s.event_type;
  assert s.gross_cents = 49900 * 12, 'FAIL: history gross wrong';
  assert s.discount_cents = floor(49900 * 12 * 0.30), 'FAIL: history discount wrong';
  assert s.net_cents = s.gross_cents - s.discount_cents, 'FAIL: history net wrong';
  assert s.payment_method = 'cash', 'FAIL: payment method not recorded';
  assert s.promo_code = 'DEMO30', 'FAIL: promo code not recorded in history';

  -- Redemption recorded and counted.
  select count(*) into n from public.promo_redemptions
   where promo_code_id = promo30 and organization_id = org;
  assert n = 1, 'FAIL: redemption not recorded';
  select redeemed_count into n from public.promo_codes where id = promo30;
  assert n = 1, 'FAIL: redeemed_count not incremented';

  -- The same code cannot be used twice by the same organization.
  select * into q from public.platform_quote_renewal(org, plan_basic, 'month', 'DEMO30');
  assert not q.valid and q.reason = 'code_already_used', 'FAIL: code reused by same org';

  -- Audit written.
  select count(*) into n from public.audit_logs
   where organization_id = org and action = 'platform.subscription_renewed';
  assert n = 1, 'FAIL: renewal not audited';

  raise notice 'PLATFORM: renewal recorded in history, redemption and audit';

  -- ==========================================================================
  -- 6. History is append-only
  -- ==========================================================================
  ok := false;
  begin
    update public.subscription_events set net_cents = 0 where id = ev;
  exception when others then ok := true;
  end;
  assert ok, 'FAIL: subscription history was rewritten';

  ok := false;
  begin
    delete from public.subscription_events where id = ev;
  exception when others then ok := true;
  end;
  assert ok, 'FAIL: subscription history was deleted';

  raise notice 'PLATFORM: subscription history is append-only';

  -- ==========================================================================
  -- 7. Renewing again extends from the existing end, never truncates it
  -- ==========================================================================
  select current_period_end into s from public.subscriptions where organization_id = org;
  select * into q from public.platform_quote_renewal(org, plan_basic, 'month', null);
  assert q.period_start >= (select current_period_end from public.subscriptions where organization_id = org)
       - interval '1 second',
    'FAIL: early renewal would truncate the paid term';

  ev := public.platform_renew_subscription(org, plan_basic, 'month', null, 'cash', null);
  select count(*) into n from public.subscription_events where organization_id = org;
  assert n >= 3, 'FAIL: history did not accumulate (created + 2 renewals), got ' || n;

  -- Exactly one live subscription, still.
  select count(*) into n from public.subscriptions
   where organization_id = org and status in ('trialing','active','past_due');
  assert n = 1, 'FAIL: more than one live subscription';

  raise notice 'PLATFORM: renewals extend and accumulate history';

  -- ==========================================================================
  -- 8. Expiry warning is derived server-side
  -- ==========================================================================
  insert into public.promo_codes (code, kind, percent_off, new_customers_only, created_by)
  values ('NEWONLY', 'percent', 50, true, u_admin);

  perform auth.as_admin();
  update public.subscriptions
     set current_period_end = now() + interval '2 days'
   where organization_id = org;
  perform auth.login_as(u_admin);

  select count(*) into n from public.platform_expiring_subscriptions(3)
   where organization_id = org;
  assert n = 1, 'FAIL: subscription expiring in 2 days not flagged';

  select days_left into n from public.platform_expiring_subscriptions(3)
   where organization_id = org;
  assert n <= 3, 'FAIL: days_left wrong: ' || n;

  perform auth.as_admin();
  update public.subscriptions
     set current_period_end = now() + interval '90 days'
   where organization_id = org;
  perform auth.login_as(u_admin);

  select count(*) into n from public.platform_expiring_subscriptions(3)
   where organization_id = org;
  assert n = 0, 'FAIL: healthy subscription flagged as expiring';

  raise notice 'PLATFORM: expiry warning computed from current_period_end';

  -- ==========================================================================
  -- 9. new_customers_only looks at real payment history
  -- ==========================================================================
  select * into q from public.platform_quote_renewal(org, plan_basic, 'month', 'NEWONLY');
  assert not q.valid and q.reason = 'code_new_customers_only',
    'FAIL: new-customer code accepted for a paying customer';

  -- ==========================================================================
  -- 10. Platform Admin provisions for another owner
  -- ==========================================================================
  select out_organization_id into org2
    from public.platform_create_workspace(
      u_stranger, 'Admin Made Cafe', 'adminmade', 'restaurant'
    );
  assert org2 is not null, 'FAIL: platform provisioning returned nothing';

  -- The named owner owns it — not the admin who created it.
  select owner_user_id into msg from public.organizations where id = org2;
  assert msg::uuid = u_stranger, 'FAIL: owner is not the named user';

  select count(*) into n from public.organization_members
   where organization_id = org2 and user_id = u_admin;
  assert n = 0, 'FAIL: the platform admin made themselves a member';

  -- The new owner really can use it.
  perform auth.login_as(u_stranger);
  select count(*) into n from public.organizations where id = org2;
  assert n = 1, 'FAIL: the named owner cannot see their own workspace';
  assert app.is_owner(org2), 'FAIL: the named owner lacks the owner role';

  -- And the restaurant module was bootstrapped through the same Core hook.
  select count(*) into n from public.restaurant_tables where organization_id = org2;
  assert n > 0, 'FAIL: restaurant bootstrap did not run for the new workspace';

  perform auth.login_as(u_admin);
  select customer_code into msg from public.organizations where id = org2;
  assert msg ~ '^LB-[0-9]{6}$', 'FAIL: platform-created org has no customer code';

  select count(*) into n from public.audit_logs
   where organization_id = org2 and action = 'platform.workspace_created';
  assert n = 1, 'FAIL: platform provisioning not audited';

  raise notice 'PLATFORM: workspace provisioned for another owner, audited';

  -- ==========================================================================
  -- 11. Anonymous callers reach nothing
  -- ==========================================================================
  perform auth.logout();
  ok := false;
  begin
    perform public.platform_quote_renewal(org, plan_basic, 'month', null);
  exception when others then ok := true;
  end;
  assert ok, 'FAIL: anonymous caller priced a renewal';

  perform auth.as_admin();
  raise notice 'PLATFORM ADMIN + BILLING: all assertions passed';
end $$;
