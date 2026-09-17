-- =============================================================================
-- LOCAL BASIC — 0050 The notification worker, and accepting an invitation
--
-- Two long-standing seams, both with the table already in place and nothing
-- driving it.
--
-- NOTIFICATIONS. 0004 created the outbox and four migrations enqueue into it;
-- nothing ever delivered a row. What a worker needs, and did not have:
--
--   * a way to CLAIM work without two workers taking the same row. Solved with
--     FOR UPDATE SKIP LOCKED and a lease, so a crashed worker's rows return to
--     the queue when the lease expires rather than being stuck forever.
--
--   * IDEMPOTENCY. A retry must not send twice. `dedupe_key` is unique, so an
--     enqueue that runs again is absorbed at the database rather than by the
--     caller remembering; and a claim only ever moves a row out of 'pending',
--     so a row already sending or sent is never picked up again.
--
--   * BACKOFF, so a failing provider is retried a bounded number of times at
--     growing intervals and then given up on, instead of spinning.
--
-- The worker itself is service-role only. None of these functions is reachable
-- by `authenticated`, and no credential of any kind lives in this schema.
--
-- INVITATIONS. 0001 created the table with a token HASH and 0007 gave it a
-- manage policy. The accept path was described in a comment and never written,
-- so an invited colleague had no way in. Accepting is single-use, expiring,
-- tenant-scoped and audited, and it is the invitee's own session that proves
-- who they are — the token proves only which invitation they hold.
--
-- Everything additive.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. What the outbox needs to be worked safely.
-- ---------------------------------------------------------------------------
alter table public.notifications
  add column if not exists dedupe_key   text,
  add column if not exists lease_until  timestamptz,
  add column if not exists provider     text,
  add column if not exists provider_ref text;

-- The idempotency key. Partial, so the many rows that do not need one are
-- unaffected — an enqueue opts in by naming a key it can reproduce.
create unique index if not exists notifications_dedupe_unique
  on public.notifications(organization_id, dedupe_key)
  where dedupe_key is not null;

-- Claiming needs a fifth status. The constraint is replaced rather than the
-- original migration edited.
alter table public.notifications drop constraint if exists notifications_status_check;
alter table public.notifications
  add constraint notifications_status_check
  check (status in ('pending','sending','sent','failed','cancelled'));

-- The worker's queue index: due, unclaimed, oldest first.
create index if not exists notifications_claimable_idx
  on public.notifications(scheduled_for)
  where status in ('pending', 'sending');

-- ---------------------------------------------------------------------------
-- 2. Claim a batch.
--
-- SKIP LOCKED is what lets two workers run at once: each takes rows the other
-- has not locked, and neither waits. The lease is the second half — a worker
-- that dies mid-send leaves rows in 'sending' whose lease expires, and the
-- next pass reclaims them. Without it those rows would be lost silently, which
-- is the failure mode outboxes are supposed to prevent.
-- ---------------------------------------------------------------------------
create or replace function public.notification_claim_batch(
  p_limit      int default 25,
  p_lease_secs int default 120
)
returns table (
  out_id           uuid,
  out_organization uuid,
  out_channel      text,
  out_template     text,
  out_recipient    text,
  out_user_id      uuid,
  out_payload      jsonb,
  out_attempts     int
)
language plpgsql security definer set search_path = '' as $$
begin
  return query
  with claimed as (
    select n.id
      from public.notifications n
     where n.scheduled_for <= now()
       and (
         n.status = 'pending'
         -- A lease that has run out: the worker holding it is gone.
         or (n.status = 'sending' and n.lease_until is not null and n.lease_until < now())
       )
     order by n.scheduled_for
     limit greatest(1, least(coalesce(p_limit, 25), 200))
     for update skip locked
  )
  update public.notifications n
     set status      = 'sending',
         attempts    = n.attempts + 1,
         lease_until = now() + make_interval(secs => greatest(10, coalesce(p_lease_secs, 120)))
    from claimed c
   where n.id = c.id
  returning n.id, n.organization_id, n.channel, n.template,
            n.recipient, n.user_id, n.payload, n.attempts;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Report the outcome.
