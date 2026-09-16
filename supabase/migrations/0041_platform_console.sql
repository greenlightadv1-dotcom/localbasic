-- =============================================================================
-- LOCAL BASIC — 0041 Platform console
--
-- The read surface behind the Platform Admin screens. It adds no billing
-- logic: quoting, renewing, provisioning and onboarding all still run through
-- 0032 and 0034, and nothing here writes to a subscription.
--
-- Two things drive this migration.
--
-- FIRST, the operator needs to find a customer by whatever the caller on the
-- phone happens to know — a customer code, the restaurant's name, the owner's
-- email, a phone number. The previous search built a PostgREST `or=` filter by
-- string interpolation, which is a query language accepting a value it did not
-- quote: a term containing a comma or a dot could add filter expressions of
-- its own. Only a platform admin could reach it, and a platform admin may
-- already read every organization, so nothing was exposed — but a filter
-- assembled by concatenation is a bug waiting for a wider caller. Search now
-- happens here, where the term is a bound parameter and can only ever be a
-- value.
--
-- SECOND, the customer profile needs the operational picture in one place:
-- owner, services, branches, website state, audit. Each is a narrow explicit
-- projection rather than a table read, so the screens never hold a handle on
-- tenant data beyond what they display.
--
-- Every function calls app.require_platform_admin() itself. The TypeScript
-- gate in front of them is for a clean 404; this is the boundary.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Resolve a customer code, for an admin only.
--
-- Returns null for a code that does not exist AND for a caller who is not an
-- admin, so every function built on it fails the same way for both.
-- ---------------------------------------------------------------------------
create or replace function app.platform_customer_org(p_customer_code text)
returns uuid language sql stable security definer set search_path = '' as $$
  select o.id
  from public.organizations o
  where app.is_platform_admin()
    and upper(o.customer_code) = upper(trim(p_customer_code))
  limit 1;
$$;

