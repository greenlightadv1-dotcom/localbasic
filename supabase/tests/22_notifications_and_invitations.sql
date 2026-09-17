-- =============================================================================
-- LOCAL BASIC — Notification worker and invitations suite (migration 0050)
--
-- Two seams that existed as tables and nothing else. The claims to prove:
--
-- The outbox:
--   1. Only `service_role` may work the queue. A tenant session cannot claim
--      a row or declare anything sent.
--   2. A claim moves a row out of 'pending' exactly once, so two workers never
--      deliver the same notification.
--   3. A lease that expires returns the row to the queue — a crashed worker
--      loses no mail.
--   4. `dedupe_key` makes an enqueue idempotent at the database.
--   5. Failures back off, and stop; a permanent failure stops immediately.
--   6. A report from a worker whose lease was reclaimed cannot overwrite the
--      row the new worker now holds.
--
-- Invitations:
--   7. Creating one needs `member.manage`, and the token is returned once.
--   8. Accepting is single-use, expiring, and refuses a signed-in address the
--      invitation was not sent to.
--   9. An invitation cannot carry a role or branch from another organization.
--  10. Acceptance is audited, and the audit never carries the token.
--
-- Run with:  psql -v ON_ERROR_STOP=1 -f supabase/tests/22_notifications_and_invitations.sql
-- =============================================================================

\set ON_ERROR_STOP on

do $$
declare
  u_owner  uuid;  u_other uuid;  u_invitee uuid;  u_wrong uuid;
  org_a    uuid;  org_b uuid;
  br_a     uuid;  br_b uuid;
  role_a   uuid;  role_b uuid;
  note_1   uuid;  note_2 uuid;
  inv_id   uuid;  inv_token text;
  n        int;
  ok       boolean;
  st       text;
  r        record;
