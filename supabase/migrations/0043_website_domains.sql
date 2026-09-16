-- =============================================================================
-- LOCAL BASIC — 0043 Custom domains foundation
--
-- A restaurant may serve its published website on its own hostname. The
-- LocalBasic address keeps working; a custom domain is an additional public
-- entry point, never a replacement.
--
-- WHAT THIS LAYER OWNS
--
--   ownership   which organization a hostname belongs to, exclusively
--   state       pending → verified → active → disabled
--   proof       a DNS TXT challenge, stored only as a hash
--
-- What it deliberately does NOT own: TLS, certificates, DNS itself and the
-- reverse proxy. Vercel does those. A row here saying ACTIVE means "LocalBasic
-- will serve this organization for this hostname" — not that the domain is
-- reachable, which also needs the customer's DNS and the domain attached to
-- the deployment.
--
-- THE HOSTNAME IS THE IDENTITY
--
-- Every lookup, every constraint and every uniqueness guarantee is on the
-- normalized hostname: lower-cased, trailing dot removed, port removed. A
-- value that is not a plain hostname — a URL, a path, a scheme, whitespace —
-- cannot be stored at all.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Normalization.
--
-- One function, used by the constraint, the writers and the public resolver,
-- so "the same hostname" means the same thing everywhere. Returns null for
-- anything that is not a hostname, which the CHECK then rejects.
-- ---------------------------------------------------------------------------
create or replace function app.normalize_hostname(p_host text)
returns text language plpgsql immutable set search_path = '' as $$
declare v text;
begin
  v := lower(trim(coalesce(p_host, '')));
  if v = '' then
    return null;
  end if;

  -- A URL is not a hostname. Rejected rather than parsed: accepting
  -- "https://x.test/path" and quietly keeping part of it is how a resolver
  -- ends up matching something the operator never agreed to.
  if v ~ '://' or v like '%/%' or v like '%?%' or v like '%#%'
     or v ~ '[[:space:]]' or v like '%@%' then
    return null;
  end if;

  -- A port belongs to a request, not to an identity. Strip it so
  -- "example.test:3000" and "example.test" are the same domain.
  v := regexp_replace(v, ':[0-9]+$', '');

  -- A trailing dot is the fully-qualified form of the same name.
  v := regexp_replace(v, '\.$', '');

  if length(v) < 4 or length(v) > 253 then
    return null;
  end if;

  -- Labels: alphanumeric, inner hyphens allowed, at least one dot, and a
  -- final label that is alphabetic. Punycode (xn--) passes as ordinary
  -- labels; unicode hostnames must be converted before they arrive here.
  if v !~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,63}|xn--[a-z0-9-]{2,59})$' then
    return null;
  end if;

  return v;
end;
$$;

/**
 * SHA-256 as lowercase hex.
 *
 * pgcrypto lives in `extensions` on Supabase and in `public` on the local test
 * harness, so this names both — the same approach app.new_public_token() takes
 * in 0024. The callers below keep `search_path = ''` and go through here.
 */
create or replace function app.sha256_hex(p_value text)
returns text language sql immutable set search_path = extensions, public as $$
  select encode(digest(p_value, 'sha256'), 'hex');
$$;

-- ---------------------------------------------------------------------------
-- 2. The domain table.
--
-- `hostname` keeps what the customer typed, for display. `normalized_hostname`
-- is the identity, and the unique index is on that — so Example-Restaurant.com
-- and example-restaurant. are the same row, and a second organization cannot
-- claim either.
-- ---------------------------------------------------------------------------
create table public.restaurant_website_domains (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null references public.organizations(id) on delete cascade,
  hostname                text not null,
  normalized_hostname     text not null,
  status                  text not null default 'pending'
                          check (status in ('pending', 'verified', 'active', 'disabled')),
  -- One primary hostname per restaurant. A non-primary active domain redirects
  -- to it, which is how www and the bare domain settle on one address.
  is_primary              boolean not null default false,
  verification_method     text not null default 'dns_txt'
                          check (verification_method in ('dns_txt')),
  -- SHA-256 of the challenge value. The value itself is shown once, at
  -- creation, and never stored — so a database read cannot reveal it and it
  -- cannot leak through any projection.
  verification_token_hash text not null,
  verification_attempted_at timestamptz,
  verification_error      text,
  verified_at             timestamptz,
  activated_at            timestamptz,
  disabled_at             timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  created_by              uuid references public.profiles(id),
  constraint restaurant_website_domains_normalized
    check (normalized_hostname = app.normalize_hostname(hostname)
           and normalized_hostname is not null)
);