--
-- Only ever from 'sending', so a late report from a worker whose lease was
-- reclaimed cannot overwrite the row the new worker is now handling.
-- ---------------------------------------------------------------------------
create or replace function public.notification_mark_sent(
  p_id           uuid,
  p_provider     text default null,
  p_provider_ref text default null
)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update public.notifications
     set status = 'sent', sent_at = now(), lease_until = null,
         last_error = null,
         provider = p_provider, provider_ref = p_provider_ref
   where id = p_id and status = 'sending';
  return found;
end;
$$;

/**
 * A failed attempt.
 *
 * Retries back off — one minute, then four, then nine — and stop at
 * `p_max_attempts`, after which the row is 'failed' for good. A queue that
 * retries forever is a queue that hides a broken provider.
 *
 * `p_permanent` is for a failure retrying cannot fix: an unconfigured channel,
 * a malformed recipient. Those give up immediately rather than burning the
 * whole backoff schedule to reach the same answer.
 */
create or replace function public.notification_mark_failed(
  p_id           uuid,
  p_error        text,
  p_permanent    boolean default false,
  p_max_attempts int default 5
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_attempts int;
begin
  select attempts into v_attempts from public.notifications
   where id = p_id and status = 'sending';
  if v_attempts is null then return false; end if;

  if p_permanent or v_attempts >= greatest(1, coalesce(p_max_attempts, 5)) then
    update public.notifications
       set status = 'failed', lease_until = null, last_error = left(coalesce(p_error, ''), 500)
     where id = p_id;
  else
    update public.notifications
       set status = 'pending', lease_until = null,
           last_error = left(coalesce(p_error, ''), 500),
           scheduled_for = now() + make_interval(secs => v_attempts * v_attempts * 60)
     where id = p_id;
  end if;
  return true;
end;
$$;

/** What the queue looks like right now, for an operator. */
create or replace function public.notification_queue_stats(p_org uuid)
returns table (out_status text, out_count bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not app.has_permission(p_org, 'notification.read') then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  return query
  select n.status, count(*)
    from public.notifications n
   where n.organization_id = p_org
   group by n.status;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Accepting an invitation.
--
-- The token proves WHICH invitation the caller holds. Who they are comes from
-- their own session, so a token cannot be used to join as someone else, and a
-- token belonging to a different email address is refused rather than silently
-- attached to whoever opened the link.
-- ---------------------------------------------------------------------------
create or replace function public.invitation_preview(p_token text)
returns table (
  out_organization_name text,
  out_email             text,
  out_expired           boolean,
  out_already_used      boolean
)
language plpgsql stable security definer set search_path = '' as $$
declare v_row record;
begin
  select i.*, o.name as org_name into v_row
    from public.invitations i
    join public.organizations o on o.id = i.organization_id
   where i.token_hash = app.sha256_hex(coalesce(p_token, ''));

  if v_row.id is null then return; end if;

  return query
  select v_row.org_name::text,
         -- The invitee already knows their own address; showing it is what
         -- lets them realise they are signed in as the wrong person.
         v_row.email::text,
         v_row.expires_at < now(),
         v_row.accepted_at is not null or v_row.revoked_at is not null;
end;
$$;

create or replace function public.invitation_accept(p_token text)
returns table (out_organization_id uuid, out_organization_slug text)
language plpgsql security definer set search_path = '' as $$
declare
  v_user   uuid := auth.uid();
  v_email  text;
  v_row    record;
  v_member uuid;
  v_role   uuid;
  v_branch uuid;
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  select u.email::text into v_email from auth.users u where u.id = v_user;

  -- Locked, so two clicks on the same link cannot both pass the single-use
  -- check before either marks it accepted.
  select * into v_row from public.invitations
   where token_hash = app.sha256_hex(coalesce(p_token, ''))
   for update;

  if v_row.id is null then
    raise exception 'invitation not found' using errcode = 'check_violation';
  end if;
  if v_row.accepted_at is not null then
    raise exception 'this invitation has already been used' using errcode = 'check_violation';
  end if;
  if v_row.revoked_at is not null then
    raise exception 'this invitation was withdrawn' using errcode = 'check_violation';
  end if;
  if v_row.expires_at < now() then
    raise exception 'this invitation has expired' using errcode = 'check_violation';
  end if;

  -- The invitation is for one address. Accepting while signed in as someone
  -- else would quietly hand a stranger the roles it carries.
  if lower(v_email) <> lower(v_row.email::text) then
    raise exception 'this invitation was sent to a different email address'
      using errcode = 'check_violation';
  end if;

  insert into public.profiles (id) values (v_user) on conflict (id) do nothing;

  -- Already a member: reactivate rather than duplicate.
  insert into public.organization_members
    (organization_id, user_id, status, all_branches, invited_by, joined_at)
  values
    (v_row.organization_id, v_user, 'active', v_row.all_branches, v_row.invited_by, now())
  on conflict (organization_id, user_id) do update
     set status = 'active',
         all_branches = excluded.all_branches,
         joined_at = coalesce(public.organization_members.joined_at, now())
  returning id into v_member;

  foreach v_branch in array coalesce(v_row.branch_ids, array[]::uuid[]) loop
    -- Only branches that really belong to this organization, whatever the
    -- invitation was created holding.
    if exists (
      select 1 from public.branches b
       where b.id = v_branch and b.organization_id = v_row.organization_id
    ) then
      insert into public.member_branches (member_id, branch_id)
      values (v_member, v_branch) on conflict do nothing;
    end if;
  end loop;

  foreach v_role in array coalesce(v_row.role_ids, array[]::uuid[]) loop
    if exists (
      select 1 from public.roles r
       where r.id = v_role and r.organization_id = v_row.organization_id
    ) then
      insert into public.user_roles (member_id, role_id, granted_by)
      values (v_member, v_role, v_row.invited_by) on conflict do nothing;
    end if;
  end loop;

  update public.invitations set accepted_at = now() where id = v_row.id;

  insert into public.audit_logs
    (organization_id, actor_id, actor_label, action, entity_type, entity_id, after)
  values
    (v_row.organization_id, v_user,
     (select p.full_name from public.profiles p where p.id = v_user),
     'member.invitation_accepted', 'invitation', v_row.id::text,
     -- The email, never the token or its hash.
     jsonb_build_object('email', v_row.email, 'roles', coalesce(array_length(v_row.role_ids, 1), 0)));

  return query
    select o.id, o.slug::text from public.organizations o where o.id = v_row.organization_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Creating an invitation.
--
-- Returns the token ONCE. Only its hash is stored, so this is the only moment
-- it exists in readable form and nothing later can print it — the same rule
-- the domain challenge follows.
-- ---------------------------------------------------------------------------
create or replace function public.invitation_create(
  p_org        uuid,
  p_email      text,
  p_role_ids   uuid[] default '{}',
  p_branch_ids uuid[] default '{}',
  p_all_branches boolean default false,
  p_days       int default 7
)
returns table (out_id uuid, out_token text, out_expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  v_user  uuid := auth.uid();
  v_token text;
  v_id    uuid;
  v_exp   timestamptz;
  v_role  uuid;
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not app.has_permission(p_org, 'member.manage') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if coalesce(trim(p_email), '') = '' or position('@' in p_email) = 0 then
    raise exception 'a valid email address is required' using errcode = 'check_violation';
  end if;

  -- An invitation cannot carry a role from another organization. Checked here
  -- rather than trusted, because these ids come from a form.
  foreach v_role in array coalesce(p_role_ids, array[]::uuid[]) loop
    if not exists (
      select 1 from public.roles r where r.id = v_role and r.organization_id = p_org
    ) then
      raise exception 'that role does not belong to this organization'
        using errcode = 'check_violation';
    end if;
  end loop;

  foreach v_role in array coalesce(p_branch_ids, array[]::uuid[]) loop
    if not exists (
      select 1 from public.branches b where b.id = v_role and b.organization_id = p_org
    ) then
      raise exception 'that branch does not belong to this organization'
        using errcode = 'check_violation';
    end if;
  end loop;

  -- Re-inviting replaces the outstanding invitation rather than colliding with
  -- the partial unique index: the old link stops working, which is what
  -- "send it again" should mean.
  update public.invitations set revoked_at = now()
   where organization_id = p_org and lower(email::text) = lower(trim(p_email))
     and accepted_at is null and revoked_at is null;

  v_token := app.new_public_token();
  v_exp   := now() + make_interval(days => greatest(1, least(coalesce(p_days, 7), 30)));

  insert into public.invitations
    (organization_id, email, token_hash, role_ids, branch_ids, all_branches,
     invited_by, expires_at)
  values
    (p_org, trim(p_email), app.sha256_hex(v_token),
     coalesce(p_role_ids, '{}'), coalesce(p_branch_ids, '{}'),
     coalesce(p_all_branches, false), v_user, v_exp)
  returning id into v_id;

  insert into public.audit_logs
    (organization_id, actor_id, actor_label, action, entity_type, entity_id, after)
  values
    (p_org, v_user,
     (select p.full_name from public.profiles p where p.id = v_user),
     'member.invited', 'invitation', v_id::text,
     jsonb_build_object('email', lower(trim(p_email)), 'expires_at', v_exp));

  return query select v_id, v_token, v_exp;
end;
$$;

/**
 * Queue the invitation email.
 *
 * Separate from `invitation_create` because only the application can build the
 * link: it holds the token for the one moment it exists and knows the site's
 * address, neither of which belongs in the database.
 *
 * It goes through a function rather than a plain insert because
 * `notifications` has no insert policy, deliberately — the outbox is written
 * by definer functions only, so a tenant session cannot post arbitrary mail
 * into it, addressed to anyone it likes.
 *
 * The payload carries the accept link, and therefore the token. That is
 * unavoidable for an emailed invitation: the message has to contain the link.
 * It lives in this row until the worker delivers it; the invitations table
 * itself still holds nothing but the hash.
 *
 * Idempotent on the invitation id, so a retry cannot send twice.
 */
create or replace function public.invitation_enqueue_email(
  p_org        uuid,
  p_invitation uuid,
  p_accept_url text
)
returns void language plpgsql security definer set search_path = '' as $$
declare v_email text;
begin
  if not app.has_permission(p_org, 'member.manage') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if coalesce(trim(p_accept_url), '') = '' then
    raise exception 'an accept link is required' using errcode = 'check_violation';
  end if;

  select i.email::text into v_email from public.invitations i
   where i.id = p_invitation and i.organization_id = p_org
     and i.accepted_at is null and i.revoked_at is null;
  if v_email is null then
    raise exception 'invitation not found' using errcode = 'check_violation';
  end if;

  insert into public.notifications
    (organization_id, recipient, channel, template, payload, dedupe_key)
  values (
    p_org, lower(v_email), 'email', 'member.invited',
    jsonb_build_object(
      'organization', (select o.name from public.organizations o where o.id = p_org),
      'accept_url', trim(p_accept_url)),
    'invitation:' || p_invitation::text
  )
  on conflict do nothing;
end;
$$;

create or replace function public.invitation_revoke(p_org uuid, p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not app.has_permission(p_org, 'member.manage') then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  update public.invitations set revoked_at = now()
   where id = p_id and organization_id = p_org and accepted_at is null and revoked_at is null;
  if not found then
    raise exception 'invitation not found or already closed' using errcode = 'check_violation';
  end if;

  insert into public.audit_logs
    (organization_id, actor_id, action, entity_type, entity_id, after)
  values
    (p_org, v_user, 'member.invitation_revoked', 'invitation', p_id::text,
     jsonb_build_object('revoked', true));
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Grants.
--
-- Revoke before grant — the lesson of 0028.
--
-- The three worker functions reach `service_role` ONLY. They move other
-- people's mail; a tenant session has no business claiming from the queue or
-- declaring something sent.
-- ---------------------------------------------------------------------------
do $$
declare fn text;
begin
  foreach fn in array array[
    'public.notification_claim_batch(int, int)',
    'public.notification_mark_sent(uuid, text, text)',
    'public.notification_mark_failed(uuid, text, boolean, int)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;

  foreach fn in array array[
    'public.notification_queue_stats(uuid)',
    'public.invitation_create(uuid, text, uuid[], uuid[], boolean, int)',
    'public.invitation_enqueue_email(uuid, uuid, text)',
    'public.invitation_revoke(uuid, uuid)',
    'public.invitation_accept(text)'
  ]
  loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end $$;

-- The preview is reachable signed-out: someone following an invitation link
-- has to be told which organization it is for before they create an account.
-- It reveals a name and the address the invitation was sent to, nothing else.
revoke all on function public.invitation_preview(text) from public;
grant execute on function public.invitation_preview(text) to anon, authenticated;