begin
  -- ==========================================================================
  -- Fixture
  -- ==========================================================================
  insert into auth.users (email) values ('notif-owner@test.local')   returning id into u_owner;
  insert into auth.users (email) values ('notif-other@test.local')   returning id into u_other;
  insert into auth.users (email) values ('notif-invitee@test.local') returning id into u_invitee;
  insert into auth.users (email) values ('notif-wrong@test.local')   returning id into u_wrong;
  insert into public.profiles (id) values (u_invitee), (u_wrong) on conflict (id) do nothing;

  perform auth.login_as(u_owner);
  select out_organization_id, out_branch_id into org_a, br_a
    from public.provision_workspace('مطعم الدعوات', 'notifalpha', 'restaurant');
  perform auth.login_as(u_other);
  select out_organization_id, out_branch_id into org_b, br_b
    from public.provision_workspace('مطعم آخر', 'notifbeta', 'restaurant');

  perform auth.as_admin();
  select id into role_a from public.roles
   where organization_id = org_a and key = 'cashier' limit 1;
  select id into role_b from public.roles
   where organization_id = org_b and key = 'cashier' limit 1;

  -- Earlier suites enqueue as a side effect of what they test, and the worker
  -- claims from the whole queue rather than one organization's. Park those
  -- rows so this section observes only its own two.
  update public.notifications set status = 'cancelled' where status = 'pending';

  insert into public.notifications
    (organization_id, branch_id, recipient, channel, template, payload)
  values (org_a, br_a, 'someone@test.local', 'email', 'test.one', '{}'::jsonb)
  returning id into note_1;

  insert into public.notifications
    (organization_id, branch_id, recipient, channel, template, payload)
  values (org_a, br_a, 'someone@test.local', 'inapp', 'test.two', '{}'::jsonb)
  returning id into note_2;

  -- ==========================================================================
  -- 1. Only the service role may work the queue
  -- ==========================================================================
  perform auth.login_as(u_owner);
  for st in select unnest(array['claim','sent','failed']) loop
    ok := false;
    begin
      if st = 'claim' then
        perform public.notification_claim_batch(5);
      elsif st = 'sent' then
        perform public.notification_mark_sent(note_1);
      else
        perform public.notification_mark_failed(note_1, 'nope');
      end if;
    exception when others then ok := true; end;
    assert ok, format('FAIL: a tenant session ran notification %s', st);
  end loop;

  perform auth.logout();
  ok := false;
  begin perform public.notification_claim_batch(5);
  exception when others then ok := true; end;
  assert ok, 'FAIL: an anonymous caller claimed from the queue';

  -- The catalog agrees, not just the behaviour.
  assert not has_function_privilege('authenticated',
    'public.notification_claim_batch(int, int)', 'execute'),
    'FAIL: authenticated holds EXECUTE on the queue claim';
  assert has_function_privilege('service_role',
    'public.notification_claim_batch(int, int)', 'execute'),
    'FAIL: service_role cannot work the queue';

  raise notice 'QUEUE: only the service role may work the outbox';

  -- ==========================================================================
  -- 2. A claim takes a row exactly once
  -- ==========================================================================
  perform auth.as_service_role();
  select count(*) into n from public.notification_claim_batch(10);
  assert n = 2, format('FAIL: claimed %s rows, expected 2', n);

  -- A second pass finds nothing: both are leased.
  select count(*) into n from public.notification_claim_batch(10);
  assert n = 0, format('FAIL: a second worker re-claimed %s leased rows', n);

  perform auth.as_admin();
  select status, attempts, (lease_until is not null) as leased into r
    from public.notifications where id = note_1;
  assert r.status = 'sending', format('FAIL: a claimed row is %s', r.status);
  assert r.attempts = 1, format('FAIL: attempts is %s after one claim', r.attempts);

  raise notice 'QUEUE: a claim takes each row exactly once';

  -- ==========================================================================
  -- 3. An expired lease returns the row
  -- ==========================================================================
  update public.notifications set lease_until = now() - interval '1 minute'
   where id = note_1;

  perform auth.as_service_role();
  select count(*) into n from public.notification_claim_batch(10);
  assert n = 1, format('FAIL: %s rows reclaimed after a lease expired, expected 1', n);

  perform auth.as_admin();
  select attempts into n from public.notifications where id = note_1;
  assert n = 2, format('FAIL: attempts is %s after a reclaim', n);

  raise notice 'QUEUE: an expired lease returns the row to the queue';

  -- ==========================================================================
  -- 4. Reporting an outcome, and the race a late report would cause
  -- ==========================================================================
  perform auth.as_service_role();
  assert public.notification_mark_sent(note_2, 'inapp', 'ref-1'),
    'FAIL: a claimed row could not be marked sent';

  perform auth.as_admin();
  select status, (sent_at is not null) as delivered, provider, provider_ref into r
    from public.notifications where id = note_2;
  assert r.status = 'sent', format('FAIL: status is %s after marking sent', r.status);
  assert r.provider = 'inapp', 'FAIL: the provider was not recorded';

  -- A second report finds nothing to update: the row is no longer 'sending'.
  perform auth.as_service_role();
  assert not public.notification_mark_sent(note_2, 'inapp', 'ref-2'),
    'FAIL: an already-sent row was marked sent again';
  assert not public.notification_mark_failed(note_2, 'late failure'),
    'FAIL: a late failure overwrote a sent row';

  perform auth.as_admin();
  select provider_ref into st from public.notifications where id = note_2;
  assert st = 'ref-1', format('FAIL: the late report overwrote the reference (%s)', st);

  raise notice 'QUEUE: a late report cannot overwrite a finished row';

  -- ==========================================================================
  -- 5. Backoff, and giving up
  -- ==========================================================================
  perform auth.as_service_role();
  assert public.notification_mark_failed(note_1, 'provider down', false, 5),
    'FAIL: a transient failure was not recorded';

  perform auth.as_admin();
  -- Aliased, because a boolean expression has no column name of its own to
  -- land in the record.
  select status, (scheduled_for > now()) as deferred, last_error into r
    from public.notifications where id = note_1;
  assert r.status = 'pending', format('FAIL: a retryable failure is %s', r.status);
  assert r.deferred, 'FAIL: the retry was not pushed into the future';

  -- A permanent failure gives up at once, whatever the attempt count.
  -- The backoff just pushed this row minutes into the future; bring it due,
  -- which is all waiting would have done.
  perform auth.as_admin();
  update public.notifications set scheduled_for = now() where id = note_1;

  perform auth.as_service_role();
  perform public.notification_claim_batch(10);
  assert public.notification_mark_failed(note_1, 'no provider', true, 5),
    'FAIL: a permanent failure was not recorded';

  perform auth.as_admin();
  select status into st from public.notifications where id = note_1;
  assert st = 'failed', format('FAIL: a permanent failure is %s', st);

  -- And a failed row is never claimed again.
  perform auth.as_service_role();
  select count(*) into n from public.notification_claim_batch(10);
  assert n = 0, 'FAIL: a permanently failed row was claimed again';

  raise notice 'QUEUE: failures back off, and a permanent one stops at once';

  -- ==========================================================================
  -- 6. Idempotent enqueue
  -- ==========================================================================
  perform auth.as_admin();
  insert into public.notifications
    (organization_id, channel, template, payload, dedupe_key)
  values (org_a, 'email', 'test.dedupe', '{}'::jsonb, 'once');

  ok := false;
  begin
    insert into public.notifications
      (organization_id, channel, template, payload, dedupe_key)
    values (org_a, 'email', 'test.dedupe', '{}'::jsonb, 'once');
  exception when unique_violation then ok := true; end;
  assert ok, 'FAIL: the same dedupe key enqueued twice';

  -- The key is scoped per organization: two shops may both use 'once'.
  insert into public.notifications
    (organization_id, channel, template, payload, dedupe_key)
  values (org_b, 'email', 'test.dedupe', '{}'::jsonb, 'once');

  raise notice 'QUEUE: dedupe_key makes an enqueue idempotent, per organization';

  -- ==========================================================================
  -- 7. Creating an invitation
  -- ==========================================================================
  perform auth.login_as(u_other);
  ok := false;
  begin perform public.invitation_create(org_a, 'notif-invitee@test.local');
  exception when others then ok := true; end;
  assert ok, 'FAIL: an outsider invited someone into another organization';

  perform auth.login_as(u_owner);

  -- A role from another organization cannot ride along.
  ok := false;
  begin
    perform public.invitation_create(
      org_a, 'notif-invitee@test.local', array[role_b], '{}', false);
  exception when others then ok := true; end;
  assert ok, 'FAIL: an invitation carried another organization''s role';

  ok := false;
  begin
    perform public.invitation_create(
      org_a, 'notif-invitee@test.local', '{}', array[br_b], false);
  exception when others then ok := true; end;
  assert ok, 'FAIL: an invitation carried another organization''s branch';

  select out_id, out_token into inv_id, inv_token
    from public.invitation_create(
      org_a, 'notif-invitee@test.local', array[role_a], array[br_a], false, 7);
  assert inv_token is not null and length(inv_token) > 20,
    'FAIL: the invitation token is missing or too short';

  -- Only the hash is stored.
  perform auth.as_admin();
  select token_hash into st from public.invitations where id = inv_id;
  assert st = app.sha256_hex(inv_token), 'FAIL: the stored hash is not the token''s';
  assert st <> inv_token, 'FAIL: the token itself was stored';

  select count(*) into n from public.invitations
   where organization_id = org_a and token_hash = inv_token;
  assert n = 0, 'FAIL: the plaintext token appears in the table';

  raise notice 'INVITATIONS: created by a manager, stored only as a hash';

  -- ==========================================================================
  -- 8. Accepting
  -- ==========================================================================
  -- The wrong account is refused, and nothing is consumed.
  perform auth.login_as(u_wrong);
  ok := false;
  begin perform public.invitation_accept(inv_token);
  exception when others then ok := true; end;
  assert ok, 'FAIL: an invitation was accepted by a different email address';

  perform auth.as_admin();
  select accepted_at is null into ok from public.invitations where id = inv_id;
  assert ok, 'FAIL: a refused acceptance still consumed the invitation';

  -- A made-up token resolves nothing.
  perform auth.login_as(u_invitee);
  ok := false;
  begin perform public.invitation_accept('not-a-real-token');
  exception when others then ok := true; end;
  assert ok, 'FAIL: a made-up token was accepted';

  select out_organization_slug into st from public.invitation_accept(inv_token);
  assert st = 'notifalpha', format('FAIL: accepted into %s', st);

  -- The membership, the branch and the role all landed.
  perform auth.as_admin();
  select count(*) into n from public.organization_members
   where organization_id = org_a and user_id = u_invitee and status = 'active';
  assert n = 1, 'FAIL: the invitee is not an active member';

  select count(*) into n from public.user_roles ur
    join public.organization_members m on m.id = ur.member_id
   where m.user_id = u_invitee and ur.role_id = role_a;
  assert n = 1, 'FAIL: the invited role was not granted';

  select count(*) into n from public.member_branches mb
    join public.organization_members m on m.id = mb.member_id
   where m.user_id = u_invitee and mb.branch_id = br_a;
  assert n = 1, 'FAIL: the invited branch was not granted';

  -- Single use.
  perform auth.login_as(u_invitee);
  ok := false;
  begin perform public.invitation_accept(inv_token);
  exception when others then ok := true; end;
  assert ok, 'FAIL: the same invitation was accepted twice';

  raise notice 'INVITATIONS: single-use, and only by the invited address';

  -- ==========================================================================
  -- 9. Expiry and revocation
  -- ==========================================================================
  perform auth.login_as(u_owner);
  select out_id, out_token into inv_id, inv_token
    from public.invitation_create(org_a, 'notif-wrong@test.local');

  perform auth.as_admin();
  update public.invitations set expires_at = now() - interval '1 day' where id = inv_id;

  perform auth.login_as(u_wrong);
  ok := false;
  begin perform public.invitation_accept(inv_token);
  exception when others then ok := true; end;
  assert ok, 'FAIL: an expired invitation was accepted';

  -- The preview says so rather than pretending the link is fine.
  select out_expired into ok from public.invitation_preview(inv_token);
  assert ok, 'FAIL: the preview did not report the invitation as expired';

  perform auth.login_as(u_owner);
  select out_id, out_token into inv_id, inv_token
    from public.invitation_create(org_a, 'notif-wrong@test.local');
  perform public.invitation_revoke(org_a, inv_id);

  perform auth.login_as(u_wrong);
  ok := false;
  begin perform public.invitation_accept(inv_token);
  exception when others then ok := true; end;
  assert ok, 'FAIL: a revoked invitation was accepted';

  -- A tenant cannot revoke another organization's invitation.
  perform auth.login_as(u_other);
  ok := false;
  begin perform public.invitation_revoke(org_a, inv_id);
  exception when others then ok := true; end;
  assert ok, 'FAIL: an outsider revoked another organization''s invitation';

  raise notice 'INVITATIONS: expiry and revocation both close the link';

  -- ==========================================================================
  -- 10. Audit, without the token
  -- ==========================================================================
  perform auth.as_admin();
  select count(*) into n from public.audit_logs
   where organization_id = org_a
     and action in ('member.invited', 'member.invitation_accepted', 'member.invitation_revoked');
  assert n >= 3, format('FAIL: %s invitation actions audited, expected at least 3', n);

  select count(*) into n from public.audit_logs
   where action like 'member.invit%'
     and (after::text like '%' || inv_token || '%' or after ? 'token' or after ? 'token_hash');
  assert n = 0, 'FAIL: an audit payload carries invitation token material';

  raise notice 'INVITATIONS: audited, and never with the token';

  raise notice 'NOTIFICATIONS AND INVITATIONS: all assertions passed';
end $$;