-- OWNERSHIP DECISION: the unique index covers every row whatever its status.
-- A disabled domain therefore stays reserved to the organization that added
-- it, and only an explicit remove frees the hostname. Releasing it on disable
-- would let one restaurant claim a competitor's domain during a lapse.
create unique index restaurant_website_domains_hostname_unique
  on public.restaurant_website_domains(normalized_hostname);

create index restaurant_website_domains_org_idx
  on public.restaurant_website_domains(organization_id, created_at);

-- The public resolver's index: active domains only, which is all it reads.
create index restaurant_website_domains_active_idx
  on public.restaurant_website_domains(normalized_hostname)
  where status = 'active';

create unique index restaurant_website_domains_one_primary
  on public.restaurant_website_domains(organization_id) where is_primary;

create trigger restaurant_website_domains_touch
  before update on public.restaurant_website_domains
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 3. The state machine.
--
-- Transitions are enumerated, not implied. A row cannot jump from pending to
-- active, and cannot be moved to another organization by an update.
-- ---------------------------------------------------------------------------
create or replace function app.check_website_domain()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if new.organization_id <> old.organization_id then
      raise exception 'a domain cannot be moved between organizations'
        using errcode = 'check_violation';
    end if;
    if new.normalized_hostname <> old.normalized_hostname then
      raise exception 'a domain''s hostname cannot be changed; remove it and add the new one'
        using errcode = 'check_violation';
    end if;

    if new.status <> old.status then
      -- pending  → verified            proof accepted
      -- verified → active | disabled   switched on, or abandoned
      -- active   → disabled            switched off
      -- disabled → verified            back to the ready state, re-activatable
      if not (
        (old.status = 'pending'  and new.status = 'verified')
        or (old.status = 'verified' and new.status in ('active', 'disabled'))
        or (old.status = 'active'   and new.status = 'disabled')
        or (old.status = 'disabled' and new.status = 'verified')
      ) then
        raise exception 'cannot move a domain from % to %', old.status, new.status
          using errcode = 'check_violation';
      end if;
    end if;
  end if;

  -- Activation requires proof. Belt and braces alongside the transition table:
  -- even a path that reached 'active' another way would be refused here.
  if new.status = 'active' and new.verified_at is null then
    raise exception 'a domain must be verified before it can be activated'
      using errcode = 'check_violation';
  end if;

  -- Only an active domain may be primary; a primary that is switched off
  -- stops being primary rather than leaving the redirect pointing at nothing.
  if new.is_primary and new.status <> 'active' then
    new.is_primary := false;
  end if;

  return new;
end;
$$;

create trigger restaurant_website_domains_check
  before insert or update on public.restaurant_website_domains
  for each row execute function app.check_website_domain();

-- ---------------------------------------------------------------------------
-- 4. RLS.
--
-- Enabled and forced. A domain record is tenant configuration: readable and
-- writable only by a member of the owning organization holding
-- `settings.manage`, the same permission that governs the website itself.
--
-- anon has no policy and no privilege. Public traffic reaches this table only
-- through the SECURITY DEFINER resolver below, which returns a slug and
-- nothing else.
-- ---------------------------------------------------------------------------
alter table public.restaurant_website_domains enable row level security;
alter table public.restaurant_website_domains force row level security;

create policy restaurant_website_domains_select on public.restaurant_website_domains
  for select to authenticated
  using (app.has_permission(organization_id, 'settings.manage'));

-- No insert, update or delete policy: every write goes through the functions
-- below, which own the state machine, the audit entry and the token.
revoke all on public.restaurant_website_domains from anon;
grant select on public.restaurant_website_domains to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Tenant context from a slug.
--
-- The browser names a restaurant by its public slug; the caller's own
-- membership decides whether that resolves to anything. There is no path here
-- that accepts an organization id.
-- ---------------------------------------------------------------------------
create or replace function app.domain_manageable_org(p_org_slug text)
returns uuid language sql stable security definer set search_path = '' as $$
  select o.id
  from public.organizations o
  join public.organization_modules m
    on m.organization_id = o.id and m.module_key = 'restaurant' and m.enabled
  where lower(o.slug::text) = lower(trim(p_org_slug))
    and o.status = 'active' and o.deleted_at is null
    and app.has_permission(o.id, 'settings.manage')
  limit 1;