-- ---------------------------------------------------------------------------
-- 2. Make a search term safe to use as a LIKE pattern.
--
-- Not a security control — the term is already a bound value and cannot be
-- SQL. This is about behaviour: without it a customer typing `%` matches every
-- customer, and a slug containing `_` matches slugs that differ from it.
-- ---------------------------------------------------------------------------
create or replace function app.like_literal(p_term text)
returns text language sql immutable set search_path = '' as $$
  select replace(replace(replace(p_term, '\', '\\'), '%', '\%'), '_', '\_');
$$;

-- ---------------------------------------------------------------------------
-- 3. Customer search.
--
-- One box over five fields. An empty term lists the most recent customers,
-- which is what an operator opening the screen wants to see.
--
-- The owner comes from organizations.owner_user_id, falling back to the member
-- holding the owner role — the two agree for every workspace provisioning
-- creates, and the fallback covers an owner transferred by a later flow.
-- ---------------------------------------------------------------------------
create or replace function public.platform_search_customers(
  p_query text default null,
  p_limit int default 100
)
returns table (
  organization_id     uuid,
  customer_code       text,
  name                text,
  slug                text,
  primary_module      text,
  org_status          text,
  created_at          timestamptz,
  owner_name          text,
  owner_email         text,
  contact_phone       text,
  plan_key            text,
  plan_name_ar        text,
  subscription_status text,
  billing_period      text,
  current_period_end  timestamptz,
  days_left           int
)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_pattern text;
begin
  perform app.require_platform_admin();

  v_pattern := case
    when nullif(trim(coalesce(p_query, '')), '') is null then null
    else '%' || app.like_literal(trim(p_query)) || '%'
  end;

  return query
  select
    o.id, o.customer_code, o.name, o.slug::text, o.primary_module, o.status,
    o.created_at,
    owner.full_name,
    owner.email,
    -- The number an operator would actually ring: the restaurant's published
    -- contact first, then the owner's, then the first branch's.
    coalesce(bs.phone, owner.phone, branch.phone),
    p.key, p.name_ar, s.status, s.billing_period, s.current_period_end,
    floor(extract(epoch from (s.current_period_end - now())) / 86400)::int
  from public.organizations o
  left join lateral (
    select u.email::text as email, pr.full_name, pr.phone
    from auth.users u
    left join public.profiles pr on pr.id = u.id
    where u.id = coalesce(
      o.owner_user_id,
      (select m.user_id
         from public.organization_members m
         join public.user_roles ur on ur.member_id = m.id
         join public.roles r on r.id = ur.role_id and r.is_owner
        where m.organization_id = o.id and m.status = 'active'
        order by m.joined_at nulls last, m.created_at
        limit 1)
    )
    limit 1
  ) owner on true
  left join public.branding_settings bs on bs.organization_id = o.id
  left join lateral (
    select b.phone from public.branches b
    where b.organization_id = o.id and b.is_active and b.deleted_at is null
      and b.phone is not null
    order by b.created_at
    limit 1
  ) branch on true
  left join lateral (
    select sub.* from public.subscriptions sub
    where sub.organization_id = o.id
      and sub.status in ('trialing', 'active', 'past_due')
    order by sub.current_period_end desc
    limit 1
  ) s on true
  left join public.plans p on p.id = s.plan_id
  where o.deleted_at is null
    and (
      v_pattern is null
      or o.customer_code ilike v_pattern
      or o.name          ilike v_pattern
      or o.slug::text    ilike v_pattern
      or owner.email     ilike v_pattern
      or owner.full_name ilike v_pattern
      or coalesce(bs.phone, owner.phone, branch.phone) ilike v_pattern
    )
  order by o.created_at desc
  limit greatest(1, least(coalesce(p_limit, 100), 200));
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. One customer, in full.
--
-- The operational header: who they are, who owns it, what they run, what state
-- their public website is in. Everything a support call needs and nothing an
-- operator has no business reading — no menu, no orders, no customers of the
-- customer.
-- ---------------------------------------------------------------------------
create or replace function public.platform_customer_profile(p_customer_code text)
returns table (
  organization_id     uuid,
  customer_code       text,
  name                text,
  slug                text,
  primary_module      text,
  org_status          text,
  country             text,
  currency            char(3),
  timezone            text,
  created_at          timestamptz,
  owner_name          text,
  owner_email         text,
  owner_phone         text,
  display_name        text,
  logo_url            text,
  primary_color       text,
  white_label         boolean,
  contact_phone       text,
  contact_whatsapp    text,
  contact_email       text,
  website_enabled     boolean,
  ordering_enabled    boolean,
  branch_count        int,
  plan_key            text,
  plan_name_ar        text,
  subscription_status text,
  billing_period      text,
  current_period_start timestamptz,
  current_period_end  timestamptz,
  days_left           int
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
  select
    o.id, o.customer_code, o.name, o.slug::text, o.primary_module, o.status,
    o.country, o.currency, o.timezone, o.created_at,
    owner.full_name, owner.email, owner.phone,
    bs.display_name, bs.logo_url,
    coalesce(bs.primary_color, '#1E2FC8'),
    coalesce(bs.white_label, false),
    bs.phone, bs.whatsapp, bs.email::text,
    -- Read from the same settings the public site reads, so what the operator
    -- sees here is what a visitor would find.
    coalesce((select (st.value #>> '{}')::boolean from public.settings st
               where st.organization_id = o.id and st.branch_id is null
                 and st.key = 'restaurant.website_enabled'), false),
    coalesce((select (st.value #>> '{}')::boolean from public.settings st
               where st.organization_id = o.id and st.branch_id is null
                 and st.key = 'restaurant.online_ordering_enabled'), false),
    (select count(*)::int from public.branches b
      where b.organization_id = o.id and b.deleted_at is null),
    p.key, p.name_ar, s.status, s.billing_period,
    s.current_period_start, s.current_period_end,
    floor(extract(epoch from (s.current_period_end - now())) / 86400)::int
  from public.organizations o
  left join lateral (
    select u.email::text as email, pr.full_name, pr.phone
    from auth.users u
    left join public.profiles pr on pr.id = u.id
    where u.id = coalesce(
      o.owner_user_id,
      (select m.user_id
         from public.organization_members m
         join public.user_roles ur on ur.member_id = m.id
         join public.roles r on r.id = ur.role_id and r.is_owner
        where m.organization_id = o.id and m.status = 'active'
        order by m.joined_at nulls last, m.created_at
        limit 1)
    )
    limit 1
  ) owner on true
  left join public.branding_settings bs on bs.organization_id = o.id
  left join lateral (
    select sub.* from public.subscriptions sub
    where sub.organization_id = o.id
      and sub.status in ('trialing', 'active', 'past_due')
    order by sub.current_period_end desc
    limit 1
  ) s on true
  left join public.plans p on p.id = s.plan_id
  where o.id = v_org;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Branches. No branch ids: the console displays them, it does not act on
--    them, and an id it never receives is an id it cannot leak.
-- ---------------------------------------------------------------------------
create or replace function public.platform_customer_branches(p_customer_code text)
returns table (
  slug       text,
  name       text,
  address    text,
  phone      text,
  is_active  boolean,
  created_at timestamptz
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
  select b.slug::text, b.name, b.address, b.phone, b.is_active, b.created_at
  from public.branches b
  where b.organization_id = v_org and b.deleted_at is null
  order by b.created_at;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Enabled services, named from the sellable catalogue.
-- ---------------------------------------------------------------------------
create or replace function public.platform_customer_modules(p_customer_code text)
returns table (
  module_key text,
  name_ar    text,
  is_primary boolean,
  enabled    boolean
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
  select m.module_key, coalesce(ps.name_ar, m.module_key), m.is_primary, m.enabled
  from public.organization_modules m
  left join public.platform_services ps on ps.module_key = m.module_key
  where m.organization_id = v_org
  order by m.is_primary desc, m.module_key;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. This customer's activity.
--
-- The whole audit trail for one organization, platform and tenant events
-- alike, because a support call is usually about something a member of staff
-- did. `before`/`after` are deliberately absent: they can carry arbitrary row
-- snapshots, and the console shows a timeline, not a data export.
-- ---------------------------------------------------------------------------
create or replace function public.platform_customer_audit(
  p_customer_code text,
  p_limit int default 50
)
returns table (
  created_at  timestamptz,
  action      text,
  entity_type text,
  actor_label text
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
  select a.created_at, a.action, a.entity_type, a.actor_label
  from public.audit_logs a
  where a.organization_id = v_org
  order by a.created_at desc
  limit greatest(1, least(coalesce(p_limit, 50), 200));
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Dashboard counters.
--
-- Computed here, in one pass, from the same columns the customer list reads.
-- There is no stored "expiring" flag and no cached total: every number on the
-- dashboard is counted at the moment it is shown.
-- ---------------------------------------------------------------------------
create or replace function public.platform_dashboard_stats(p_warning_days int default 3)
returns table (
  total_customers   int,
  active_customers  int,
  trialing          int,
  expiring_soon     int,
  expired           int,
  without_subscription int,
  branches_total    int
)
language plpgsql stable security definer set search_path = '' as $$
declare v_days int := greatest(0, coalesce(p_warning_days, 3));
begin
  perform app.require_platform_admin();

  return query
  with live as (
    select o.id,
           (select sub.status from public.subscriptions sub
             where sub.organization_id = o.id
               and sub.status in ('trialing', 'active', 'past_due')
             order by sub.current_period_end desc limit 1) as status,
           (select sub.current_period_end from public.subscriptions sub
             where sub.organization_id = o.id
               and sub.status in ('trialing', 'active', 'past_due')
             order by sub.current_period_end desc limit 1) as ends_at
    from public.organizations o
    where o.deleted_at is null
  )
  select
    count(*)::int,
    count(*) filter (where status = 'active')::int,
    count(*) filter (where status = 'trialing')::int,
    -- Expiring: still running, but inside the warning window.
    count(*) filter (
      where ends_at is not null
        and ends_at >= now()
        and ends_at <= now() + make_interval(days => v_days))::int,
    count(*) filter (where ends_at is not null and ends_at < now())::int,
    count(*) filter (where status is null)::int,
    (select count(*)::int from public.branches b
      join public.organizations o2 on o2.id = b.organization_id
     where b.deleted_at is null and o2.deleted_at is null)
  from live;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Recent platform activity, with the customer it concerns.
--
-- Platform events only. Tenant traffic belongs on a customer's own timeline,
-- not on the operator's home screen.
-- ---------------------------------------------------------------------------
create or replace function public.platform_recent_activity(p_limit int default 15)
returns table (
  created_at    timestamptz,
  action        text,
  actor_label   text,
  customer_code text,
  customer_name text
)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_platform_admin();

  return query
  select a.created_at, a.action, a.actor_label, o.customer_code, o.name
  from public.audit_logs a
  left join public.organizations o on o.id = a.organization_id
  where a.action like 'platform.%'
  order by a.created_at desc
  limit greatest(1, least(coalesce(p_limit, 15), 100));
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Grants.
--
-- PUBLIC first — Postgres grants EXECUTE to PUBLIC on creation, and a later
-- grant to `authenticated` would not take that away (0028). anon gets none of
-- these: an anonymous caller has no admin identity to check.
--
-- The `app.` helpers are revoked from every client role. They are reachable
-- only from the definer functions above.
-- ---------------------------------------------------------------------------
revoke all on function app.platform_customer_org(text) from public, anon, authenticated;
revoke all on function app.like_literal(text)           from public, anon, authenticated;

do $$
declare fn text;
begin
  foreach fn in array array[
    'public.platform_search_customers(text, int)',
    'public.platform_customer_profile(text)',
    'public.platform_customer_branches(text)',
    'public.platform_customer_modules(text)',
    'public.platform_customer_audit(text, int)',
    'public.platform_dashboard_stats(int)',
    'public.platform_recent_activity(int)'
  ]
  loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end $$;
