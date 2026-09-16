-- =============================================================================
-- LOCAL BASIC — DNS verification hardening (migration 0044)
--
-- 0043 shipped `restaurant_domain_record_verification` granted to
-- `authenticated`, taking the observed TXT values as an argument. A tenant
-- knows their own challenge, so they could hand it back and be marked verified
-- without ever publishing a DNS record. This suite is the proof that the hole
-- is closed, and it is written to fail loudly if anyone reopens it.
--
-- The claims:
--
--   1. `authenticated` cannot execute the verification write. Neither can
--      `anon`. Not "is refused inside" — cannot execute it at all.
--   2. The old four-argument signature is gone, so no overload survives that
--      PostgREST could still route to.
--   3. `service_role` can execute it, because the trusted server-side path
--      must still work.
--   4. The tenant-callable half tells a caller only what to look up, only for
--      their own domain, and never the stored hash.
--   5. On the trusted path the organization fence is still structural: a
--      domain id from another restaurant is refused even there.
--   6. The state machine and the audit trail are unchanged by all of this.
--
-- Run with:  psql -v ON_ERROR_STOP=1 -f supabase/tests/17_domain_verification_hardening.sql
-- =============================================================================

\set ON_ERROR_STOP on

do $$
declare
  u_a    uuid;  u_b uuid;
  org_a  uuid;  org_b uuid;
  dom_a  uuid;  tok_a text;
  dom_b  uuid;  tok_b text;
  n      int;
  ok     boolean;
  txt    text;
  r      record;