$$;

-- ---------------------------------------------------------------------------
-- 6. Add a domain.
--
-- Returns the challenge value ONCE. Only its hash is stored, so this is the
-- only moment it exists in a readable form; nothing later can print it.
-- ---------------------------------------------------------------------------
create or replace function public.restaurant_domain_add(
  p_org_slug text,
  p_hostname text
)
returns table (out_id uuid, out_hostname text, out_token text)
language plpgsql security definer set search_path = '' as $$
declare
  v_org   uuid;
  v_norm  text;
  v_token text;
  v_id    uuid;
  v_count int;
begin
  v_org := app.domain_manageable_org(p_org_slug);
  if v_org is null then
    raise exception 'website not found' using errcode = 'check_violation';
  end if;

  v_norm := app.normalize_hostname(p_hostname);
  if v_norm is null then
    raise exception 'أدخل اسم نطاق صالح مثل example.com' using errcode = '22023';
  end if;

  -- A modest ceiling. A restaurant needs a domain and its www alias, not a
  -- portfolio.
  select count(*) into v_count
  from public.restaurant_website_domains where organization_id = v_org;
  if v_count >= 5 then
    raise exception 'وصلت للحد الأقصى من النطاقات' using errcode = 'check_violation';
  end if;

  v_token := app.new_public_token();

  begin
    insert into public.restaurant_website_domains
      (organization_id, hostname, normalized_hostname, verification_token_hash, created_by)
    values (v_org, v_norm, v_norm,
            app.sha256_hex(v_token), auth.uid())
    returning id into v_id;
  exception when unique_violation then
    -- Deliberately the same message whether the hostname belongs to this
    -- restaurant or another one: the reply must not become a way to discover
    -- which of our customers owns a domain.
    raise exception 'هذا النطاق مستخدم بالفعل' using errcode = 'check_violation';
  end;

  insert into public.audit_logs
    (organization_id, branch_id, actor_id, actor_label, action,
     entity_type, entity_id, after)
  values (
    v_org, null, auth.uid(),
    (select p.full_name from public.profiles p where p.id = auth.uid()),
    'restaurant.domain_added', 'website_domain', v_id::text,
    -- The hostname is not a secret; the token is, and is absent here.
    jsonb_build_object('hostname', v_norm, 'status', 'pending')
  );

  return query select v_id, v_norm, v_token;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Record a verification outcome.
