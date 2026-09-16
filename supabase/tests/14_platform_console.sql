-- =============================================================================
-- LOCAL BASIC — Platform console suite
--
-- The read surface the operator's screens sit on. What has to hold:
--
--   1. None of it exists for anyone who is not a platform admin — not for a
--      tenant owner, not for a signed-in customer, not for anon.
--   2. Search finds a customer by any of the things a caller might know, and
--      the term is a value rather than something that can steer the query.
--   3. A customer profile exposes that customer and no other, and stops short
--      of the tenant's own business data.
--   4. Billing stays server-authoritative: the quote the admin is shown is the
--      one the renewal records, and an invalid promo buys nothing.
--   5. Provisioning still runs through the secure path, and is audited.
--
-- Run with:  psql -v ON_ERROR_STOP=1 -f supabase/tests/14_platform_console.sql
-- =============================================================================

\set ON_ERROR_STOP on

do $$
declare
  u_admin   uuid;
  u_owner_a uuid;
  u_owner_b uuid;
  u_cust    uuid;
  org_a     uuid;  code_a text;  branch_a uuid;
  org_b     uuid;  code_b text;
  plan_id   uuid;
  n         int;
  ok        boolean;
  msg       text;
  gross     bigint;
  net       bigint;
  disc      bigint;
  ends_before timestamptz;
  ends_after  timestamptz;
  r         record;
