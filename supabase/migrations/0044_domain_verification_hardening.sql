-- ---------------------------------------------------------------------------
-- 0044 — Harden DNS verification.
--
-- 0043 left one hole open, and it is recorded here rather than quietly fixed:
-- `restaurant_domain_record_verification` was granted to `authenticated`, and
-- it accepted the observed TXT values as an argument. A tenant who knew their
-- own challenge — and they do, it is shown to them once — could call it over
-- PostgREST and hand back the challenge without ever publishing a DNS record.
-- The blast radius was squatting rather than takeover, but "verified" is a
-- claim the product makes on the strength of DNS, and it must be true.
--
-- After this migration the observed values can only come from a server-side
-- lookup, because the only role that may execute the write is `service_role`.
--
-- Two functions replace one:
--
--   restaurant_domain_verification_target  tenant-callable, read-only.
--       Answers "which hostname should I look up for this domain?" using the
--       CALLER'S OWN session, so `settings.manage` and the organization fence
--       are checked against a real user. It returns the hostname from the
--       table, never from the browser — which also closes a second hole: the
--       old flow took the hostname from a form field, so a tenant could point
--       the lookup at a name they controlled while verifying one they did not.
--
--   restaurant_domain_record_verification  service-role only, write.
--       Takes the values the server observed. It cannot check a session
--       because there is no session on this path, so it re-checks the fence
--       structurally: the domain row must belong to the organization named.
--
-- Everything else — the hash-only storage, the state machine, the audit row —
-- is unchanged.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Organization by slug, without a permission check.
--
-- The permission check lives in `app.domain_manageable_org`, which reads
-- auth.uid(). On the trusted path there is no auth.uid() to read: the caller
-- is the service role, and authorization already happened in the request that
-- reached it. This resolves the slug and nothing more, so it stays private to
-- the `app` schema and is granted to nobody.
-- ---------------------------------------------------------------------------
create or replace function app.domain_org_by_slug(p_org_slug text)
returns uuid language sql stable security definer set search_path = '' as $$
  select o.id
  from public.organizations o
  join public.organization_modules m
    on m.organization_id = o.id and m.module_key = 'restaurant' and m.enabled
  where lower(o.slug::text) = lower(trim(p_org_slug))
    and o.status = 'active' and o.deleted_at is null
  limit 1;
$$;

-- ---------------------------------------------------------------------------
-- 2. What to look up — the tenant-callable half.
--
-- Read-only, and the only thing it discloses is a hostname the caller already
-- typed in. It does NOT return the token hash, and there is no projection
-- anywhere that does.
--
-- A domain belonging to another organization produces zero rows, which is the
-- same answer as a domain that does not exist. The server action treats an
-- empty result as "nothing to verify" and never reaches the trusted write.
-- ---------------------------------------------------------------------------
create or replace function public.restaurant_domain_verification_target(
  p_org_slug  text,
  p_domain_id uuid
)
returns table (out_hostname text, out_challenge_name text)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_org uuid;
begin
  v_org := app.domain_manageable_org(p_org_slug);
  if v_org is null then
    return;
  end if;

  return query
    select d.normalized_hostname,
           '_localbasic.' || d.normalized_hostname
      from public.restaurant_website_domains d
     where d.id = p_domain_id and d.organization_id = v_org;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Record the outcome — the trusted half.
--
-- Dropped and recreated rather than replaced: the signature gains an actor,
-- and leaving both signatures in place would give PostgREST two overloads to
-- choose between — one of them the old, reachable one.
-- ---------------------------------------------------------------------------
drop function if exists public.restaurant_domain_record_verification(text, uuid, text[], text);

create or replace function public.restaurant_domain_record_verification(
  p_org_slug   text,
  p_domain_id  uuid,
  p_txt_values text[],
  p_error      text default null,
  p_actor_id   uuid default null
)
returns table (out_status text, out_verified boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_org     uuid;
  v_row     record;
  v_match   boolean := false;
  v_value   text;
begin
  -- The fence, structurally: the slug must resolve, and the domain must be
  -- that organization's. Permission was checked by the request that got here,
  -- against the caller's own session; this is the second lock, not the first.
  v_org := app.domain_org_by_slug(p_org_slug);
  if v_org is null then
    raise exception 'website not found' using errcode = 'check_violation';
  end if;

  select * into v_row from public.restaurant_website_domains d
   where d.id = p_domain_id and d.organization_id = v_org;
  if v_row.id is null then
    raise exception 'النطاق غير موجود' using errcode = 'check_violation';
  end if;

  foreach v_value in array coalesce(p_txt_values, array[]::text[]) loop
    -- DNS providers hand back TXT values with or without surrounding quotes.
    if app.sha256_hex(trim(both '"' from trim(v_value))) = v_row.verification_token_hash then
      v_match := true;
    end if;
  end loop;

  if v_match then
    update public.restaurant_website_domains
       set verified_at = coalesce(verified_at, now()),
           verification_attempted_at = now(),
           verification_error = null,
           -- A domain already active stays active; one that was pending or
           -- disabled lands on verified, ready to be switched on.
           status = case when status = 'active' then 'active' else 'verified' end
     where id = p_domain_id;
  else
    update public.restaurant_website_domains
       set verification_attempted_at = now(),
           verification_error = left(coalesce(p_error, 'لم يُعثر على سجل TXT مطابق'), 300)
     where id = p_domain_id;
  end if;

  insert into public.audit_logs
    (organization_id, branch_id, actor_id, actor_label, action,
     entity_type, entity_id, after)
  values (
    v_org, null,
    -- auth.uid() is null on the trusted path, so the actor travels explicitly.
    coalesce(p_actor_id, auth.uid()),
    (select p.full_name from public.profiles p
      where p.id = coalesce(p_actor_id, auth.uid())),
    'restaurant.domain_verification_attempted', 'website_domain', p_domain_id::text,
    -- The outcome and the hostname. Never the values that were looked up:
    -- one of them may be the challenge itself.
    jsonb_build_object('hostname', v_row.normalized_hostname, 'verified', v_match)
  );

  return query
    select d.status, v_match from public.restaurant_website_domains d where d.id = p_domain_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Grants.
--
-- PostgreSQL grants EXECUTE to PUBLIC when a function is created, so every
-- revoke below has to come before any grant — the lesson of 0028.
--
-- The write is reachable by `service_role` and by nobody else. `authenticated`
-- losing it is the entire point of this migration.
-- ---------------------------------------------------------------------------
revoke all on function app.domain_org_by_slug(text)
  from public, anon, authenticated, service_role;

revoke all on function public.restaurant_domain_verification_target(text, uuid)
  from public, anon;
grant execute on function public.restaurant_domain_verification_target(text, uuid)
  to authenticated;

revoke all on function public.restaurant_domain_record_verification(text, uuid, text[], text, uuid)
  from public, anon, authenticated;
grant execute on function public.restaurant_domain_record_verification(text, uuid, text[], text, uuid)
  to service_role;