begin
  -- ==========================================================================
  -- Fixture: two restaurants, one domain each.
  -- ==========================================================================
  insert into auth.users (email) values ('harda@test.local') returning id into u_a;
  insert into auth.users (email) values ('hardb@test.local') returning id into u_b;

  perform auth.login_as(u_a);
  select out_organization_id into org_a
    from public.provision_workspace('مطعم التحقّق', 'hardalpha', 'restaurant');

  perform auth.login_as(u_b);
  select out_organization_id into org_b
    from public.provision_workspace('مطعم آخر', 'hardbeta', 'restaurant');

  perform auth.login_as(u_a);
  select out_id, out_token into dom_a, tok_a
    from public.restaurant_domain_add('hardalpha', 'hardened-a.test');

  perform auth.login_as(u_b);
  select out_id, out_token into dom_b, tok_b
    from public.restaurant_domain_add('hardbeta', 'hardened-b.test');

  -- ==========================================================================
  -- 1. The grant itself. This is the assertion that matters most: it reads
  --    the catalog rather than inferring privilege from behaviour, so it
  --    cannot be satisfied by a function that merely happens to refuse.
  -- ==========================================================================
  assert not has_function_privilege(
    'authenticated',
    'public.restaurant_domain_record_verification(text, uuid, text[], text, uuid)',
    'execute'),
    'FAIL: authenticated may execute the verification write';

  assert not has_function_privilege(
    'anon',
    'public.restaurant_domain_record_verification(text, uuid, text[], text, uuid)',
    'execute'),
    'FAIL: anon may execute the verification write';

  assert not has_function_privilege(
    'public',
    'public.restaurant_domain_record_verification(text, uuid, text[], text, uuid)',
    'execute'),
    'FAIL: PUBLIC may execute the verification write';

  assert has_function_privilege(
    'service_role',
    'public.restaurant_domain_record_verification(text, uuid, text[], text, uuid)',
    'execute'),
    'FAIL: service_role cannot execute the verification write';

  raise notice 'HARDENING: only service_role holds EXECUTE on the verification write';

  -- ==========================================================================
  -- 2. No surviving overload.
  --
  -- A leftover four-argument function would still be granted to
  -- `authenticated` from 0043, and PostgREST resolves by argument names — so
  -- the old, reachable signature has to be gone, not merely shadowed.
  -- ==========================================================================
  select count(*) into n
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public'
     and p.proname = 'restaurant_domain_record_verification';
  assert n = 1, format('FAIL: %s verification functions exist; exactly one must', n);

  select count(*) into n
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public'
     and p.proname = 'restaurant_domain_record_verification'
     and p.pronargs = 5;
  assert n = 1, 'FAIL: the surviving verification function is not the 5-argument one';

  raise notice 'HARDENING: the pre-0044 signature is gone, no overload survives';

  -- ==========================================================================
  -- 3. A tenant actually trying it. The catalog says they cannot; this says
  --    what happens when they try anyway.
  -- ==========================================================================
  perform auth.login_as(u_a);
  ok := false;
  begin
    perform public.restaurant_domain_record_verification(
      'hardalpha', dom_a, array[tok_a], null, u_a);
  exception
    when insufficient_privilege then ok := true;
    when others then ok := true;
  end;
  assert ok, 'FAIL: a tenant executed the verification write with their own challenge';

  -- And it changed nothing: the domain is still pending, unverified.
  perform auth.as_admin();
  select status, verified_at is null into r
    from public.restaurant_website_domains where id = dom_a;
  assert r.status = 'pending', format('FAIL: status is %s after a refused call', r.status);
  perform auth.login_as(u_a);

  perform auth.logout();
  ok := false;
  begin
    perform public.restaurant_domain_record_verification(
      'hardalpha', dom_a, array[tok_a], null, null);
  exception when others then ok := true; end;
  assert ok, 'FAIL: an anonymous caller executed the verification write';

  raise notice 'HARDENING: authenticated and anon are refused at the boundary';

  -- ==========================================================================
  -- 4. The tenant-callable half: what to look up, and nothing more.
  -- ==========================================================================
  perform auth.login_as(u_a);
  select out_hostname, out_challenge_name into r
    from public.restaurant_domain_verification_target('hardalpha', dom_a);
  assert r.out_hostname = 'hardened-a.test',
    format('FAIL: the target hostname is %s', r.out_hostname);
  assert r.out_challenge_name = '_localbasic.hardened-a.test',
    format('FAIL: the challenge name is %s', r.out_challenge_name);

  -- It returns two columns. If a hash ever joins them, this fails.
  select count(*) into n
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace,
    lateral unnest(p.proargmodes, p.proargnames) as a(mode, name)
   where ns.nspname = 'public'
     and p.proname = 'restaurant_domain_verification_target'
     and a.mode = 't';
  assert n = 2, format('FAIL: the verification target returns %s columns, expected 2', n);

  select count(*) into n
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace,
    lateral unnest(p.proargmodes, p.proargnames) as a(mode, name)
   where ns.nspname = 'public'
     and p.proname in ('restaurant_domain_verification_target', 'restaurant_domains_list')
     and a.mode = 't' and a.name ilike '%hash%';
  assert n = 0, 'FAIL: a projection exposes the verification token hash';

  -- Another restaurant's domain is simply not there — the same answer as a
  -- domain that does not exist, so a probe learns nothing.
  select count(*) into n
    from public.restaurant_domain_verification_target('hardalpha', dom_b);
  assert n = 0, 'FAIL: tenant A got a verification target for tenant B''s domain';

  select count(*) into n
    from public.restaurant_domain_verification_target('hardbeta', dom_b);
  assert n = 0, 'FAIL: tenant A got a target by naming tenant B''s slug';

  select count(*) into n
    from public.restaurant_domain_verification_target(
      'hardalpha', '00000000-0000-0000-0000-000000000000');
  assert n = 0, 'FAIL: a nonexistent domain produced a verification target';

  raise notice 'HARDENING: the target lookup is tenant-scoped and hash-free';

  -- ==========================================================================
  -- 5. The trusted path still enforces the fence structurally.
  --
  -- The service role has no session, so the organization check inside the
  -- function is all that stands between one restaurant and another's domain.
  -- ==========================================================================
  perform auth.as_service_role();

  ok := false;
  begin
    perform public.restaurant_domain_record_verification(
      'hardalpha', dom_b, array[tok_b], null, u_a);
  exception when others then ok := true; end;
  assert ok, 'FAIL: the trusted path verified a domain outside the named organization';

  ok := false;
  begin
    perform public.restaurant_domain_record_verification(
      'no-such-restaurant', dom_a, array[tok_a], null, u_a);
  exception when others then ok := true; end;
  assert ok, 'FAIL: the trusted path accepted an unknown organization slug';

  -- A wrong value still proves nothing, even here.
  select out_verified into ok
    from public.restaurant_domain_record_verification(
      'hardalpha', dom_a, array['not-the-token'], 'no record', u_a);
  assert not ok, 'FAIL: a wrong TXT value verified on the trusted path';

  -- The right value, observed by the server, does.
  select out_status, out_verified into r
    from public.restaurant_domain_record_verification(
      'hardalpha', dom_a, array[tok_a], null, u_a);
  assert r.out_verified, 'FAIL: the observed challenge did not verify';
  assert r.out_status = 'verified',
    format('FAIL: status is %s after a successful verification', r.out_status);

  raise notice 'HARDENING: the trusted path keeps the organization fence';

  -- ==========================================================================
  -- 6. The state machine and the audit trail are untouched.
  -- ==========================================================================
  perform auth.login_as(u_a);
  perform public.restaurant_domain_set_status('hardalpha', dom_a, 'active');

  perform auth.as_admin();
  select count(*) into n from public.audit_logs
   where organization_id = org_a
     and action = 'restaurant.domain_verification_attempted'
     and entity_id = dom_a::text;
  assert n >= 2, format('FAIL: %s verification attempts audited, expected at least 2', n);

  -- The actor survives the trip through the service role.
  select count(*) into n from public.audit_logs
   where organization_id = org_a
     and action = 'restaurant.domain_verification_attempted'
     and entity_id = dom_a::text
     and actor_id = u_a;
  assert n >= 2, 'FAIL: the acting user was lost on the trusted path';

  -- No audit payload carries the challenge or its hash.
  select count(*) into n from public.audit_logs
   where action = 'restaurant.domain_verification_attempted'
     and (after::text like '%' || tok_a || '%' or after ? 'verification_token_hash');
  assert n = 0, 'FAIL: an audit payload carries verification material';

  raise notice 'HARDENING: audit records the actor and never the secret';

  raise notice 'DOMAIN VERIFICATION HARDENING: all assertions passed';
end $$;