begin
  -- ==========================================================================
  -- Fixture: one platform admin, two customers, one end-customer.
  -- ==========================================================================
  insert into auth.users (email) values ('pcadmin@test.local')  returning id into u_admin;
  insert into auth.users (email) values ('pcownera@test.local') returning id into u_owner_a;
  insert into auth.users (email) values ('pcownerb@test.local') returning id into u_owner_b;
  insert into auth.users (email) values ('pccust@test.local')   returning id into u_cust;

  insert into public.profiles (id, full_name, phone)
  values (u_owner_a, 'سامي عبد الله', '01555000111')
  on conflict (id) do update set full_name = excluded.full_name, phone = excluded.phone;

  insert into public.platform_admins (user_id, role) values (u_admin, 'owner');
  select id into plan_id from public.plans where key = 'basic';

  perform auth.login_as(u_owner_a);
  select out_organization_id, out_branch_id into org_a, branch_a
    from public.provision_workspace('كافيه القمر', 'pcmoon', 'restaurant');
  perform auth.login_as(u_owner_b);
  select out_organization_id into org_b
    from public.provision_workspace('مطعم النجمة', 'pcstar', 'restaurant');
  perform auth.as_admin();

  select customer_code into code_a from public.organizations where id = org_a;
  select customer_code into code_b from public.organizations where id = org_b;

  insert into public.branding_settings (organization_id, display_name, phone, whatsapp)
  values (org_a, 'قمر كافيه', '0223334444', '01000111222')
  on conflict (organization_id) do update
    set display_name = excluded.display_name, phone = excluded.phone,
        whatsapp = excluded.whatsapp;

  insert into public.settings (organization_id, branch_id, key, value)
  values (org_a, null, 'restaurant.website_enabled', 'true'::jsonb)
  on conflict do nothing;

  -- ==========================================================================
  -- 1. The console does not exist for anyone but a platform admin
  --
  -- Three identities that all fail the same way: anonymous, a tenant OWNER who
  -- holds every permission inside their own organization, and a signed-in
  -- customer. None of them is a platform admin, and tenant RBAC has no path to
  -- becoming one.
  -- ==========================================================================
  perform auth.logout();

  ok := false;
  begin perform public.platform_search_customers(null, 10);
  exception when insufficient_privilege then ok := true; end;
  assert ok, 'FAIL: anon could execute platform_search_customers';

  ok := false;
  begin perform public.platform_dashboard_stats(3);
  exception when insufficient_privilege then ok := true; end;
  assert ok, 'FAIL: anon could execute platform_dashboard_stats';

  ok := false;
  begin perform public.platform_customer_profile(code_a);
  exception when insufficient_privilege then ok := true; end;
  assert ok, 'FAIL: anon could execute platform_customer_profile';

  -- The tenant owner. Signed in, fully privileged inside org A, and still not
  -- an admin: the function raises 42501 from require_platform_admin().
  perform auth.login_as(u_owner_a);

  assert app.has_permission(org_a, 'settings.manage'),
    'FAIL: fixture is wrong — the owner should hold tenant permissions';
  assert not app.is_platform_admin(),
    'FAIL: a tenant owner is a platform admin';

  for msg in select unnest(array[
    'platform_search_customers', 'platform_dashboard_stats', 'platform_recent_activity',
    'platform_customer_profile', 'platform_customer_branches',
    'platform_customer_modules', 'platform_customer_audit'
  ]) loop
    ok := false;
    begin
      case msg
        when 'platform_search_customers'  then perform public.platform_search_customers(null, 10);
        when 'platform_dashboard_stats'   then perform public.platform_dashboard_stats(3);
        when 'platform_recent_activity'   then perform public.platform_recent_activity(10);
        when 'platform_customer_profile'  then perform public.platform_customer_profile(code_a);
        when 'platform_customer_branches' then perform public.platform_customer_branches(code_a);
        when 'platform_customer_modules'  then perform public.platform_customer_modules(code_a);
        when 'platform_customer_audit'    then perform public.platform_customer_audit(code_a, 10);
      end case;
    exception when others then ok := true; end;
    assert ok, format('FAIL: a tenant owner could execute %s', msg);
  end loop;

  -- Even asking about their OWN organization is refused: the console is not a
  -- self-service view, and admin identity is the only key to it.
  ok := false;
  begin perform public.platform_customer_profile(code_a);
  exception when others then ok := true; end;
  assert ok, 'FAIL: a tenant owner read their own customer profile through the console';

  -- A signed-in end-customer (D3) has no organization at all.
  perform auth.login_as(u_cust);
  ok := false;
  begin perform public.platform_search_customers(null, 10);
  exception when others then ok := true; end;
  assert ok, 'FAIL: a customer account could search platform customers';
  assert not app.is_platform_admin(), 'FAIL: a customer account is a platform admin';

  raise notice 'CONSOLE: the platform surface is closed to anon, tenants and customers';

  -- ==========================================================================
  -- 2. An admin can list customers
  -- ==========================================================================
  perform auth.login_as(u_admin);

  select count(*) into n from public.platform_search_customers(null, 200);
  assert n >= 2, format('FAIL: the admin listing returned %s rows', n);

  raise notice 'CONSOLE: a platform admin lists customers';

  -- ==========================================================================
  -- 3. Search by customer code
  -- ==========================================================================
  select count(*) into n from public.platform_search_customers(code_a, 50);
  assert n = 1, format('FAIL: searching the customer code returned %s rows', n);

  select s.name into msg from public.platform_search_customers(code_a, 50) s;
  assert msg = 'كافيه القمر', 'FAIL: the customer code matched the wrong customer';

  -- Lower case, because an operator retyping a code will not shout it.
  select count(*) into n from public.platform_search_customers(lower(code_a), 50);
  assert n = 1, 'FAIL: the customer code search is case sensitive';

  raise notice 'CONSOLE: search by customer code';

  -- ==========================================================================
  -- 4. Search by organization name, slug, owner email, owner name and phone
  -- ==========================================================================
  select count(*) into n from public.platform_search_customers('القمر', 50);
  assert n = 1, format('FAIL: searching by name returned %s rows', n);

  select count(*) into n from public.platform_search_customers('pcmoon', 50);
  assert n = 1, 'FAIL: searching by slug found nothing';

  select count(*) into n from public.platform_search_customers('pcownera@test.local', 50);
  assert n = 1, 'FAIL: searching by owner email found nothing';

  select count(*) into n from public.platform_search_customers('سامي', 50);
  assert n = 1, 'FAIL: searching by owner name found nothing';

  -- The published restaurant number, from branding_settings.
  select count(*) into n from public.platform_search_customers('0223334444', 50);
  assert n = 1, 'FAIL: searching by the restaurant phone found nothing';

  -- And the search returns the contact details the operator needs to verify
  -- they have the right customer on the line.
  select s.owner_email, s.contact_phone, s.owner_name into r
    from public.platform_search_customers(code_a, 50) s;
  assert r.owner_email = 'pcownera@test.local', 'FAIL: the owner email is missing from search';
  assert r.contact_phone = '0223334444', 'FAIL: the contact phone is missing from search';
  assert r.owner_name = 'سامي عبد الله', 'FAIL: the owner name is missing from search';

  raise notice 'CONSOLE: search by name, slug, owner email, owner name and phone';

  -- ==========================================================================
  -- 5. The search term is a value, not part of the query
  --
  -- The previous implementation interpolated the term into a PostgREST `or=`
  -- filter. These are the terms that would have steered it.
  -- ==========================================================================
  select count(*) into n from public.platform_search_customers(
    'x,status.eq.active', 50);
  assert n = 0, 'FAIL: a filter expression in the search term matched rows';

  select count(*) into n from public.platform_search_customers(
    'x,or(customer_code.ilike.%25)', 50);
  assert n = 0, 'FAIL: a nested filter in the search term matched rows';

  -- A LIKE wildcard is a literal character, so a lazy `%` does not dump the
  -- whole customer base.
  select count(*) into n from public.platform_search_customers('%', 50);
  assert n = 0, 'FAIL: a bare %% matched every customer';

  select count(*) into n from public.platform_search_customers('_', 50);
  assert n = 0, 'FAIL: a bare _ behaved as a wildcard';

  -- A classic injection string is just a search that finds nothing, and the
  -- schema is still standing afterwards.
  select count(*) into n from public.platform_search_customers(
    'x''; drop table public.organizations; --', 50);
  assert n = 0, 'FAIL: a hostile search term matched rows';
  assert to_regclass('public.organizations') is not null,
    'FAIL: a hostile search term reached the schema';

  raise notice 'CONSOLE: the search term cannot steer the query';

  -- ==========================================================================
  -- 6. A profile exposes one customer, and nothing of their business
  -- ==========================================================================
  select count(*) into n from public.platform_customer_profile(code_a);
  assert n = 1, 'FAIL: the profile did not resolve';

  select p.name, p.owner_email, p.website_enabled, p.branch_count, p.slug into r
    from public.platform_customer_profile(code_a) p;
  assert r.name = 'كافيه القمر', 'FAIL: the profile returned the wrong customer';
  assert r.owner_email = 'pcownera@test.local', 'FAIL: the profile lost the owner';
  assert r.website_enabled, 'FAIL: the profile did not read the published website state';
  assert r.branch_count >= 1, 'FAIL: the profile did not count branches';

  -- Customer B's data is not in customer A's profile, by any route.
  select count(*) into n from public.platform_customer_profile(code_a) p
   where p.name = 'مطعم النجمة';
  assert n = 0, 'FAIL: one profile returned another customer';

  -- A branch that exists only under customer B. Compared by a slug unique to
  -- B, because the default branch slug provisioning creates is the same string
  -- in every workspace and would prove nothing.
  perform auth.as_admin();
  insert into public.branches (organization_id, slug, name)
  values (org_b, 'staronly', 'فرع النجمة وحده');
  perform auth.login_as(u_admin);

  select count(*) into n from public.platform_customer_branches(code_a) b
   where b.slug = 'staronly';
  assert n = 0, 'FAIL: branches leaked across customers';

  select count(*) into n from public.platform_customer_branches(code_b) b
   where b.slug = 'staronly';
  assert n = 1, 'FAIL: the branch listing missed a branch of its own customer';

  assert (select count(*) from public.platform_customer_branches(code_a))
       = (select count(*) from public.branches b
           where b.organization_id = org_a and b.deleted_at is null),
    'FAIL: the branch listing does not match that customer''s own branches';

  -- An unknown code returns nothing rather than an error that confirms a
  -- format, and every section agrees.
  select count(*) into n from public.platform_customer_profile('LB-999999');
  assert n = 0, 'FAIL: an unknown customer code returned a profile';
  select count(*) into n from public.platform_customer_branches('LB-999999');
  assert n = 0, 'FAIL: an unknown customer code returned branches';
  select count(*) into n from public.platform_customer_audit('LB-999999', 10);
  assert n = 0, 'FAIL: an unknown customer code returned an audit trail';

  -- The projection carries no internal ids beyond the organization id the
  -- renewal form needs, and nothing from inside the tenant's business.
  for r in
    select p.proname, arg.name as attname
      from pg_proc p,
           lateral unnest(p.proargnames, p.proargmodes) as arg(name, mode)
     where p.pronamespace = 'public'::regnamespace
       and p.proname in ('platform_customer_branches', 'platform_customer_audit',
                         'platform_customer_modules')
       and arg.mode = 't'
  loop
    assert r.attname not in ('id', 'organization_id', 'branch_id', 'user_id',
                             'owner_user_id', 'before', 'after'),
      format('FAIL: %s exposes the internal column %s', r.proname, r.attname);
  end loop;

  raise notice 'CONSOLE: a profile is one customer, without their business data';

  -- ==========================================================================
  -- 7. Dashboard numbers are counted, not invented
  -- ==========================================================================
  select * into r from public.platform_dashboard_stats(3);
  assert r.total_customers = (select count(*) from public.organizations where deleted_at is null),
    'FAIL: the customer total does not match the table';
  assert r.branches_total = (
    select count(*) from public.branches b
    join public.organizations o on o.id = b.organization_id
    where b.deleted_at is null and o.deleted_at is null),
    'FAIL: the branch total does not match the table';
  assert r.active_customers >= 2, 'FAIL: the active count is wrong';
  assert r.expired = (
    select count(*) from public.organizations o
    where o.deleted_at is null
      and (select sub.current_period_end from public.subscriptions sub
            where sub.organization_id = o.id
              and sub.status in ('trialing','active','past_due')
            order by sub.current_period_end desc limit 1) < now()),
    'FAIL: the expired count does not match the subscriptions';

  raise notice 'CONSOLE: dashboard counters match the underlying rows';

  -- ==========================================================================
  -- 8. Renewal is priced by the server, and recorded
  -- ==========================================================================
  select s.current_period_end into ends_before from public.subscriptions s
   where s.organization_id = org_a and s.status in ('trialing','active','past_due')
   order by s.current_period_end desc limit 1;

  select q.gross_cents, q.net_cents, q.discount_cents into gross, net, disc
    from public.platform_quote_renewal(org_a, plan_id, 'year', null) q;
  assert gross > 0, 'FAIL: the quote priced a yearly term at zero';
  assert net = gross - disc, 'FAIL: the quote does not add up';

  -- The renewal recomputes it. Nothing about the price is passed in.
  perform public.platform_renew_subscription(org_a, plan_id, 'year', null, 'cash', null);

  select s.current_period_end into ends_after from public.subscriptions s
   where s.organization_id = org_a and s.status in ('trialing','active','past_due')
   order by s.current_period_end desc limit 1;
  assert ends_after > ends_before, 'FAIL: the renewal did not extend the term';

  select count(*) into n from public.subscription_events e
   where e.organization_id = org_a and e.event_type = 'renewed'
     and e.net_cents = net and e.payment_method = 'cash';
  assert n >= 1, 'FAIL: the renewal recorded no matching subscription event';

  select count(*) into n from public.audit_logs a
   where a.organization_id = org_a and a.action like 'platform.%'
     and a.actor_id = u_admin;
  assert n >= 1, 'FAIL: the renewal was not audited against the acting admin';

  raise notice 'CONSOLE: renewal is priced server-side, recorded and audited';

  -- ==========================================================================
  -- 9. Promo codes are validated in the database
  -- ==========================================================================
  -- A code whose window has closed. starts_at must precede ends_at, so the
  -- whole window sits in the past rather than ending before it began.
  insert into public.promo_codes (code, kind, percent_off, is_active, starts_at, ends_at)
  values ('PCEXPIRED', 'percent', 50, true,
          now() - interval '30 days', now() - interval '1 day');
  insert into public.promo_codes (code, kind, percent_off, is_active)
  values ('PCOFF', 'percent', 50, false);
  insert into public.promo_codes (code, kind, percent_off, is_active)
  values ('PCGOOD', 'percent', 25, true);

  select q.valid into ok from public.platform_quote_renewal(org_a, plan_id, 'month', 'NOPE') q;
  assert not ok, 'FAIL: an unknown promo code was accepted';

  select q.valid into ok from public.platform_quote_renewal(org_a, plan_id, 'month', 'PCEXPIRED') q;
  assert not ok, 'FAIL: an expired promo code was accepted';

  select q.valid into ok from public.platform_quote_renewal(org_a, plan_id, 'month', 'PCOFF') q;
  assert not ok, 'FAIL: an inactive promo code was accepted';

  select q.valid, q.discount_cents, q.gross_cents into r
    from public.platform_quote_renewal(org_a, plan_id, 'month', 'pcgood') q;
  assert r.valid, 'FAIL: a valid promo code was rejected';
  assert r.discount_cents = r.gross_cents / 4,
    format('FAIL: 25%% off %s came to %s', r.gross_cents, r.discount_cents);

  -- And an invalid code cannot be pushed past the quote into a renewal.
  ok := false;
  begin
    perform public.platform_renew_subscription(org_a, plan_id, 'month', 'PCEXPIRED', 'cash', null);
  exception when others then ok := true; end;
  assert ok, 'FAIL: an expired promo code went through the renewal';

  raise notice 'CONSOLE: promo validation is the database''s, at quote and at renewal';

  -- ==========================================================================
  -- 10. Provisioning still runs through the secure path
  -- ==========================================================================
  select count(*) into n from public.organizations;
  perform public.platform_create_workspace(
    u_owner_b, 'فرع تجريبي', 'pcnew', 'restaurant', 'الفرع الرئيسي',
    'EG', 'EGP', 'Africa/Cairo', 'ar');
  assert (select count(*) from public.organizations) = n + 1,
    'FAIL: platform_create_workspace did not create a workspace';

  -- The named owner is the owner — not the admin who pressed the button.
  select o.owner_user_id into msg from public.organizations o where o.slug::text = 'pcnew';
  assert msg = u_owner_b::text, 'FAIL: the workspace was created under the wrong owner';

  select count(*) into n from public.organization_members m
    join public.organizations o on o.id = m.organization_id
   where o.slug::text = 'pcnew' and m.user_id = u_admin;
  assert n = 0, 'FAIL: the acting admin became a member of the customer workspace';

  select count(*) into n from public.audit_logs a
    join public.organizations o on o.id = a.organization_id
   where o.slug::text = 'pcnew' and a.action like 'platform.%';
  assert n >= 1, 'FAIL: workspace creation was not audited';

  raise notice 'CONSOLE: provisioning names its owner, excludes the admin, and is audited';

  -- ==========================================================================
  -- 11. A customer's timeline is their own
  -- ==========================================================================
  select count(*) into n from public.platform_customer_audit(code_a, 100);
  assert n >= 1, 'FAIL: the customer has no audit trail';

  -- Nothing from customer B appears on customer A's timeline. Compared by
  -- count against the organization's own rows, which is the only correct set.
  select count(*) into n from public.audit_logs where organization_id = org_a;
  assert (select count(*) from public.platform_customer_audit(code_a, 200)) = least(n, 200),
    'FAIL: the customer timeline does not match that organization''s audit rows';

  raise notice 'CONSOLE: a customer timeline is scoped to that customer';

  -- ==========================================================================
  -- 12. Tenant isolation is unchanged by any of this
  -- ==========================================================================
  perform auth.login_as(u_owner_a);
  select count(*) into n from public.organizations;
  assert n = 1, format('FAIL: a tenant owner can see %s organizations', n);
  select count(*) into n from public.platform_admins;
  assert n = 0, 'FAIL: a tenant owner can read the platform admin roster';
  select count(*) into n from public.subscription_events where organization_id = org_b;
  assert n = 0, 'FAIL: a tenant owner can read another customer''s billing history';

  raise notice 'CONSOLE: tenant isolation is unchanged';

  raise notice 'PLATFORM CONSOLE: all assertions passed';
end $$;
