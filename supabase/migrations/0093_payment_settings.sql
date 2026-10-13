-- ---------------------------------------------------------------------------
-- 0093: store payment settings (methods + online gateway credentials).
--
-- One row per organization:
--   * cash_enabled      cash on delivery / pay at the table / at the till
--   * online_enabled    guests may be offered the configured gateway
--   * gateway           paymob | myfatoorah | tap | stripe
--   * public_config     NON-secret identifiers (merchant id, publishable key)
--   * secret_ciphertext every secret key, as ONE AES-256-GCM blob produced by
--                       the application (the key lives in the app's
--                       environment, never in the database). The database
--                       only ever stores and returns opaque text.
--   * secret_hint       masked tail of one secret ("••••1234") for display
--
-- Access: RLS is on and FORCED with no policies, so no client role can read
-- the table. Everything goes through the SECURITY DEFINER functions below,
-- and the ciphertext is never returned by any of them.
--
-- Plan gate: a custom online gateway is a Growth ("Pro") / Scale
-- ("Enterprise") feature — plans.features.online_payments, enforced here in
-- the save function and in the public read, not only in the UI. Cash stays
-- available on every plan. Stored credentials survive a downgrade (they just
-- stop being offered), same convention as brand colors in 0091.
-- ---------------------------------------------------------------------------

update public.plans
   set features = coalesce(features, '{}'::jsonb)
                  || jsonb_build_object('online_payments', key in ('growth', 'scale'));

create table public.restaurant_payment_settings (
  organization_id   uuid primary key references public.organizations(id) on delete cascade,
  cash_enabled      boolean not null default true,
  online_enabled    boolean not null default false,
  gateway           text check (gateway is null or gateway in ('paymob', 'myfatoorah', 'tap', 'stripe')),
  public_config     jsonb not null default '{}'::jsonb,
  secret_ciphertext text,
  secret_hint       text,
  updated_by        uuid references auth.users(id),
  updated_at        timestamptz not null default now(),
  constraint payment_settings_has_a_method check (cash_enabled or online_enabled),
  constraint payment_settings_online_needs_gateway check (not online_enabled or gateway is not null)
);

alter table public.restaurant_payment_settings enable row level security;
alter table public.restaurant_payment_settings force row level security;
revoke all on public.restaurant_payment_settings from public, anon, authenticated;

