-- =============================================================================
-- LOCAL BASIC — Custom domains suite
--
-- A hostname is an ownership claim, so the claims to prove are:
--
--   1. A hostname belongs to exactly one restaurant, and the database — not
--      the application — is what makes that true.
--   2. Only an ACTIVE domain routes public traffic. Existing is not enough.
--   3. Activation requires proof, and the proof is a hash comparison the
--      caller cannot skip.
--   4. One tenant cannot read, verify, activate, disable or remove another's.
--   5. The challenge value never travels anywhere after it is created.
--   6. Normalization is total: case, trailing dots, ports and junk all land
--      on one canonical answer or are refused.
--
-- Run with:  psql -v ON_ERROR_STOP=1 -f supabase/tests/16_website_domains.sql
-- =============================================================================

\set ON_ERROR_STOP on

do $$
declare
  u_a     uuid;  u_b uuid;  u_waiter uuid;  u_admin uuid;
  org_a   uuid;  org_b uuid;
  role_waiter uuid;  member_waiter uuid;
  dom_a   uuid;  tok_a text;
  dom_www uuid;  tok_www text;
  dom_b   uuid;  tok_b text;
  n       int;
  ok      boolean;
  msg     text;
  r       record;
begin
  -- ==========================================================================
  -- Fixture: two restaurants, both with a published website.
  -- ==========================================================================
  insert into auth.users (email) values ('doma@test.local')      returning id into u_a;
  insert into auth.users (email) values ('domb@test.local')      returning id into u_b;
  insert into auth.users (email) values ('domwaiter@test.local') returning id into u_waiter;
  insert into auth.users (email) values ('domadmin@test.local')  returning id into u_admin;

  perform auth.login_as(u_a);
  select out_organization_id into org_a
    from public.provision_workspace('مطعم النطاق', 'domalpha', 'restaurant');
  perform auth.login_as(u_b);
  select out_organization_id into org_b
    from public.provision_workspace('مطعم بيتا', 'dombeta', 'restaurant');
  perform auth.as_admin();

  insert into public.platform_admins (user_id, role) values (u_admin, 'owner');
  insert into public.settings (organization_id, branch_id, key, value) values
    (org_a, null, 'restaurant.website_enabled', 'true'::jsonb),
    (org_b, null, 'restaurant.website_enabled', 'true'::jsonb);

  select id into role_waiter from public.roles
   where organization_id = org_a and key = 'waiter' limit 1;
  insert into public.organization_members (organization_id, user_id, status, all_branches)
  values (org_a, u_waiter, 'active', true) returning id into member_waiter;
  insert into public.user_roles (member_id, role_id) values (member_waiter, role_waiter);

  -- ==========================================================================
  -- 1. Normalization is total
  --
  -- Everything that means the same hostname reaches the same answer, and
  -- everything that is not a hostname is refused outright rather than parsed
  -- into something we did not agree to.
  -- ==========================================================================
  assert app.normalize_hostname('Example-Restaurant.com') = 'example-restaurant.com',
    'FAIL: case is not normalized';
  assert app.normalize_hostname('example-restaurant.com.') = 'example-restaurant.com',
    'FAIL: a trailing dot is not normalized';
  assert app.normalize_hostname('EXAMPLE.com:3000') = 'example.com',
    'FAIL: a port is not stripped';
  assert app.normalize_hostname('  Example.COM  ') = 'example.com',
    'FAIL: surrounding whitespace is not trimmed';
  assert app.normalize_hostname('sub.example.co.uk') = 'sub.example.co.uk',
    'FAIL: a multi-label hostname was rejected';
  assert app.normalize_hostname('xn--mgbh0fb.xn--kgbechtv') is not null,
    'FAIL: a punycode hostname was rejected';

  for msg in select unnest(array[
    'https://example.com',
    'http://example.com',
    'javascript:alert(1)',
    'example.com/path',
    'example.com?q=1',
    'example.com#x',
    'ex ample.com',
    'user@example.com',
    'example',
    '-bad.example.com',
    'example-.com',
    '.example.com',
    '',
    '   '
  ]) loop
    assert app.normalize_hostname(msg) is null,
      format('FAIL: %s was accepted as a hostname', msg);
  end loop;

  raise notice 'DOMAINS: normalization is canonical and rejects non-hostnames';

  -- ==========================================================================
  -- 2. An authorized tenant adds a domain and receives the challenge once
  -- ==========================================================================
  perform auth.login_as(u_a);

  select out_id, out_hostname, out_token into dom_a, msg, tok_a
    from public.restaurant_domain_add('domalpha', 'Example-Restaurant.COM.');
  assert msg = 'example-restaurant.com', 'FAIL: the stored hostname is not canonical';
  assert length(tok_a) >= 24, 'FAIL: the challenge value is too short to be a secret';

  -- The value is stored as a hash and nothing else. A read of the row, or of
  -- the tenant's own listing, must not carry it.
  perform auth.as_admin();
  select count(*) into n from public.restaurant_website_domains
   where id = dom_a and verification_token_hash = tok_a;
  assert n = 0, 'FAIL: the challenge value is stored in plaintext';
  select count(*) into n from public.restaurant_website_domains
   where id = dom_a and verification_token_hash = app.sha256_hex(tok_a);
  assert n = 1, 'FAIL: the stored hash does not match the issued value';
  perform auth.login_as(u_a);

  -- No projection the tenant can read carries the hash, let alone the value.
  select count(*) into n
    from pg_proc p,
         lateral unnest(p.proargnames, p.proargmodes) as arg(name, mode)
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('restaurant_domains_list', 'platform_customer_domains',
                       'restaurant_domain_resolve')
     and arg.mode = 't'
     and (arg.name like '%token%' or arg.name like '%hash%');
  assert n = 0, 'FAIL: a projection exposes verification material';

  raise notice 'DOMAINS: the challenge is issued once and stored only as a hash';

  -- ==========================================================================
  -- 3. Uniqueness is the database's job
  --
  -- The same hostname, in every disguise, from either restaurant.
  -- ==========================================================================
  for msg in select unnest(array[
    'example-restaurant.com',
    'Example-Restaurant.com',
    'EXAMPLE-RESTAURANT.COM',
    'example-restaurant.com.',
    'example-restaurant.com:8080'
  ]) loop
    ok := false;
    begin perform public.restaurant_domain_add('domalpha', msg);
    exception when others then ok := true; end;
    assert ok, format('FAIL: %s created a duplicate of an owned hostname', msg);
  end loop;

  -- And from the other restaurant, which is the case that matters.
  perform auth.login_as(u_b);
  ok := false;
  begin perform public.restaurant_domain_add('dombeta', 'EXAMPLE-RESTAURANT.com');
  exception when others then ok := true; end;
  assert ok, 'FAIL: a second restaurant claimed an owned hostname';

  -- Straight at the table, past the function: the unique index answers.
  perform auth.as_admin();
  ok := false;
  begin
    insert into public.restaurant_website_domains
      (organization_id, hostname, normalized_hostname, verification_token_hash)
    values (org_b, 'example-restaurant.com', 'example-restaurant.com', 'x');
  exception when unique_violation then ok := true; end;
  assert ok, 'FAIL: the database allowed two rows for one hostname';
  perform auth.login_as(u_a);

  raise notice 'DOMAINS: a hostname belongs to exactly one restaurant';

  -- ==========================================================================
  -- 4. Nothing routes until it is ACTIVE
  -- ==========================================================================
  perform auth.logout();
  select count(*) into n from public.restaurant_domain_resolve('example-restaurant.com');
  assert n = 0, 'FAIL: a pending domain resolved publicly';
  perform auth.login_as(u_a);

  -- Activation refuses an unverified domain, from the function and from the
  -- table's own trigger.
  ok := false;
  begin perform public.restaurant_domain_set_status('domalpha', dom_a, 'active');
  exception when others then ok := true; end;
  assert ok, 'FAIL: an unverified domain was activated';

  perform auth.as_admin();
  ok := false;
  begin
    update public.restaurant_website_domains set status = 'active' where id = dom_a;
  exception when others then ok := true; end;
  assert ok, 'FAIL: the trigger allowed activation without verification';

  -- And the state machine refuses the jump even with a verified_at present.
  ok := false;
  begin
    update public.restaurant_website_domains
       set status = 'active', verified_at = now() where id = dom_a;
  exception when others then ok := true; end;
  assert ok, 'FAIL: pending jumped straight to active';
  perform auth.login_as(u_a);

  raise notice 'DOMAINS: activation requires verification and a legal transition';

  -- ==========================================================================
  -- 5. Verification compares hashes; a wrong value proves nothing
  -- ==========================================================================
  -- Since 0044 the write is granted to `service_role` alone: these calls stand
  -- in for the server-side action that performed the DNS lookup. Suite 17
  -- proves that `authenticated` and `anon` cannot make them at all.
  perform auth.as_service_role();
  select out_verified into ok
    from public.restaurant_domain_record_verification('domalpha', dom_a, array['wrong']);
  assert not ok, 'FAIL: a wrong TXT value verified the domain';

  select out_verified into ok
    from public.restaurant_domain_record_verification('domalpha', dom_a, array[]::text[]);
  assert not ok, 'FAIL: an empty lookup verified the domain';
  perform auth.login_as(u_a);

  -- The attempt is recorded either way, so a verified domain always has a
  -- timestamped attempt behind it.
  select count(*) into n from public.restaurant_domains_list('domalpha') d
   where d.id = dom_a and d.verification_attempted_at is not null;
  assert n = 1, 'FAIL: a failed attempt was not recorded';

  -- The real value, as a DNS provider would return it — quoted.
  perform auth.as_service_role();
  select out_status, out_verified into r
    from public.restaurant_domain_record_verification('domalpha', dom_a, array['"' || tok_a || '"']);
  perform auth.login_as(u_a);
  assert r.out_verified, 'FAIL: the correct TXT value did not verify';
  assert r.out_status = 'verified', format('FAIL: status is %s after verifying', r.out_status);

  perform public.restaurant_domain_set_status('domalpha', dom_a, 'active');

  perform auth.logout();
  select count(*) into n from public.restaurant_domain_resolve('example-restaurant.com');
  assert n = 1, 'FAIL: an active domain does not resolve';

  -- Every spelling of the same hostname resolves to the same restaurant.
  for msg in select unnest(array[
    'EXAMPLE-RESTAURANT.COM', 'example-restaurant.com.', 'example-restaurant.com:443'
  ]) loop
    select d.org_slug into r from public.restaurant_domain_resolve(msg) d;
    assert r.org_slug = 'domalpha', format('FAIL: %s did not resolve to its owner', msg);
  end loop;

  -- A hostname nobody owns, and one that is not a hostname at all.
  for msg in select unnest(array[
    'unclaimed.test', 'https://example-restaurant.com', 'example-restaurant.com/x', ''
  ]) loop
    select count(*) into n from public.restaurant_domain_resolve(msg);
    assert n = 0, format('FAIL: %s resolved to a restaurant', msg);
  end loop;

  raise notice 'DOMAINS: verification is a hash comparison, and only active hostnames resolve';

  -- ==========================================================================
  -- 6. The resolver hands out the minimum
  -- ==========================================================================
  for r in
    select arg.name as attname
      from pg_proc p,
           lateral unnest(p.proargnames, p.proargmodes) as arg(name, mode)
     where p.pronamespace = 'public'::regnamespace
       and p.proname = 'restaurant_domain_resolve'
       and arg.mode = 't'
  loop
    assert r.attname in ('org_slug', 'redirect_to'),
      format('FAIL: the public resolver exposes %s', r.attname);
  end loop;

  -- anon holds no privilege on the table itself.
  ok := false;
  begin perform 1 from public.restaurant_website_domains;
  exception when insufficient_privilege then ok := true; end;
  assert ok, 'FAIL: anon holds a privilege on restaurant_website_domains';

  for msg in select unnest(array[
    'restaurant_domains_list', 'restaurant_domain_add', 'restaurant_domain_set_status'
  ]) loop
    ok := false;
    begin
      case msg
        when 'restaurant_domains_list' then perform public.restaurant_domains_list('domalpha');
        when 'restaurant_domain_add' then perform public.restaurant_domain_add('domalpha', 'x.test');
        when 'restaurant_domain_set_status' then
          perform public.restaurant_domain_set_status('domalpha', dom_a, 'disabled');
      end case;
    exception when others then ok := true; end;
    assert ok, format('FAIL: anon could execute %s', msg);
  end loop;

  raise notice 'DOMAINS: the public surface is one slug, and anon reaches nothing else';

  -- ==========================================================================
  -- 7. ATTACK: restaurant B goes after restaurant A's domain
  -- ==========================================================================
  perform auth.login_as(u_b);

  select count(*) into n from public.restaurant_website_domains;
  assert n = 0, 'FAIL: tenant B can read tenant A''s domain rows';
  select count(*) into n from public.restaurant_domains_list('domalpha');
  assert n = 0, 'FAIL: tenant B listed tenant A''s domains';

  -- Naming tenant A's slug, and naming tenant A's domain id under their own
  -- slug: both find nothing.
  for msg in select unnest(array['domalpha', 'dombeta']) loop
    ok := false;
    begin perform public.restaurant_domain_set_status(msg, dom_a, 'disabled');
    exception when others then ok := true; end;
    assert ok, format('FAIL: tenant B disabled tenant A''s domain via %s', msg);

    -- Tenant B cannot even learn what to look up, which is as far as a
    -- client gets: the write itself is service-role only (suite 17).
    select count(*) into n
      from public.restaurant_domain_verification_target(msg, dom_a);
    assert n = 0,
      format('FAIL: tenant B got a verification target for tenant A''s domain via %s', msg);

    ok := false;
    begin perform public.restaurant_domain_set_primary(msg, dom_a);
    exception when others then ok := true; end;
    assert ok, format('FAIL: tenant B made tenant A''s domain primary via %s', msg);
  end loop;

  -- Remove is a no-op rather than an error, and must not delete anything.
  begin perform public.restaurant_domain_remove('dombeta', dom_a); exception when others then null; end;
  perform auth.as_admin();
  select count(*) into n from public.restaurant_website_domains where id = dom_a;
  assert n = 1, 'FAIL: tenant B removed tenant A''s domain';

  -- Straight at the table.
  perform auth.login_as(u_b);
  begin
    update public.restaurant_website_domains set status = 'disabled' where id = dom_a;
    get diagnostics n = row_count;
    assert n = 0, 'FAIL: RLS let tenant B update tenant A''s domain';
  exception when others then null; end;

  begin
    delete from public.restaurant_website_domains where id = dom_a;
    get diagnostics n = row_count;
    assert n = 0, 'FAIL: RLS let tenant B delete tenant A''s domain';
  exception when others then null; end;

  -- And the domain still resolves to its real owner throughout.
  perform auth.logout();
  select d.org_slug into r from public.restaurant_domain_resolve('example-restaurant.com') d;
  assert r.org_slug = 'domalpha', 'FAIL: the domain stopped pointing at its owner';

  raise notice 'DOMAINS: one tenant cannot read, verify, activate, disable or remove another''s';

  -- ==========================================================================
  -- 8. A member without settings.manage is refused
  -- ==========================================================================
  perform auth.login_as(u_waiter);

  assert not app.has_permission(org_a, 'settings.manage'),
    'FAIL: fixture is wrong — the waiter should not hold settings.manage';

  select count(*) into n from public.restaurant_domains_list('domalpha');
  assert n = 0, 'FAIL: a member without settings.manage listed domains';

  ok := false;
  begin perform public.restaurant_domain_add('domalpha', 'waiter.test');
  exception when others then ok := true; end;
  assert ok, 'FAIL: a member without settings.manage added a domain';

  ok := false;
  begin perform public.restaurant_domain_set_status('domalpha', dom_a, 'disabled');
  exception when others then ok := true; end;
  assert ok, 'FAIL: a member without settings.manage changed a domain';

  raise notice 'DOMAINS: settings.manage is required, not merely expected';

  -- ==========================================================================
  -- 9. Disabling stops routing but keeps ownership
  -- ==========================================================================
  perform auth.login_as(u_a);
  perform public.restaurant_domain_set_status('domalpha', dom_a, 'disabled');

  perform auth.logout();
  select count(*) into n from public.restaurant_domain_resolve('example-restaurant.com');
  assert n = 0, 'FAIL: a disabled domain still resolved';

  -- OWNERSHIP DECISION, asserted: a disabled hostname is still taken. A
  -- competitor cannot claim it during a lapse.
  perform auth.login_as(u_b);
  ok := false;
  begin perform public.restaurant_domain_add('dombeta', 'example-restaurant.com');
  exception when others then ok := true; end;
  assert ok, 'FAIL: a disabled domain was claimable by another restaurant';

  -- The owner can bring it back: disabled → verified → active.
  perform auth.as_service_role();
  select out_verified into ok
    from public.restaurant_domain_record_verification('domalpha', dom_a, array[tok_a]);
  perform auth.login_as(u_a);
  assert ok, 'FAIL: a disabled domain could not be re-verified';
  perform public.restaurant_domain_set_status('domalpha', dom_a, 'active');

  perform auth.logout();
  select count(*) into n from public.restaurant_domain_resolve('example-restaurant.com');
  assert n = 1, 'FAIL: a reactivated domain does not resolve';
  perform auth.login_as(u_a);

  raise notice 'DOMAINS: disabling stops traffic and keeps the hostname reserved';

  -- ==========================================================================
  -- 10. www and the bare domain settle on one address, without a loop
  -- ==========================================================================
  select out_id, out_token into dom_www, tok_www
    from public.restaurant_domain_add('domalpha', 'www.example-restaurant.com');
  perform auth.as_service_role();
  perform public.restaurant_domain_record_verification('domalpha', dom_www, array[tok_www]);
  perform auth.login_as(u_a);
  perform public.restaurant_domain_set_status('domalpha', dom_www, 'active');

  -- With no primary chosen, neither redirects: both simply render.
  perform auth.logout();
  select d.redirect_to into msg from public.restaurant_domain_resolve('www.example-restaurant.com') d;
  assert msg is null, 'FAIL: a domain redirects with no primary chosen';
  perform auth.login_as(u_a);

  perform public.restaurant_domain_set_primary('domalpha', dom_a);

  perform auth.logout();
  -- The alias points at the canonical one...
  select d.org_slug, d.redirect_to into r
    from public.restaurant_domain_resolve('www.example-restaurant.com') d;
  assert r.redirect_to = 'example-restaurant.com',
    format('FAIL: the alias redirects to %s', coalesce(r.redirect_to, '<null>'));
  -- ...and the canonical one never redirects, which is what stops a loop.
  select d.redirect_to into msg from public.restaurant_domain_resolve('example-restaurant.com') d;
  assert msg is null, 'FAIL: the primary domain redirects, which would loop';
  perform auth.login_as(u_a);

  -- Only one primary at a time, enforced by the index.
  perform public.restaurant_domain_set_primary('domalpha', dom_www);
  perform auth.as_admin();
  select count(*) into n from public.restaurant_website_domains
   where organization_id = org_a and is_primary;
  assert n = 1, format('FAIL: %s domains are primary at once', n);

  -- Disabling the primary gives up the crown rather than leaving the redirect
  -- pointing at a domain that no longer serves.
  perform auth.login_as(u_a);
  perform public.restaurant_domain_set_status('domalpha', dom_www, 'disabled');
  perform auth.as_admin();
  select count(*) into n from public.restaurant_website_domains
   where id = dom_www and is_primary;
  assert n = 0, 'FAIL: a disabled domain is still primary';
  perform auth.login_as(u_a);

  raise notice 'DOMAINS: one canonical hostname, aliases redirect, no loop';

  -- ==========================================================================
  -- 11. The website switch governs the custom domain too
  -- ==========================================================================
  perform auth.as_admin();
  update public.settings set value = 'false'::jsonb
   where organization_id = org_a and key = 'restaurant.website_enabled';
  perform auth.logout();

  select count(*) into n from public.restaurant_domain_resolve('example-restaurant.com');
  assert n = 0, 'FAIL: an unpublished restaurant still served its custom domain';

  perform auth.as_admin();
  update public.settings set value = 'true'::jsonb
   where organization_id = org_a and key = 'restaurant.website_enabled';
  perform auth.login_as(u_a);

  raise notice 'DOMAINS: unpublishing the website takes the custom domain down';

  -- ==========================================================================
  -- 12. Removal is the only thing that frees a hostname
  -- ==========================================================================
  select out_id, out_token into dom_b, tok_b
    from public.restaurant_domain_add('domalpha', 'temporary.test');
  perform public.restaurant_domain_remove('domalpha', dom_b);

  perform auth.login_as(u_b);
  select out_id into dom_b from public.restaurant_domain_add('dombeta', 'temporary.test');
  assert dom_b is not null, 'FAIL: a removed hostname was not claimable again';

  raise notice 'DOMAINS: removal releases the hostname, and only removal';

  -- ==========================================================================
  -- 13. Platform Admin can look, and only look
  -- ==========================================================================
  perform auth.login_as(u_admin);

  assert app.is_platform_admin(), 'FAIL: fixture is wrong — this user should be a platform admin';
  assert not app.has_permission(org_a, 'settings.manage'),
    'FAIL: a platform admin acquired a tenant permission';

  select count(*) into n from public.platform_customer_domains(
    (select o.customer_code from public.organizations o where o.id = org_a));
  assert n >= 1, 'FAIL: a platform admin cannot see a customer''s domains';

  -- Reading is through the admin function only; the table stays closed.
  select count(*) into n from public.restaurant_website_domains;
  assert n = 0, 'FAIL: a platform admin reads tenant domain rows through RLS';

  for msg in select unnest(array['add', 'status', 'remove']) loop
    ok := false;
    begin
      case msg
        when 'add' then perform public.restaurant_domain_add('domalpha', 'admin-grab.test');
        when 'status' then perform public.restaurant_domain_set_status('domalpha', dom_a, 'disabled');
        when 'remove' then perform public.restaurant_domain_remove('domalpha', dom_a);
      end case;
    exception when others then ok := true; end;
    assert ok, format('FAIL: a platform admin could %s a tenant domain', msg);
  end loop;

  -- A tenant cannot read the platform view, either.
  perform auth.login_as(u_a);
  ok := false;
  begin perform public.platform_customer_domains(
    (select o.customer_code from public.organizations o where o.id = org_a));
  exception when others then ok := true; end;
  assert ok, 'FAIL: a tenant read the platform admin domain view';

  raise notice 'DOMAINS: platform admin inspects, and cannot manage';

  -- ==========================================================================
  -- 14. A domain cannot be moved between restaurants or rewritten
  -- ==========================================================================
  perform auth.as_admin();

  ok := false;
  begin
    update public.restaurant_website_domains set organization_id = org_b where id = dom_a;
  exception when others then ok := true; end;
  assert ok, 'FAIL: a domain was moved to another organization';

  ok := false;
  begin
    update public.restaurant_website_domains
       set hostname = 'other.test', normalized_hostname = 'other.test' where id = dom_a;
  exception when others then ok := true; end;
  assert ok, 'FAIL: a domain''s hostname was rewritten in place';

  -- And the CHECK keeps hostname and normalized_hostname honest.
  ok := false;
  begin
    insert into public.restaurant_website_domains
      (organization_id, hostname, normalized_hostname, verification_token_hash)
    values (org_b, 'Mismatch.test', 'something-else.test', 'x');
  exception when others then ok := true; end;
  assert ok, 'FAIL: a row stored a normalized hostname that is not its own';

  raise notice 'DOMAINS: a domain keeps its owner and its name';

  raise notice 'WEBSITE DOMAINS: all assertions passed';
end $$;
