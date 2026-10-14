-- ---------------------------------------------------------------------------
-- 0100: abuse limits enforced INSIDE the database, plus grant hardening.
--
-- Why here and not only in Next.js. The app's limiter (src/lib/rate-limit.ts)
-- is in-memory per serverless instance, and every anonymous function below is
-- also reachable directly through Supabase's REST API with the public anon
-- key, which never passes through Next.js at all. A limit that has to hold
-- must therefore live where the write happens.
--
-- Keys are the TARGET of the abuse (a store, a phone number, a device), not
-- the caller's IP: guest traffic reaches the database from Vercel's shared
-- egress addresses, so an IP key would lump every guest together. Keys are
-- stored only as sha256 hashes, so the table is not a list of phone numbers.
--
-- A refused call raises SQLSTATE 'LB429' with a user-safe Arabic message; the
-- app maps that code to its rate_limited error. Because the raise aborts the
-- statement, a refused attempt does not itself count — the counter sits at the
-- limit until the window rolls over.
--
-- Fixed windows (simple, one row per bucket/key/window). A burst can straddle
-- a boundary and get up to 2x the limit briefly; the limits are sized so that
-- does not matter.
-- ---------------------------------------------------------------------------

create table app.rate_limit_hits (
  bucket       text        not null,
  key_hash     text        not null,
  window_start timestamptz not null,
  hits         int         not null default 1,
  primary key (bucket, key_hash, window_start)
);
create index rate_limit_hits_window_idx on app.rate_limit_hits(window_start);
alter table app.rate_limit_hits enable row level security;
alter table app.rate_limit_hits force row level security;
revoke all on app.rate_limit_hits from public, anon, authenticated;

create or replace function app.rate_limit(p_bucket text, p_key text, p_limit int, p_window_seconds int)
returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_start timestamptz;
  v_hits  int;
begin
  if p_key is null or length(p_key) = 0 then
    return;
  end if;
  v_start := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);

  insert into app.rate_limit_hits as h (bucket, key_hash, window_start, hits)
  values (p_bucket, app.sha256_hex(p_bucket || ':' || p_key), v_start, 1)
  on conflict (bucket, key_hash, window_start) do update set hits = h.hits + 1
  returning h.hits into v_hits;

  if v_hits > p_limit then
    -- Server log only (survives the rollback); never the key itself.
    raise log 'localbasic rate limit exceeded: bucket=% limit=% window=%s', p_bucket, p_limit, p_window_seconds;
    raise exception 'محاولات كثيرة. برجاء المحاولة بعد قليل.' using errcode = 'LB429';
  end if;

  -- Opportunistic sweep so the table stays small without a cron job.
  if random() < 0.01 then
    delete from app.rate_limit_hits where window_start < now() - interval '2 days';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Guest restaurant orders (QR table orders and online orders), whichever
-- function inserts them. Staff channels (cashier, waiter) are never limited.
-- ---------------------------------------------------------------------------
create or replace function app.guard_guest_order()
returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_key     text := app.phone_key(new.guest_phone);
  v_pending int;
begin
  if new.channel not in ('qr', 'online') then
    return new;
  end if;

  -- A whole store: far above any real rush, low enough to stop a flood.
  perform app.rate_limit('rl_order_org', new.organization_id::text, 600, 600);

  if length(v_key) >= 7 then
    perform app.rate_limit('rl_order_phone', new.organization_id::text || ':' || v_key, 8, 600);

    -- Orders held for WhatsApp verification cost the store nothing until
    -- released, but a pile of them under someone else's number is a nuisance
    -- and a probe. Three open at once is plenty for a genuine guest.
    if new.status = 'pending_verification' then
      select count(*) into v_pending
        from public.restaurant_orders o
       where o.organization_id = new.organization_id
         and o.status = 'pending_verification'
         and o.placed_at > now() - interval '1 hour'
         and app.phone_key(o.guest_phone) = v_key;
      if v_pending >= 3 then
        raise exception 'لديك طلبات بانتظار التأكيد. أكّد رقمك عبر واتساب أولًا.' using errcode = 'LB429';
      end if;
    end if;
  end if;

  if new.device_id is not null then
    perform app.rate_limit('rl_order_device', new.organization_id::text || ':' || new.device_id, 12, 600);
  end if;

  return new;