-- Settings screen read. Never returns the ciphertext.
create or replace function public.restaurant_payment_settings_get(p_org uuid)
returns table (
  out_cash_enabled   boolean,
  out_online_enabled boolean,
  out_gateway        text,
  out_public_config  jsonb,
  out_has_secret     boolean,
  out_secret_hint    text,
  out_plan_allows    boolean
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not app.has_permission(p_org, 'settings.manage') then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  return query
    select coalesce(s.cash_enabled, true),
           coalesce(s.online_enabled, false),
           s.gateway,
           coalesce(s.public_config, '{}'::jsonb),
           (s.secret_ciphertext is not null),
           s.secret_hint,
           app.org_has_plan_feature(p_org, 'online_payments')
      from (select 1) _
      left join public.restaurant_payment_settings s on s.organization_id = p_org;
end;
$$;

-- Save. p_secret_ciphertext null = keep the stored secret; p_clear_secret
-- removes it (and with it the ability to enable online payments).
create or replace function public.restaurant_payment_settings_save(
  p_org               uuid,
  p_cash_enabled      boolean,
  p_online_enabled    boolean,
  p_gateway           text,
  p_public_config     jsonb,
  p_secret_ciphertext text,
  p_secret_hint       text,
  p_clear_secret      boolean
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_user   uuid := auth.uid();
  v_old    public.restaurant_payment_settings%rowtype;
  v_secret text;
  v_hint   text;
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not app.has_permission(p_org, 'settings.manage') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if not (p_cash_enabled or p_online_enabled) then
    raise exception 'لازم تبقى طريقة دفع واحدة على الأقل مفعّلة' using errcode = 'check_violation';
  end if;

  -- Touching the gateway at all needs the plan feature.
  if (p_online_enabled or p_gateway is not null or p_secret_ciphertext is not null)
     and not app.org_has_plan_feature(p_org, 'online_payments') then
    raise exception 'بوابات الدفع الإلكتروني متاحة في باقتي النمو والاحترافي فقط' using errcode = '42501';
  end if;

  select * into v_old from public.restaurant_payment_settings where organization_id = p_org;

  v_secret := case when p_clear_secret then null
                   when p_secret_ciphertext is not null then p_secret_ciphertext
                   else v_old.secret_ciphertext end;
  v_hint   := case when p_clear_secret then null
                   when p_secret_ciphertext is not null then p_secret_hint
                   else v_old.secret_hint end;

  if p_online_enabled and (p_gateway is null or v_secret is null) then
    raise exception 'أدخل بيانات البوابة كاملة قبل تفعيل الدفع الإلكتروني' using errcode = 'check_violation';
  end if;
  -- A different gateway invalidates the stored secret: keys are not portable.
  if v_old.organization_id is not null and v_old.gateway is distinct from p_gateway
     and p_secret_ciphertext is null and not p_clear_secret then
    if p_online_enabled then
      raise exception 'غيّرت البوابة — أدخل مفاتيح البوابة الجديدة' using errcode = 'check_violation';
    end if;
    v_secret := null;
    v_hint := null;
  end if;

  insert into public.restaurant_payment_settings
    (organization_id, cash_enabled, online_enabled, gateway, public_config,
     secret_ciphertext, secret_hint, updated_by, updated_at)
  values
    (p_org, p_cash_enabled, p_online_enabled, p_gateway, coalesce(p_public_config, '{}'::jsonb),
     v_secret, v_hint, v_user, now())
  on conflict (organization_id) do update
    set cash_enabled = excluded.cash_enabled,
        online_enabled = excluded.online_enabled,
        gateway = excluded.gateway,
        public_config = excluded.public_config,
        secret_ciphertext = excluded.secret_ciphertext,
        secret_hint = excluded.secret_hint,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at;

  -- Audit WITHOUT any credential material.
  insert into public.audit_logs
    (organization_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, v_user, 'restaurant.payment_settings.updated', 'organization', p_org::text,
    jsonb_build_object('cash_enabled', p_cash_enabled, 'online_enabled', p_online_enabled,
                       'gateway', p_gateway, 'secret_changed', (p_secret_ciphertext is not null or p_clear_secret)));
end;
$$;

-- What a GUEST may know: which methods are on, and the gateway's name.
-- Online counts as available only when it is enabled, fully configured and
-- the plan still includes it. Never any key.
create or replace function app.payment_options(p_org uuid)
returns table (out_cash boolean, out_online_gateway text)
language sql stable security definer set search_path = '' as $$
  select coalesce(s.cash_enabled, true)
         or not (s.online_enabled and s.secret_ciphertext is not null
                 and app.org_has_plan_feature(p_org, 'online_payments')),
         case when s.online_enabled and s.gateway is not null and s.secret_ciphertext is not null
                   and app.org_has_plan_feature(p_org, 'online_payments')
              then s.gateway end
    from (select 1) _
    left join public.restaurant_payment_settings s on s.organization_id = p_org;
$$;

create or replace function public.restaurant_payment_options(p_org_slug text)
returns table (out_cash boolean, out_online_gateway text)
language sql stable security definer set search_path = '' as $$
  select po.out_cash, po.out_online_gateway
    from public.organizations o
    cross join lateral app.payment_options(o.id) po
   where o.slug = p_org_slug and o.status = 'active' and o.deleted_at is null;
$$;

create or replace function public.restaurant_payment_options_by_token(p_token text)
returns table (out_cash boolean, out_online_gateway text)
language sql stable security definer set search_path = '' as $$
  select po.out_cash, po.out_online_gateway
    from public.public_links pl
    join public.organizations o on o.id = pl.organization_id
    cross join lateral app.payment_options(o.id) po
   where pl.token = p_token and pl.kind = 'menu'
     and pl.is_active and pl.revoked_at is null
     and (pl.expires_at is null or pl.expires_at > now())
     and o.status = 'active' and o.deleted_at is null;
$$;

revoke all on function public.restaurant_payment_settings_get(uuid) from public, anon;
revoke all on function public.restaurant_payment_settings_save(uuid, boolean, boolean, text, jsonb, text, text, boolean) from public, anon;
revoke all on function app.payment_options(uuid) from public, anon, authenticated;
revoke all on function public.restaurant_payment_options(text) from public;
revoke all on function public.restaurant_payment_options_by_token(text) from public;
grant execute on function public.restaurant_payment_settings_get(uuid) to authenticated;
grant execute on function public.restaurant_payment_settings_save(uuid, boolean, boolean, text, jsonb, text, text, boolean) to authenticated;
grant execute on function public.restaurant_payment_options(text) to anon, authenticated;
grant execute on function public.restaurant_payment_options_by_token(text) to anon, authenticated;
