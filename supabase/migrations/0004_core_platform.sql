-- =============================================================================
-- LOCAL BASIC — 0004 Core platform
-- plans, subscriptions, branding, settings, audit_logs, notifications
-- =============================================================================

-- ---------------------------------------------------------------------------
-- plans — platform-owned catalog (no organization_id; readable by all members)
-- ---------------------------------------------------------------------------
create table public.plans (
  id            uuid primary key default gen_random_uuid(),
  key           text not null unique,
  name_ar       text not null,
  name_en       text not null,
  price_cents   bigint not null default 0 check (price_cents >= 0),
  currency      char(3) not null default 'EGP',
  interval      text not null default 'month' check (interval in ('month', 'year', 'trial')),
  -- Hard caps enforced server-side at creation time: branches, members, products…
  limits        jsonb not null default '{}'::jsonb,
  -- Feature flags, e.g. {"white_label": true, "online_store": true}
  features      jsonb not null default '{}'::jsonb,
  is_public     boolean not null default true,
  sort_order    int not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table public.subscriptions (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references public.organizations(id) on delete cascade,
  plan_id              uuid not null references public.plans(id),
  status               text not null default 'trialing'
                       check (status in ('trialing','active','past_due','cancelled','expired')),
  current_period_start timestamptz not null default now(),
  current_period_end   timestamptz not null,
  cancel_at_period_end boolean not null default false,
  provider             text,
  provider_ref         text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
-- One live subscription per organization.
create unique index subscriptions_active_unique
  on public.subscriptions(organization_id)
  where status in ('trialing', 'active', 'past_due');
create index subscriptions_org_idx on public.subscriptions(organization_id);
create trigger subscriptions_touch before update on public.subscriptions
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- branding — one row per organization
-- ---------------------------------------------------------------------------
create table public.branding_settings (
  organization_id  uuid primary key references public.organizations(id) on delete cascade,
  logo_url         text,
  display_name     text,
  primary_color    text not null default '#1E2FC8' check (primary_color ~* '^#[0-9a-f]{6}$'),
  secondary_color  text not null default '#6B8BFA' check (secondary_color ~* '^#[0-9a-f]{6}$'),
  phone            text,
  whatsapp         text,
  email            citext,
  -- Removing the "Powered by LocalBasic" footer is a plan feature, verified
  -- server-side against subscriptions.plan → features.white_label.
  white_label      boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create trigger branding_settings_touch before update on public.branding_settings
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- settings — key/value, org-wide (branch_id null) or branch-specific
-- ---------------------------------------------------------------------------
create table public.settings (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  branch_id        uuid references public.branches(id) on delete cascade,
  key              text not null,
  value            jsonb not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create unique index settings_scope_unique
  on public.settings(organization_id, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid), key);
create trigger settings_touch before update on public.settings
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- audit_logs — append only. No update policy, no delete policy, ever.
-- ---------------------------------------------------------------------------
create table public.audit_logs (
  id               bigserial primary key,
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  branch_id        uuid references public.branches(id) on delete set null,
  actor_id         uuid references public.profiles(id),
  actor_label      text,                -- preserved even if the profile is removed
  action           text not null,       -- 'invoice.void', 'member.role_granted', …
  entity_type      text not null,
  entity_id        text,
  before           jsonb,
  after            jsonb,
  ip               inet,
  user_agent       text,
  created_at       timestamptz not null default now()
);
create index audit_logs_org_created_idx
  on public.audit_logs(organization_id, created_at desc);
create index audit_logs_entity_idx
  on public.audit_logs(organization_id, entity_type, entity_id);

-- Writer used by services. SECURITY DEFINER so the actor cannot be forged:
-- actor_id is always taken from the session, never from the caller.
create or replace function app.write_audit(
  p_org uuid, p_branch uuid, p_action text, p_entity_type text,
  p_entity_id text, p_before jsonb, p_after jsonb, p_ip text, p_user_agent text
) returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.audit_logs (
    organization_id, branch_id, actor_id, actor_label, action,
    entity_type, entity_id, before, after, ip, user_agent
  ) values (
    p_org, p_branch, auth.uid(),
    (select p.full_name from public.profiles p where p.id = auth.uid()),
    p_action, p_entity_type, p_entity_id, p_before, p_after,
    nullif(p_ip, '')::inet, p_user_agent
  );
end;
$$;
grant execute on function
  app.write_audit(uuid, uuid, text, text, text, jsonb, jsonb, text, text)
to authenticated;

-- ---------------------------------------------------------------------------
-- notifications — outbound queue (email / sms / whatsapp / in-app)
-- ---------------------------------------------------------------------------
create table public.notifications (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  branch_id        uuid references public.branches(id) on delete set null,
  user_id          uuid references public.profiles(id) on delete cascade,
  -- For customer-facing notifications where there is no platform user.
  recipient        text,
  channel          text not null check (channel in ('inapp','email','sms','whatsapp')),
  template         text not null,
  payload          jsonb not null default '{}'::jsonb,
  status           text not null default 'pending'
                   check (status in ('pending','sent','failed','cancelled')),
  attempts         int not null default 0,
  last_error       text,
  scheduled_for    timestamptz not null default now(),
  sent_at          timestamptz,
  read_at          timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index notifications_pending_idx
  on public.notifications(scheduled_for) where status = 'pending';
create index notifications_user_idx
  on public.notifications(user_id, read_at) where channel = 'inapp';
create trigger notifications_touch before update on public.notifications
  for each row execute function app.touch_updated_at();
