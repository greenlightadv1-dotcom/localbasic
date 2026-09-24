-- =============================================================================
-- LOCAL BASIC — 0055 Site Engine foundation
--
-- A website belongs to an ORGANIZATION. Several members can work on the same
-- site, and a site outlives the person who created it — which is the whole
-- point of the change, because a website is a business asset and the employee
-- who first pressed "create" is not.
--
-- An earlier draft of this migration made sites user-owned. It was never
-- applied to any database and never merged: verified against every remote
-- branch and against the hosted projects before this file was rewritten in
-- place. If it had run anywhere, this would have had to be a new migration
-- instead, because a migration that has been applied is history.
--
-- This is a THIRD website representation and the boundary is deliberate:
--   * restaurant_website_sections — one site per org, restaurant only, flat
--     sections bound to LIVE data (today's menu, opening hours). Its value is
--     that binding, so it is not replaced by generic JSONB.
--   * platform_websites — marketing sites the platform operator builds for
--     customers, behind app.is_platform_admin(). A different audience.
--   * sites (this) — many per organization, any vertical, pages → sections.
--     The only one with a page hierarchy.
-- Merging them is a product decision with real data behind it, not a migration.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Permissions.
--
-- A dedicated pair rather than reusing settings.manage, which also carries
-- branding, online ordering and store settings — too coarse to mean "may edit
-- the website". Granted to owner and admin only for now: a branch manager runs
-- a branch, and the company website is not branch-scoped. Widening a grant
-- later is easy; taking one away from people who have started using it is not.
-- ---------------------------------------------------------------------------
insert into public.permissions (key, group_key, module_key, description, is_elevated) values
  ('site.read',   'settings', null, 'View the organization websites', false),
  ('site.manage', 'settings', null, 'Create and edit organization websites', false)
on conflict (key) do update
  set description = excluded.description,
      group_key   = excluded.group_key,
      module_key  = excluded.module_key;

with tpl as (
  select id, key from public.roles where organization_id is null
)
insert into public.role_permissions (role_id, permission_key)
select tpl.id, p.key
from tpl cross join (values ('site.read'), ('site.manage')) as p(key)
where tpl.key in ('owner', 'admin')
on conflict do nothing;

-- Organizations provisioned before this migration keep their owner role in
-- sync with the catalog, so a new permission is never locked away from them.
-- Same statement 0019 and 0052 used, for the same reason.
insert into public.role_permissions (role_id, permission_key)
select r.id, p.key
from public.roles r
cross join public.permissions p
where r.is_owner and r.organization_id is not null
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 2. sites — the root entity. Everything else is scoped through it.
-- ---------------------------------------------------------------------------
create table public.sites (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- Authorship, not ownership. Nullable and SET NULL on purpose: cascading
  -- from the creator would destroy an organization's website the day that
  -- employee's profile is removed.
  created_by      uuid references public.profiles(id) on delete set null,
  name            text not null check (length(trim(name)) between 2 and 120),
  slug            citext not null check (slug ~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$'),
  -- Nullable, and no FK: templates are a later phase and there is no templates
  -- table yet. A dangling reference would be worse than none.
  template_id     uuid,
  status          text not null default 'draft' check (status in ('draft', 'published')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Unique per ORGANIZATION. Two organizations may both want "main-site"; taking
-- the name from the second buys nothing. Revisit when sites become publicly
-- addressable by slug.
create unique index sites_org_slug_key on public.sites(organization_id, slug);
create index sites_org_idx on public.sites(organization_id, created_at desc);

create trigger sites_touch
  before update on public.sites
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 3. site_pages
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

-- At most one homepage per site, enforced by the database rather than by
-- whichever code path happens to write it.
create unique index site_pages_one_homepage
  on public.site_pages(site_id) where is_homepage;

create index site_pages_site_order_idx on public.site_pages(site_id, sort_order, id);

create trigger site_pages_touch
  before update on public.site_pages
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 4. site_sections
-- ---------------------------------------------------------------------------
create table public.site_sections (
  id           uuid primary key default gen_random_uuid(),
  page_id      uuid not null references public.site_pages(id) on delete cascade,
  -- A closed list: the renderer is a lookup keyed on this value, so a type it
  -- cannot draw must not be storable. Extending it is a later migration.
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
-- 5. site_settings
-- ---------------------------------------------------------------------------
create table public.site_settings (
  id         uuid primary key default gen_random_uuid(),
  site_id    uuid not null references public.sites(id) on delete cascade,
  settings   jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One settings row per site: without this, "the settings" is ambiguous the
-- first time a double submit creates a second row.
create unique index site_settings_site_key on public.site_settings(site_id);

create trigger site_settings_touch
  before update on public.site_settings
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 6. Scope helpers.
--
-- Child tables carry no organization_id — they are reached through their
-- parent, the same exemption platform_website_versions holds. These four
-- functions are the only place that traversal is written, so the organization
-- a row belongs to is decided once.
--
-- SECURITY DEFINER with search_path = '' so a policy on site_pages does not
-- re-enter the policy on sites while evaluating. Every lookup is by primary key.
-- ---------------------------------------------------------------------------
create or replace function app.site_can_read(p_site uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.sites s
     where s.id = p_site and app.has_permission(s.organization_id, 'site.read')
  );
$$;

create or replace function app.site_can_manage(p_site uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.sites s
     where s.id = p_site and app.has_permission(s.organization_id, 'site.manage')
  );
$$;

create or replace function app.site_page_can_read(p_page uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
      from public.site_pages pg
      join public.sites s on s.id = pg.site_id
     where pg.id = p_page and app.has_permission(s.organization_id, 'site.read')
  );
$$;

create or replace function app.site_page_can_manage(p_page uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
      from public.site_pages pg
      join public.sites s on s.id = pg.site_id
     where pg.id = p_page and app.has_permission(s.organization_id, 'site.manage')
  );
$$;

revoke all on function app.site_can_read(uuid)        from public, anon;
revoke all on function app.site_can_manage(uuid)      from public, anon;
revoke all on function app.site_page_can_read(uuid)   from public, anon;
revoke all on function app.site_page_can_manage(uuid) from public, anon;
grant execute on function app.site_can_read(uuid)        to authenticated;
grant execute on function app.site_can_manage(uuid)      to authenticated;
grant execute on function app.site_page_can_read(uuid)   to authenticated;
grant execute on function app.site_page_can_manage(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Row level security.
--
-- FORCE as well as ENABLE: without FORCE the table owner bypasses every
-- policy, and the owner is who migrations and definer functions run as.
--
-- One policy per verb rather than a single FOR ALL, matching
-- restaurant_website_sections: reading and editing are different permissions,
-- and FOR ALL cannot express that. UPDATE carries USING and WITH CHECK both —
-- USING alone would let a row be updated out of reach of the policy that
-- allowed it to be read, which is how cross-organization re-parenting happens.
-- ---------------------------------------------------------------------------
alter table public.sites         enable row level security;
alter table public.site_pages    enable row level security;
alter table public.site_sections enable row level security;
alter table public.site_settings enable row level security;

alter table public.sites         force row level security;
alter table public.site_pages    force row level security;
alter table public.site_sections force row level security;
alter table public.site_settings force row level security;

create policy sites_select on public.sites
  for select to authenticated
  using (app.has_permission(organization_id, 'site.read'));

create policy sites_insert on public.sites
  for insert to authenticated
  with check (app.has_permission(organization_id, 'site.manage'));

create policy sites_update on public.sites
  for update to authenticated
  using (app.has_permission(organization_id, 'site.manage'))
  with check (app.has_permission(organization_id, 'site.manage'));

create policy sites_delete on public.sites
  for delete to authenticated
  using (app.has_permission(organization_id, 'site.manage'));

create policy site_pages_select on public.site_pages
  for select to authenticated using (app.site_can_read(site_id));
create policy site_pages_insert on public.site_pages
  for insert to authenticated with check (app.site_can_manage(site_id));
create policy site_pages_update on public.site_pages
  for update to authenticated
  using (app.site_can_manage(site_id)) with check (app.site_can_manage(site_id));
create policy site_pages_delete on public.site_pages
  for delete to authenticated using (app.site_can_manage(site_id));

create policy site_sections_select on public.site_sections
  for select to authenticated using (app.site_page_can_read(page_id));
create policy site_sections_insert on public.site_sections
  for insert to authenticated with check (app.site_page_can_manage(page_id));
create policy site_sections_update on public.site_sections
  for update to authenticated
  using (app.site_page_can_manage(page_id)) with check (app.site_page_can_manage(page_id));
create policy site_sections_delete on public.site_sections
  for delete to authenticated using (app.site_page_can_manage(page_id));

create policy site_settings_select on public.site_settings
  for select to authenticated using (app.site_can_read(site_id));
create policy site_settings_insert on public.site_settings
  for insert to authenticated with check (app.site_can_manage(site_id));
create policy site_settings_update on public.site_settings
  for update to authenticated
  using (app.site_can_manage(site_id)) with check (app.site_can_manage(site_id));
create policy site_settings_delete on public.site_settings
  for delete to authenticated using (app.site_can_manage(site_id));

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
-- 8. Provisioning a site.
--
-- One function, one transaction: the site, its homepage and its settings row
-- are created together or not at all. Three round trips from the application
-- would leave a site with no homepage whenever the second failed, and nothing
-- would ever repair it.
--
-- SECURITY INVOKER. Every insert passes through the policies above, so the
-- function is a convenience and never a way around RLS. The explicit
-- permission check exists only to produce a readable error instead of a bare
-- policy violation.
-- ---------------------------------------------------------------------------
create or replace function public.site_provision(
  p_org uuid,
  p_name text,
  p_slug text,
  p_template_id uuid default null
) returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  v_site uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  if not app.has_permission(p_org, 'site.manage') then
    raise exception 'site.manage required' using errcode = 'insufficient_privilege';
  end if;

  insert into public.sites (organization_id, created_by, name, slug, template_id)
       values (p_org, auth.uid(), p_name, p_slug, p_template_id)
    returning id into v_site;

  -- Slug 'home' rather than an empty string so the row is addressable and the
  -- unique index has something to work with. The renderer resolves the
  -- homepage by the flag, not by the slug.
  insert into public.site_pages (site_id, title, slug, is_homepage, sort_order)
       values (v_site, 'الرئيسية', 'home', true, 0);

  insert into public.site_settings (site_id, settings)
       values (v_site, jsonb_build_object(
         'locale', 'ar',
         'direction', 'rtl',
         'theme', jsonb_build_object('preset', 'default')
       ));

  return v_site;
end;
$$;

revoke all on function public.site_provision(uuid, text, text, uuid) from public, anon;
grant execute on function public.site_provision(uuid, text, text, uuid) to authenticated;
