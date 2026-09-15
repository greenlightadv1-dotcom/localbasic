-- =============================================================================
-- LOCAL BASIC — 0030 Platform billing
--
-- Reuses the existing catalogue rather than duplicating it:
--   * public.plans stays the price list. Its price_cents is the MONTHLY price.
--   * public.subscriptions stays the single live record per organization,
--     including the provider/provider_ref columns that a future gateway fills.
--
-- What is added is what genuinely did not exist:
--   * a billing term (monthly / quarterly / semi-annual / annual),
--   * promo and trial codes,
--   * an append-only history of every renewal, so a past term is never lost
--     when the live subscription row moves forward.
--
-- Every amount and every date is computed here, in the database, from the plan
-- and the term. Nothing that the browser sends is used as a price, a discount
-- or a period end.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Billing term on the live subscription.
-- ---------------------------------------------------------------------------
alter table public.subscriptions
  add column if not exists billing_period text not null default 'month'
    check (billing_period in ('month', 'quarter', 'semiannual', 'year', 'trial'));

-- One place that maps a term to its length, so the renewal maths and the UI
-- can never drift apart.
create or replace function app.billing_period_months(p_period text)
returns int language sql immutable set search_path = '' as $$
  select case p_period
    when 'month'      then 1
    when 'quarter'    then 3
    when 'semiannual' then 6
    when 'year'       then 12
    else 0                         -- 'trial' is priced in days, not months
  end;
$$;

-- ---------------------------------------------------------------------------
-- Promo / trial codes. Separate from the customer code: that identifies a
-- workspace forever, this grants a discount or a trial once.
-- ---------------------------------------------------------------------------
create table public.promo_codes (
  id                 uuid primary key default gen_random_uuid(),
  code               citext not null unique
                     check (code ~ '^[A-Za-z0-9][A-Za-z0-9_-]{2,31}$'),
  description        text,
  -- Exactly one of the three effects, enforced below.
  kind               text not null check (kind in ('percent', 'fixed', 'trial_days')),
  percent_off        int    check (percent_off between 1 and 100),
  amount_off_cents   bigint check (amount_off_cents > 0),
  trial_days         int    check (trial_days between 1 and 365),
  currency           char(3) not null default 'EGP',
  starts_at          timestamptz not null default now(),
  ends_at            timestamptz,
  -- null = unlimited.
  max_redemptions    int check (max_redemptions > 0),
  redeemed_count     int not null default 0 check (redeemed_count >= 0),
  is_active          boolean not null default true,
  -- null = applies to any plan / any service.
  plan_id            uuid references public.plans(id) on delete cascade,
  module_key         text check (module_key in ('retail','restaurant','medical','workshop')),
  -- true = only an organization that has never had a paid term.
  new_customers_only boolean not null default false,
  created_at         timestamptz not null default now(),
  created_by         uuid references public.profiles(id),
  constraint promo_codes_effect_matches_kind check (
    (kind = 'percent'    and percent_off is not null and amount_off_cents is null and trial_days is null) or
    (kind = 'fixed'      and amount_off_cents is not null and percent_off is null and trial_days is null) or
    (kind = 'trial_days' and trial_days is not null and percent_off is null and amount_off_cents is null)
  ),
  constraint promo_codes_window check (ends_at is null or ends_at > starts_at)
);
create index promo_codes_active_idx on public.promo_codes(code) where is_active;

