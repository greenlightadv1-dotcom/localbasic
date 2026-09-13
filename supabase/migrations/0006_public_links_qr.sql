-- =============================================================================
-- LOCAL BASIC — 0006 Public links + QR
--
-- A public link is an opaque CSPRNG token. It is the ONLY identifier that ever
-- appears in a customer-facing URL or inside a QR code: no organization id, no
-- branch id, no table id, no price, no secret.
-- =============================================================================

create table public.public_links (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  branch_id        uuid not null references public.branches(id) on delete cascade,
  -- 'store' | 'portal' | 'booking' | 'menu' | 'order_status' | 'kitchen'
  kind             text not null,
  -- 32 random bytes, base64url. Not a uuid: uuids are guessable in bulk and
  -- leak creation ordering.
  token            text not null unique check (token ~ '^[A-Za-z0-9_-]{22,64}$'),
  -- What the link points at, without Core knowing the vertical:
  -- {"entity_type":"restaurant_table","entity_id":"…"}
  target           jsonb not null default '{}'::jsonb,
  label            text,
  is_active        boolean not null default true,
  expires_at       timestamptz,
  revoked_at       timestamptz,
  last_used_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid references public.profiles(id)
);
create index public_links_org_idx on public.public_links(organization_id, kind);
create index public_links_branch_idx on public.public_links(branch_id);
create trigger public_links_touch before update on public.public_links
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- qr_codes — a printable binding between a token and a physical thing.
-- The QR image encodes only  https://<app>/p/<token>  so reassigning a sticker
-- to another table, or changing a menu, never invalidates what is printed.
-- ---------------------------------------------------------------------------
create table public.qr_codes (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  branch_id        uuid not null references public.branches(id) on delete cascade,
  public_link_id   uuid not null references public.public_links(id) on delete cascade,
  label            text not null,
  entity_type      text,
  entity_id        uuid,
  is_active        boolean not null default true,
  printed_at       timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid references public.profiles(id)
);
create index qr_codes_org_idx on public.qr_codes(organization_id, branch_id);
create index qr_codes_entity_idx on public.qr_codes(entity_type, entity_id);
create trigger qr_codes_touch before update on public.qr_codes
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Token resolution for anonymous visitors.
--
-- SECURITY DEFINER and deliberately narrow: it returns the routing information
-- a public page needs and nothing else. The anon role never selects from
-- public_links (or any tenant table) directly.
-- ---------------------------------------------------------------------------
create or replace function public.resolve_public_link(p_token text)
returns table (
  kind            text,
  organization_id uuid,
  branch_id       uuid,
  target          jsonb,
  org_name        text,
  org_slug        text,
  branch_name     text,
  currency        char(3),
  locale          text,
  logo_url        text,
  primary_color   text,
  secondary_color text,
  white_label     boolean
)
language sql stable security definer set search_path = '' as $$
  select
    pl.kind, pl.organization_id, pl.branch_id, pl.target,
    coalesce(bs.display_name, o.name), o.slug::text, b.name,
    o.currency, o.default_locale,
    bs.logo_url, bs.primary_color, bs.secondary_color, coalesce(bs.white_label, false)
  from public.public_links pl
  join public.organizations o on o.id = pl.organization_id
  join public.branches b      on b.id = pl.branch_id
  left join public.branding_settings bs on bs.organization_id = o.id
  where pl.token = p_token
    and pl.is_active
    and pl.revoked_at is null
    and (pl.expires_at is null or pl.expires_at > now())
    and o.status = 'active'
    and o.deleted_at is null
    and b.is_active
    and b.deleted_at is null;
$$;

grant execute on function public.resolve_public_link(text) to anon, authenticated;