end;
$$;

create trigger restaurant_orders_guest_guard
  before insert on public.restaurant_orders
  for each row execute function app.guard_guest_order();

-- Retail storefront orders: all of them come from the public storefront.
create or replace function app.guard_retail_order()
returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_key text := app.phone_key(new.contact_phone);
begin
  perform app.rate_limit('rl_retail_org', new.organization_id::text, 600, 600);
  if length(v_key) >= 7 then
    perform app.rate_limit('rl_retail_phone', new.organization_id::text || ':' || v_key, 10, 600);
  end if;
  return new;
end;
$$;

create trigger retail_orders_guard
  before insert on public.retail_orders
  for each row execute function app.guard_retail_order();

-- Marketing-site leads (submit_public_lead is anonymous).
create or replace function app.guard_platform_lead()
returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.source = 'website' then
    perform app.rate_limit('rl_lead_all', 'website', 300, 3600);
    perform app.rate_limit('rl_lead_phone', app.phone_key(new.phone), 3, 86400);
  end if;
  return new;
end;
$$;

create trigger platform_leads_guard
  before insert on public.platform_leads
  for each row execute function app.guard_platform_lead();

-- Workspace creation by a signed-in user (provision_workspace). Platform
-- onboarding runs as the service role, where auth.uid() is null.
create or replace function app.guard_organization_create()
returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is not null and not app.is_platform_owner() then
    perform app.rate_limit('rl_org_create', auth.uid()::text, 5, 86400);
  end if;
  return new;
end;
$$;

create trigger organizations_create_guard
  before insert on public.organizations
  for each row execute function app.guard_organization_create();

-- ---------------------------------------------------------------------------
-- Guest profile reads and reward claims (0095). The wrappers become plpgsql
-- and VOLATILE so they may write the counter; behaviour is otherwise the same.
-- Reads are generous because the profile sheet refreshes while it is open.
-- ---------------------------------------------------------------------------
create or replace function app.guard_profile(p_org uuid, p_device text, p_phone text, p_claim boolean)
returns void
language plpgsql volatile security definer set search_path = '' as $$
declare v_key text := app.phone_key(p_phone);
begin
  if p_org is null then
    return;
  end if;
  if p_claim then
    perform app.rate_limit('rl_claim_phone', p_org::text || ':' || v_key, 10, 3600);
  else
    perform app.rate_limit('rl_profile_device', p_org::text || ':' || coalesce(p_device, ''), 300, 600);
    perform app.rate_limit('rl_profile_phone', p_org::text || ':' || v_key, 300, 600);
  end if;
end;
$$;

