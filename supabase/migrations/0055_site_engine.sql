-- =============================================================================
-- LOCAL BASIC — 0055 Site Engine foundation
--
-- A website belongs to a USER, not to an organization. That is a second
-- ownership axis alongside the org/branch tenancy the rest of the platform
-- uses, and it is deliberate: a site is authored by a person before it has
-- anything to do with a workspace. The precedent is already here —
-- customer_addresses and notifications key off auth.uid() the same way.
--
-- Consequence worth stating plainly: a site is NOT visible to colleagues in
-- the author's organization. If sites should become team-owned, an
-- organization_id column is an additive migration, but the policies below
-- would have to be rewritten. Better decided before real data exists.
--
-- This is a THIRD website representation. restaurant_website_sections is
-- org-scoped and restaurant-specific; platform_websites is org-scoped with a
-- single JSONB definition and no page concept. Neither models "one user, many
-- sites, each with many pages", so neither is extended here. Consolidating the
-- three is a product decision, not a migration.
--
-- Nothing in this migration touches an existing table.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- sites — the root entity. One row per website.
-- ---------------------------------------------------------------------------
create table public.sites (
  id          uuid primary key default gen_random_uuid(),
  -- The owner. profiles(id) is itself auth.users(id), so this is the auth
  -- user, reachable from RLS via auth.uid() without a join.
  user_id     uuid not null references public.profiles(id) on delete cascade,
  name        text not null check (length(trim(name)) between 2 and 120),
  -- Lowercase, hyphen-separated, no leading or trailing hyphen. citext so a
  -- slug cannot be duplicated by changing its case.
  slug        citext not null check (slug ~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$'),
  -- Nullable by design: templates are a later phase, and a site must be
  -- creatable before any template exists. No FK for the same reason — there
  -- is no templates table yet, and a dangling reference would be worse than
  -- none.
  template_id uuid,
  status      text not null default 'draft' check (status in ('draft', 'published')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Slugs are unique per OWNER rather than globally: two users may both want
-- "my-cafe", and taking the name away from the second one would be a poor
-- experience for no security benefit. When sites become publicly addressable
-- by slug this has to be revisited — see the note in docs/SUPABASE.md.
create unique index sites_owner_slug_key on public.sites(user_id, slug);
create index sites_owner_idx on public.sites(user_id, created_at desc);

create trigger sites_touch
  before update on public.sites
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- site_pages — the pages of one site.
-- ---------------------------------------------------------------------------
create table public.site_pages (
  id          uuid primary key default gen_random_uuid(),
  site_id     uuid not null references public.sites(id) on delete cascade,
  title       text not null check (length(trim(title)) between 1 and 200),
  slug        citext not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$|^[a-z0-9]$'),
  is_homepage boolean not null default false,
  sort_order  int not null default 0 check (sort_order between 0 and 9999),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index site_pages_site_slug_key on public.site_pages(site_id, slug);

-- At most one homepage per site, enforced by the database rather than by the
-- code that happens to write it. A partial unique index is the cheapest way to
-- say "only one row may have this flag true".
create unique index site_pages_one_homepage
  on public.site_pages(site_id) where is_homepage;

create index site_pages_site_order_idx on public.site_pages(site_id, sort_order, id);

create trigger site_pages_touch
  before update on public.site_pages
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- site_sections — the ordered blocks of one page.
-- ---------------------------------------------------------------------------
create table public.site_sections (
  id           uuid primary key default gen_random_uuid(),
  page_id      uuid not null references public.site_pages(id) on delete cascade,
  -- A closed list, not free text: the renderer is a lookup table keyed on this
  -- value, so a type it cannot draw must not be storable in the first place.
  -- Extending the renderer means extending this check, in a later migration.
  section_type text not null check (section_type in (
    'hero', 'about', 'services', 'testimonials', 'contact', 'footer'
  )),
  content      jsonb not null default '{}'::jsonb,
  sort_order   int not null default 0 check (sort_order between 0 and 9999),
  is_visible   boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Ties break on id so two sections sharing a position still render in a stable
-- order rather than whatever the planner returns that day.
create index site_sections_page_order_idx
  on public.site_sections(page_id, sort_order, id);

create trigger site_sections_touch
  before update on public.site_sections
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- site_settings — one row per site.
-- ---------------------------------------------------------------------------
create table public.site_settings (
  id         uuid primary key default gen_random_uuid(),
  site_id    uuid not null references public.sites(id) on delete cascade,
  settings   jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One settings row per site. Without this, "the settings" becomes ambiguous
-- the first time a double-submit creates a second row.
create unique index site_settings_site_key on public.site_settings(site_id);

create trigger site_settings_touch
  before update on public.site_settings
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Ownership helpers.
--
-- SECURITY DEFINER with search_path = '' so the policies on child tables can
-- ask "is the site behind this row mine?" without the caller's own RLS on
-- `sites` being re-evaluated inside the check. Every lookup is by primary key.
-- ---------------------------------------------------------------------------
create or replace function app.site_is_mine(p_site uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.sites s
     where s.id = p_site and s.user_id = auth.uid()
  ) and auth.uid() is not null;
$$;

create or replace function app.site_page_is_mine(p_page uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
      from public.site_pages p
      join public.sites s on s.id = p.site_id
     where p.id = p_page and s.user_id = auth.uid()
  ) and auth.uid() is not null;
$$;

revoke all on function app.site_is_mine(uuid)      from public, anon;
revoke all on function app.site_page_is_mine(uuid) from public, anon;
grant execute on function app.site_is_mine(uuid)      to authenticated;
grant execute on function app.site_page_is_mine(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Row level security.
--
-- FORCE as well as ENABLE: without FORCE the table owner bypasses every policy,
-- and the owner is who migrations and definer functions run as.
-- ---------------------------------------------------------------------------
alter table public.sites         enable row level security;
alter table public.site_pages    enable row level security;
alter table public.site_sections enable row level security;
alter table public.site_settings enable row level security;

alter table public.sites         force row level security;
alter table public.site_pages    force row level security;
alter table public.site_sections force row level security;
alter table public.site_settings force row level security;

-- The root table is the only one that compares against auth.uid() directly.
-- Everything else reaches it through the helpers, so ownership is defined in
-- exactly one place.
create policy sites_own on public.sites
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy site_pages_own on public.site_pages
  for all to authenticated
  using (app.site_is_mine(site_id))
  with check (app.site_is_mine(site_id));

create policy site_sections_own on public.site_sections
  for all to authenticated
  using (app.site_page_is_mine(page_id))
  with check (app.site_page_is_mine(page_id));

create policy site_settings_own on public.site_settings
  for all to authenticated
  using (app.site_is_mine(site_id))
  with check (app.site_is_mine(site_id));

-- Supabase's default grants are too generous to inherit; state them.
revoke all on public.sites         from anon;
revoke all on public.site_pages    from anon;
revoke all on public.site_sections from anon;
revoke all on public.site_settings from anon;

grant select, insert, update, delete on public.sites         to authenticated;
grant select, insert, update, delete on public.site_pages    to authenticated;
grant select, insert, update, delete on public.site_sections to authenticated;
grant select, insert, update, delete on public.site_settings to authenticated;

-- ---------------------------------------------------------------------------
-- Provisioning a site.
--
-- One function, one transaction: the site, its homepage and its settings row
-- are created together or not at all. Doing this in three round trips from the
-- application would leave a site with no homepage whenever the second call
-- failed, and nothing would ever repair it.
--
-- NOT security definer. It runs as the caller, so every insert passes through
-- the policies above — the function is a convenience, never a way around RLS.
-- ---------------------------------------------------------------------------
create or replace function public.site_provision(
  p_name text,
  p_slug text,
  p_template_id uuid default null
) returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_site uuid;
  v_page uuid;
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  insert into public.sites (user_id, name, slug, template_id)
       values (v_user, p_name, p_slug, p_template_id)
    returning id into v_site;

  -- The homepage. Slug 'home' rather than an empty string so the row is
  -- addressable and the unique index has something to work with; the renderer
  -- resolves the homepage by the flag, not by the slug.
  insert into public.site_pages (site_id, title, slug, is_homepage, sort_order)
       values (v_site, 'الرئيسية', 'home', true, 0)
    returning id into v_page;

  insert into public.site_settings (site_id, settings)
       values (v_site, jsonb_build_object(
         'locale', 'ar',
         'direction', 'rtl',
         'theme', jsonb_build_object('preset', 'default')
       ));

  return v_site;
end;
$$;

revoke all on function public.site_provision(text, text, uuid) from public, anon;
grant execute on function public.site_provision(text, text, uuid) to authenticated;