-- ---------------------------------------------------------------------------
-- Append-only subscription history. The live subscriptions row is a cursor;
-- this is the ledger. Past terms are never rewritten.
-- ---------------------------------------------------------------------------
create table public.subscription_events (
  id                bigserial primary key,
  organization_id   uuid not null references public.organizations(id) on delete cascade,
  subscription_id   uuid references public.subscriptions(id) on delete set null,
  event_type        text not null check (event_type in (
    'created', 'renewed', 'plan_changed', 'trial_granted', 'cancelled', 'expired'
  )),
  plan_id           uuid references public.plans(id),
  billing_period    text not null,
  period_start      timestamptz not null,
  period_end        timestamptz not null,
  -- Money as integer minor units, like everywhere else in the platform.
  gross_cents       bigint not null default 0 check (gross_cents    >= 0),
  discount_cents    bigint not null default 0 check (discount_cents >= 0),
  net_cents         bigint not null default 0 check (net_cents      >= 0),
  currency          char(3) not null default 'EGP',
  -- CASH today. The column exists so a gateway becomes a new value, not a
  -- schema change.
  payment_method    text not null default 'cash'
                    check (payment_method in ('cash', 'card', 'wallet', 'transfer', 'gateway', 'none')),
  promo_code_id     uuid references public.promo_codes(id),
  promo_code        text,              -- denormalised: survives a code deletion
  note              text,
  created_at        timestamptz not null default now(),
  created_by        uuid references public.profiles(id),
  created_by_label  text,
  constraint subscription_events_period check (period_end > period_start),
  constraint subscription_events_net check (net_cents = gross_cents - discount_cents)
);
create index subscription_events_org_idx on public.subscription_events(organization_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Redemptions. One row per use, so usage limits are counted from facts.
-- ---------------------------------------------------------------------------
create table public.promo_redemptions (
  id                   bigserial primary key,
  promo_code_id        uuid not null references public.promo_codes(id) on delete cascade,
  organization_id      uuid not null references public.organizations(id) on delete cascade,
  subscription_event_id bigint references public.subscription_events(id) on delete set null,
  discount_cents       bigint not null default 0 check (discount_cents >= 0),
  trial_days_granted   int not null default 0 check (trial_days_granted >= 0),
  redeemed_at          timestamptz not null default now(),
  redeemed_by          uuid references public.profiles(id)
);
create index promo_redemptions_code_idx on public.promo_redemptions(promo_code_id);
create unique index promo_redemptions_once_per_org
  on public.promo_redemptions(promo_code_id, organization_id);

-- ---------------------------------------------------------------------------
-- RLS. Platform-only tables: readable by Platform Admins, invisible to tenants.
-- ---------------------------------------------------------------------------
alter table public.promo_codes          enable row level security;
alter table public.promo_codes          force  row level security;
alter table public.subscription_events  enable row level security;
alter table public.subscription_events  force  row level security;
alter table public.promo_redemptions    enable row level security;
alter table public.promo_redemptions    force  row level security;

create policy promo_codes_platform_read on public.promo_codes
  for select to authenticated using (app.is_platform_admin());

-- Admins author and amend codes directly; the policy is the boundary, exactly
-- as it is for tenant tables. No DELETE policy: a spent code is deactivated,
-- never removed, so its redemptions keep pointing at something real.
create policy promo_codes_platform_write on public.promo_codes
  for insert to authenticated with check (app.is_platform_admin());
create policy promo_codes_platform_update on public.promo_codes
  for update to authenticated
  using (app.is_platform_admin()) with check (app.is_platform_admin());
create policy promo_redemptions_platform_read on public.promo_redemptions
  for select to authenticated using (app.is_platform_admin());

-- An organization's own owner may read its billing history; the platform reads
-- all of it. No UPDATE or DELETE policy exists on any of the three.
create policy subscription_events_read on public.subscription_events
  for select to authenticated
  using (app.is_platform_admin() or app.is_owner(organization_id));

-- ---------------------------------------------------------------------------
-- Grants. Append-only is enforced by privilege as well as by policy.
-- ---------------------------------------------------------------------------
revoke all on public.promo_codes         from anon, authenticated;
revoke all on public.subscription_events from anon, authenticated;
revoke all on public.promo_redemptions   from anon, authenticated;
grant select, insert, update on public.promo_codes to authenticated;
grant select on public.subscription_events to authenticated;
grant select on public.promo_redemptions   to authenticated;
revoke all on sequence public.subscription_events_id_seq from anon, authenticated;
revoke all on sequence public.promo_redemptions_id_seq   from anon, authenticated;