create or replace function public.customer_profile(p_org_slug text, p_device_id text, p_phone text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_org uuid;
begin
  select o.id into v_org from public.organizations o
   where o.slug = p_org_slug and o.status = 'active' and o.deleted_at is null;
  if v_org is null then
    return jsonb_build_object('verified', false);
  end if;
  perform app.guard_profile(v_org, p_device_id, p_phone, false);
  return app.customer_profile(v_org, p_device_id, p_phone);
end;
$$;

create or replace function public.customer_profile_by_token(p_token text, p_device_id text, p_phone text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_org uuid;
begin
  select o.id into v_org
    from public.public_links pl
    join public.organizations o on o.id = pl.organization_id
   where pl.token = p_token and pl.kind = 'menu' and pl.is_active and pl.revoked_at is null
     and (pl.expires_at is null or pl.expires_at > now())
     and o.status = 'active' and o.deleted_at is null;
  if v_org is null then
    return jsonb_build_object('verified', false);
  end if;
  perform app.guard_profile(v_org, p_device_id, p_phone, false);
  return app.customer_profile(v_org, p_device_id, p_phone);
end;
$$;

create or replace function public.customer_claim_reward(p_org_slug text, p_device_id text, p_phone text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_org uuid;
begin
  select o.id into v_org from public.organizations o
   where o.slug = p_org_slug and o.status = 'active' and o.deleted_at is null;
  if v_org is null then
    return null;
  end if;
  perform app.guard_profile(v_org, p_device_id, p_phone, true);
  return app.customer_claim_reward(v_org, p_device_id, p_phone);
end;
$$;

create or replace function public.customer_claim_reward_by_token(p_token text, p_device_id text, p_phone text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_org uuid;
begin
  select o.id into v_org
    from public.public_links pl
    join public.organizations o on o.id = pl.organization_id
   where pl.token = p_token and pl.kind = 'menu' and pl.is_active and pl.revoked_at is null
     and (pl.expires_at is null or pl.expires_at > now())
     and o.status = 'active' and o.deleted_at is null;
  if v_org is null then
    return null;
  end if;
  perform app.guard_profile(v_org, p_device_id, p_phone, true);
  return app.customer_claim_reward(v_org, p_device_id, p_phone);
end;
$$;

-- ---------------------------------------------------------------------------
-- Audit: a guest claiming a reward spends their points, so it is recorded
-- like the cashier's redemption already is. Last four digits only.
-- ---------------------------------------------------------------------------
create or replace function app.audit_coupon_claim()
returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, after)
  values (new.organization_id, auth.uid(), 'restaurant.loyalty_coupon.claimed', 'restaurant_loyalty_coupon', new.id::text,
          jsonb_build_object('phone_tail', right(new.phone_key, 4), 'points_cost', new.points_cost,
                             'value_cents', new.value_cents));
  return new;
end;
$$;

create trigger restaurant_loyalty_coupons_audit
  after insert on public.restaurant_loyalty_coupons
  for each row execute function app.audit_coupon_claim();

-- ---------------------------------------------------------------------------
-- Grants.
--
-- Postgres grants EXECUTE to PUBLIC on every new function, so every internal
-- app.* helper — including SECURITY DEFINER writers such as write_audit,
-- next_document_number and bootstrap_restaurant — was executable by `anon`.
-- The app schema is not exposed through the REST API today, so this was not
-- reachable, but one dashboard setting would have made it so. Anonymous
-- callers only ever enter through the public.* functions that wrap these, and
-- triggers do not check EXECUTE when they fire, so anon needs none of them.
-- Signed-in roles keep EXECUTE: RLS policies call app.has_permission and its
-- siblings as the invoking user.
-- ---------------------------------------------------------------------------
revoke execute on all functions in schema app from public, anon;
grant execute on all functions in schema app to authenticated, service_role;
alter default privileges in schema app revoke execute on functions from public;
alter default privileges in schema app grant execute on functions to authenticated, service_role;

-- The limiter and guards are internal; nothing outside a trigger or wrapper calls them.
revoke execute on function app.rate_limit(text, text, int, int) from authenticated;
revoke execute on function app.guard_profile(uuid, text, text, boolean) from authenticated;

revoke all on function public.customer_profile(text, text, text) from public;
revoke all on function public.customer_profile_by_token(text, text, text) from public;
revoke all on function public.customer_claim_reward(text, text, text) from public;
revoke all on function public.customer_claim_reward_by_token(text, text, text) from public;
grant execute on function public.customer_profile(text, text, text) to anon, authenticated;
grant execute on function public.customer_profile_by_token(text, text, text) to anon, authenticated;
grant execute on function public.customer_claim_reward(text, text, text) to anon, authenticated;
grant execute on function public.customer_claim_reward_by_token(text, text, text) to anon, authenticated;