--
-- The caller passes the TXT values its DNS lookup actually returned; this
-- compares their hashes against the stored one. The database never takes a
-- "verified" flag from anybody — it re-derives the answer.
--
-- Every attempt is recorded, successful or not, so a domain that flips to
-- verified always has a timestamped attempt behind it.
-- ---------------------------------------------------------------------------
create or replace function public.restaurant_domain_record_verification(
  p_org_slug   text,
  p_domain_id  uuid,
  p_txt_values text[],
  p_error      text default null
)
returns table (out_status text, out_verified boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_org     uuid;
  v_row     record;
  v_match   boolean := false;
  v_value   text;
begin
  v_org := app.domain_manageable_org(p_org_slug);
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
    v_org, null, auth.uid(),
    (select p.full_name from public.profiles p where p.id = auth.uid()),
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
-- 8. Activate, disable, remove, and choose the primary.
-- ---------------------------------------------------------------------------
create or replace function public.restaurant_domain_set_status(
  p_org_slug  text,
  p_domain_id uuid,
  p_status    text
)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_org  uuid;
  v_row  record;
begin
  if p_status not in ('active', 'disabled') then
    raise exception 'حالة غير معروفة' using errcode = '22023';
  end if;

  v_org := app.domain_manageable_org(p_org_slug);
  if v_org is null then
    raise exception 'website not found' using errcode = 'check_violation';
  end if;

  select * into v_row from public.restaurant_website_domains d
   where d.id = p_domain_id and d.organization_id = v_org;
  if v_row.id is null then
    raise exception 'النطاق غير موجود' using errcode = 'check_violation';
  end if;

  if p_status = 'active' then
    if v_row.verified_at is null then
      raise exception 'يجب توثيق النطاق قبل تفعيله' using errcode = 'check_violation';
    end if;
    update public.restaurant_website_domains
       set status = 'active', activated_at = now(), disabled_at = null
     where id = p_domain_id;
  else
    update public.restaurant_website_domains
       set status = 'disabled', disabled_at = now(), is_primary = false
     where id = p_domain_id;
  end if;

  insert into public.audit_logs
    (organization_id, branch_id, actor_id, actor_label, action,
     entity_type, entity_id, before, after)
  values (
    v_org, null, auth.uid(),
    (select p.full_name from public.profiles p where p.id = auth.uid()),
    case when p_status = 'active' then 'restaurant.domain_activated'
         else 'restaurant.domain_disabled' end,
    'website_domain', p_domain_id::text,
    jsonb_build_object('status', v_row.status),
    jsonb_build_object('hostname', v_row.normalized_hostname, 'status', p_status)
  );
end;
$$;

/**
 * Make one active domain the canonical address.
 *
 * Every other active domain of the same restaurant then redirects here, which
 * is how a bare domain and its www alias settle on one address without a loop:
 * the primary never redirects.
 */
create or replace function public.restaurant_domain_set_primary(
  p_org_slug text, p_domain_id uuid
) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_row record;
begin
  v_org := app.domain_manageable_org(p_org_slug);
  if v_org is null then
    raise exception 'website not found' using errcode = 'check_violation';
  end if;

  select * into v_row from public.restaurant_website_domains d
   where d.id = p_domain_id and d.organization_id = v_org;
  if v_row.id is null or v_row.status <> 'active' then
    raise exception 'يمكن اختيار نطاق مفعّل فقط' using errcode = 'check_violation';
  end if;

  update public.restaurant_website_domains set is_primary = false
   where organization_id = v_org and is_primary;
  update public.restaurant_website_domains set is_primary = true
   where id = p_domain_id;
end;
$$;

/**
 * Remove a domain, releasing the hostname.
 *
 * The only operation that frees a hostname for another organization to claim,
 * and therefore the only one an operator should think twice about.
 */
create or replace function public.restaurant_domain_remove(
  p_org_slug text, p_domain_id uuid
) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_row record;
begin
  v_org := app.domain_manageable_org(p_org_slug);
  if v_org is null then
    raise exception 'website not found' using errcode = 'check_violation';
  end if;

  select * into v_row from public.restaurant_website_domains d
   where d.id = p_domain_id and d.organization_id = v_org;
  if v_row.id is null then
    return;
  end if;

  delete from public.restaurant_website_domains where id = p_domain_id;

  insert into public.audit_logs
    (organization_id, branch_id, actor_id, actor_label, action,
     entity_type, entity_id, before)
  values (
    v_org, null, auth.uid(),
    (select p.full_name from public.profiles p where p.id = auth.uid()),
    'restaurant.domain_removed', 'website_domain', p_domain_id::text,
    jsonb_build_object('hostname', v_row.normalized_hostname, 'status', v_row.status)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. The tenant's own list.
--
-- Note what is absent: verification_token_hash. The hash is useless to an
-- attacker but there is no reason for it to travel, and a projection that
-- never carries it cannot leak it.
-- ---------------------------------------------------------------------------
create or replace function public.restaurant_domains_list(p_org_slug text)
returns table (
  id                  uuid,
  hostname            text,
  status              text,
  is_primary          boolean,
  verification_method text,
  verification_attempted_at timestamptz,
  verification_error  text,
  verified_at         timestamptz,
  activated_at        timestamptz,
  created_at          timestamptz
)
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid;
begin
  v_org := app.domain_manageable_org(p_org_slug);
  if v_org is null then
    return;
  end if;

  return query
  select d.id, d.normalized_hostname, d.status, d.is_primary, d.verification_method,
         d.verification_attempted_at, d.verification_error, d.verified_at,
         d.activated_at, d.created_at
  from public.restaurant_website_domains d
  where d.organization_id = v_org
  order by d.created_at;
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. THE PUBLIC RESOLVER.
--
-- The whole runtime surface of this feature, and the narrowest thing that can
-- do the job: a hostname in, a slug out.
--
--   * ACTIVE only. A pending, verified or disabled domain resolves to nothing,
--     so a row existing is never enough to route traffic.
--   * Gated on the same published-website check every other public function
--     uses, so switching the website off takes the custom domain down too.
--   * Returns no organization id, no domain id, no status and no token —
--     only what the renderer needs.
--
-- `redirect_to` is set when this hostname is active but another active domain
-- of the same restaurant is the primary. The primary itself always returns
-- null, so a redirect can never loop.
-- ---------------------------------------------------------------------------
create or replace function public.restaurant_domain_resolve(p_hostname text)
returns table (org_slug text, redirect_to text)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_norm text;
  v_org  uuid;
  v_self boolean;
begin
  v_norm := app.normalize_hostname(p_hostname);
  if v_norm is null then
    return;
  end if;

  select d.organization_id, d.is_primary into v_org, v_self
  from public.restaurant_website_domains d
  where d.normalized_hostname = v_norm and d.status = 'active'
  limit 1;

  if v_org is null then
    return;
  end if;

  return query
  select o.slug::text,
         case
           when v_self then null
           else (select p.normalized_hostname
                   from public.restaurant_website_domains p
                  where p.organization_id = v_org and p.is_primary
                    and p.status = 'active'
                  limit 1)
         end
  from public.organizations o
  join public.organization_modules m
    on m.organization_id = o.id and m.module_key = 'restaurant' and m.enabled
  where o.id = v_org
    and o.status = 'active' and o.deleted_at is null
    -- The website switch governs the custom domain exactly as it governs the
    -- LocalBasic address.
    and coalesce(
      (select (s.value #>> '{}')::boolean from public.settings s
        where s.organization_id = o.id and s.branch_id is null
          and s.key = 'restaurant.website_enabled'),
      false);
end;
$$;

-- ---------------------------------------------------------------------------
-- 11. Platform Admin: read-only.
--
-- The operator needs to answer "why is this customer's domain not working".
-- They do not need, and do not get, a way to change it — domain management
-- stays with the tenant, and Platform Admin gains no tenant permission here.
-- ---------------------------------------------------------------------------
create or replace function public.platform_customer_domains(p_customer_code text)
returns table (
  hostname     text,
  status       text,
  is_primary   boolean,
  verified_at  timestamptz,
  activated_at timestamptz,
  created_at   timestamptz
)
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid;
begin
  perform app.require_platform_admin();
  v_org := app.platform_customer_org(p_customer_code);
  if v_org is null then
    return;
  end if;

  return query
  select d.normalized_hostname, d.status, d.is_primary,
         d.verified_at, d.activated_at, d.created_at
  from public.restaurant_website_domains d
  where d.organization_id = v_org
  order by d.created_at;
end;
$$;

-- ---------------------------------------------------------------------------
-- 12. Grants.
--
-- PUBLIC first — Postgres grants EXECUTE to PUBLIC on creation and a later
-- grant would not take it away (the lesson of 0028).
--
-- Only the resolver is anonymous, because only the resolver serves public
-- traffic. Everything that manages a domain is `authenticated` and re-checks
-- the permission inside.
-- ---------------------------------------------------------------------------
revoke all on function app.normalize_hostname(text)     from public, anon;
revoke all on function app.sha256_hex(text)             from public, anon, authenticated;
revoke all on function app.check_website_domain()       from public, anon, authenticated;
revoke all on function app.domain_manageable_org(text)  from public, anon, authenticated;
-- The normalizer is a pure function of its argument and is used by the table
-- CHECK, so the writing role must be able to execute it.
grant execute on function app.normalize_hostname(text) to authenticated;

do $$
declare fn text;
begin
  foreach fn in array array[
    'public.restaurant_domain_add(text, text)',
    'public.restaurant_domain_record_verification(text, uuid, text[], text)',
    'public.restaurant_domain_set_status(text, uuid, text)',
    'public.restaurant_domain_set_primary(text, uuid)',
    'public.restaurant_domain_remove(text, uuid)',
    'public.restaurant_domains_list(text)',
    'public.platform_customer_domains(text)'
  ]
  loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end $$;

revoke all on function public.restaurant_domain_resolve(text) from public;
grant execute on function public.restaurant_domain_resolve(text) to anon, authenticated;
