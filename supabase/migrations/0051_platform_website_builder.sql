-- =============================================================================
-- LOCAL BASIC — 0051 Platform website builder
--
-- 0042 gave a RESTAURANT tenant a builder for its own page: section rows the
-- tenant edits under `settings.manage`, frozen into revisions on publish. That
-- stays exactly as it is. Nothing here alters it, reads it or competes with it.
--
-- This is a different thing with a different owner. The PLATFORM builds and
-- operates websites FOR customers, across every vertical, from a single
-- versioned Site Definition that an AI provider will later produce. The
-- operator is a Platform Admin, who by design is not a member of any tenant,
-- so tenant RBAC cannot be the gate here — app.is_platform_admin() is.
--
-- THE MODEL
--
--   platform_websites          one row per website; draft and published
--                              definitions side by side, so editing a draft
--                              never touches what is live
--   platform_website_versions  append-only snapshot per publish, the minimum
--                              that keeps rollback and compare possible later
--
-- WHAT A DEFINITION MAY CONTAIN
--
-- A Site Definition describes a website. It does not contain one. No HTML, no
-- CSS, no JavaScript, no arbitrary URLs — refused on the way in, not sanitised
-- on the way out. Section types come from a closed list, so the renderer can
-- never meet one it cannot draw, and a model that invents a section type
-- produces a row the database rejects rather than a page nobody can render.
--
-- This validation exists here as well as in Zod because the application is not
-- the only way in, and because "never trust model output" has to be enforced
-- somewhere that a future code path cannot skip.
--
-- NOT IN THIS PHASE
--
-- No public/anonymous read. anon gets no policy and no privilege. When
-- published sites are served publicly that will be a narrow SECURITY DEFINER
-- projection of published_definition, the way 0042 serves its live revision —
-- never a broadened policy on this table.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Section catalogue.
--
-- A function rather than a check constraint on a jsonb path: the same list has
-- to be consulted from the validation walk below, and one definition of it is
-- the point.
-- ---------------------------------------------------------------------------
create or replace function app.site_section_types()
returns text[] language sql immutable set search_path = '' as $$
  select array[
    'hero', 'about', 'services', 'products', 'menu', 'gallery', 'testimonials',
    'features', 'contact', 'location', 'opening_hours', 'call_to_action', 'footer'
  ];
$$;

-- ---------------------------------------------------------------------------
-- 2. The recursive value check.
--
-- Every string anywhere in a definition is bounded and free of markup. A key
-- whose name ends in _url, _image, logo or favicon must additionally be an
-- https URL, so no stored value can become an injection vector or an open
-- redirect however deeply a future section type nests it.
--
-- app.website_text_ok and app.website_image_ok are 0042's, reused deliberately:
-- one rule about what may be stored, not two that can drift apart.
-- ---------------------------------------------------------------------------
create or replace function app.site_node_ok(p_key text, p_node jsonb, p_depth int)
returns boolean language plpgsql immutable set search_path = '' as $$
declare v jsonb; k text;
begin
  -- A definition is a shallow document. Anything deeper is a structure nobody
  -- designed, and refusing it bounds the work this function can be made to do.
  if p_depth > 8 then return false; end if;

  case jsonb_typeof(p_node)
    when 'string' then
      if p_key ~ '(_url|_image|logo|favicon)$' then
        return app.website_image_ok(p_node #>> '{}');
      end if;
      return app.website_text_ok(p_node #>> '{}', 4000);

    when 'array' then
      if jsonb_array_length(p_node) > 60 then return false; end if;
      for v in select * from jsonb_array_elements(p_node) loop
        if not app.site_node_ok(p_key, v, p_depth + 1) then return false; end if;
      end loop;
      return true;

    when 'object' then
      for k in select jsonb_object_keys(p_node) loop
        -- Keys are identifiers, not content. Bounding their shape keeps a
        -- model from smuggling text into a place nothing validates.
        if length(k) > 64 or k !~ '^[a-z][a-z0-9_]*$' then return false; end if;
        if not app.site_node_ok(k, p_node -> k, p_depth + 1) then return false; end if;
      end loop;
      return true;

    else
      return true;  -- number, boolean, null
  end case;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. The structural check.
--
-- Raises with a usable message rather than returning false, because this is
-- what an operator — or a rejected AI draft — will actually read.
-- ---------------------------------------------------------------------------
create or replace function app.check_site_definition(p_def jsonb)
returns void language plpgsql immutable set search_path = '' as $$
declare
  v_page    jsonb;
  v_section jsonb;
  v_nav     jsonb;
  v_key     text;
  v_fonts   text[] := array['system', 'cairo', 'tajawal', 'ibm-plex-arabic'];
begin
  if jsonb_typeof(p_def) <> 'object' then
    raise exception 'the site definition must be an object' using errcode = '22023';
  end if;

  -- Bounded before anything walks it.
  if length(p_def::text) > 200000 then
    raise exception 'the site definition is too large' using errcode = '22023';
  end if;

  -- Versioned from the first row. A reader that does not know a version must
  -- be able to refuse it rather than guess at the shape.
  if coalesce(p_def ->> 'version', '') <> '1' then
    raise exception 'unsupported site definition version' using errcode = '22023';
  end if;

  if not app.site_node_ok('root', p_def, 0) then
    raise exception 'the site definition contains markup, a non-https URL or an unusable key'
      using errcode = '22023';
  end if;

  -- theme
  if p_def ? 'theme' then
    if jsonb_typeof(p_def -> 'theme') <> 'object' then
      raise exception 'the theme must be an object' using errcode = '22023';
    end if;
    -- Colours are hex literals, never arbitrary CSS: the renderer puts these
    -- into a style attribute, and this pattern is what keeps that safe.
    for v_key in select jsonb_object_keys(p_def -> 'theme' -> 'colors') loop
      if (p_def -> 'theme' -> 'colors' ->> v_key) !~ '^#[0-9A-Fa-f]{6}$' then
        raise exception 'theme colour "%" must be a hex colour like #1E2FC8', v_key
          using errcode = '22023';
      end if;
    end loop;
    for v_key in select jsonb_object_keys(coalesce(p_def -> 'theme' -> 'fonts', '{}'::jsonb)) loop
      if not ((p_def -> 'theme' -> 'fonts' ->> v_key) = any (v_fonts)) then
        raise exception 'that font is not available' using errcode = '22023';
      end if;
    end loop;
  end if;

  -- pages
  if jsonb_typeof(p_def -> 'pages') <> 'array' then
    raise exception 'the site definition needs a list of pages' using errcode = '22023';
  end if;
  if jsonb_array_length(p_def -> 'pages') > 20 then
    raise exception 'a site holds at most 20 pages' using errcode = '22023';
  end if;

  for v_page in select * from jsonb_array_elements(p_def -> 'pages') loop
    if jsonb_typeof(v_page) <> 'object' then
      raise exception 'every page must be an object' using errcode = '22023';
    end if;
    -- A page slug is a path this application will route, so it is restricted
    -- to a path: no scheme, no host, no backslash, nothing that could become
    -- an absolute destination.
    if coalesce(v_page ->> 'slug', '') !~ '^/[a-z0-9-]*(/[a-z0-9-]+)*$' then
      raise exception 'page slug "%" is not a usable path', coalesce(v_page ->> 'slug', '')
        using errcode = '22023';
    end if;
    if coalesce(v_page ->> 'title', '') = '' then
      raise exception 'every page needs a title' using errcode = '22023';
    end if;
    if jsonb_typeof(v_page -> 'sections') <> 'array' then
      raise exception 'every page needs a list of sections' using errcode = '22023';
    end if;
    if jsonb_array_length(v_page -> 'sections') > 30 then
      raise exception 'a page holds at most 30 sections' using errcode = '22023';
    end if;

    for v_section in select * from jsonb_array_elements(v_page -> 'sections') loop
      if jsonb_typeof(v_section) <> 'object' then
        raise exception 'every section must be an object' using errcode = '22023';
      end if;
      -- The closed list. An unknown type cannot be stored, so the renderer
      -- never has to decide what to do with one.
      if not ((v_section ->> 'type') = any (app.site_section_types())) then
        raise exception 'unknown section type "%"', coalesce(v_section ->> 'type', '')
          using errcode = '22023';
      end if;
      if v_section ? 'props' and jsonb_typeof(v_section -> 'props') <> 'object' then
        raise exception 'section properties must be an object' using errcode = '22023';
      end if;
    end loop;
  end loop;

  -- navigation: internal destinations only, never a URL a model supplied.
  if p_def ? 'navigation' then
    if jsonb_typeof(p_def -> 'navigation') <> 'array' then
      raise exception 'navigation must be a list' using errcode = '22023';
    end if;
    if jsonb_array_length(p_def -> 'navigation') > 12 then
      raise exception 'navigation holds at most 12 entries' using errcode = '22023';
    end if;
    for v_nav in select * from jsonb_array_elements(p_def -> 'navigation') loop
      if coalesce(v_nav ->> 'label', '') = '' then
        raise exception 'every navigation entry needs a label' using errcode = '22023';
      end if;
      if coalesce(v_nav ->> 'target', '') !~ '^/[a-z0-9-]*(/[a-z0-9-]+)*$' then
        raise exception 'navigation may only point at a page of this site'
          using errcode = '22023';
      end if;
    end loop;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. The websites.
-- ---------------------------------------------------------------------------
create table public.platform_websites (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references public.organizations(id) on delete cascade,
  name                 text not null check (length(trim(name)) between 2 and 120),
  -- The public slug this site will be served under once public hosting exists.
  -- Reserved now so the entity does not have to change shape later.
  slug                 citext not null check (slug ~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$'),
  site_type            text not null check (site_type in (
    'restaurant', 'clinic', 'workshop', 'retail', 'custom'
  )),
  status               text not null default 'draft' check (status in (
    'draft', 'published', 'archived'
  )),
  -- The working copy. Always present and always valid.
  draft_definition     jsonb not null,
  -- What is live. Null until the first publish, and only ever written by
  -- platform_website_publish().
  published_definition jsonb,
  -- Human instructions for the AI layer: structured fields plus a free-form
  -- brief. Consumed in the next phase, stored from this one.
  brief                jsonb not null default '{}'::jsonb,
  created_by           uuid references public.profiles(id),
  updated_by           uuid references public.profiles(id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  published_at         timestamptz,
  deleted_at           timestamptz,

  -- A published website must have something published.
  constraint platform_websites_published_has_definition
    check (status <> 'published' or published_definition is not null)
);

create index platform_websites_org_idx
  on public.platform_websites(organization_id, status)
  where deleted_at is null;

create index platform_websites_status_idx
  on public.platform_websites(status, updated_at desc)
  where deleted_at is null;

-- One live site per slug. Scoped to the living rows so an archived site does
-- not hold its slug hostage forever.
create unique index platform_websites_slug_unique
  on public.platform_websites(slug) where deleted_at is null;

create trigger platform_websites_touch
  before update on public.platform_websites
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 5. Published history.
--
-- Append-only. No update policy, no delete policy, no delete privilege: what
-- was published on a given day stays answerable, and rollback and compare stay
-- possible without building a version-control system now.
-- ---------------------------------------------------------------------------
create table public.platform_website_versions (
  id           uuid primary key default gen_random_uuid(),
  website_id   uuid not null references public.platform_websites(id) on delete cascade,
  version      int not null check (version > 0),
  definition   jsonb not null,
  published_at timestamptz not null default now(),
  published_by uuid references public.profiles(id),
  note         text check (length(note) <= 500),
  unique (website_id, version)
);

create index platform_website_versions_site_idx
  on public.platform_website_versions(website_id, version desc);

-- ---------------------------------------------------------------------------
-- 6. What may be written, and by whom.
--
-- created_by and updated_by are SET here, never accepted. A caller may send
-- any value it likes; the row records auth.uid() regardless, so attribution
-- cannot be forged through any path that reaches this table.
--
-- The organization is re-checked too: the foreign key proves it exists, not
-- that it is a customer in good standing.
-- ---------------------------------------------------------------------------
create or replace function app.check_platform_website()
returns trigger language plpgsql set search_path = '' as $$
declare v_ok boolean;
begin
  perform app.check_site_definition(new.draft_definition);
  if new.published_definition is not null then
    perform app.check_site_definition(new.published_definition);
  end if;

  if tg_op = 'INSERT' then
    select true into v_ok
    from public.organizations o
    where o.id = new.organization_id and o.deleted_at is null;
    if not coalesce(v_ok, false) then
      raise exception 'that organization is not available' using errcode = '22023';
    end if;

    new.created_by := auth.uid();
    new.updated_by := auth.uid();
  else
    -- A website never moves to another organization.
    if new.organization_id <> old.organization_id then
      raise exception 'a website cannot be moved to another organization'
        using errcode = '22023';
    end if;
    new.created_by := old.created_by;
    new.updated_by := auth.uid();
  end if;

  return new;
end;
$$;

create trigger platform_websites_check
  before insert or update on public.platform_websites
  for each row execute function app.check_platform_website();

-- ---------------------------------------------------------------------------
-- 7. Audit.
--
-- Written by a trigger rather than by the service layer, so every path that
-- changes a website leaves a line — including one a later refactor forgets
-- about. Uses the existing audit_logs and the existing platform. prefix that
-- 0035's constraint requires; there is no second audit system.
-- ---------------------------------------------------------------------------
create or replace function app.audit_platform_website()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_action text;
  v_label  text;
begin
  if tg_op = 'INSERT' then
    v_action := 'platform.website_created';
  elsif new.deleted_at is not null and old.deleted_at is null then
    v_action := 'platform.website_deleted';
  elsif new.status = 'archived' and old.status <> 'archived' then
    v_action := 'platform.website_archived';
  -- Three independent signals, because no one of them is reliable alone.
  -- published_at cannot distinguish two publishes in the same transaction:
  -- now() is the transaction clock, so both carry the same value. The
  -- definition changing is the real event, and the status transition catches
  -- the first publish of an unchanged draft.
  elsif new.status = 'published'
        and (old.status <> 'published'
             or new.published_at is distinct from old.published_at
             or new.published_definition is distinct from old.published_definition) then
    v_action := 'platform.website_published';
  else
    v_action := 'platform.website_updated';
  end if;

  select p.full_name into v_label from public.profiles p where p.id = auth.uid();

  insert into public.audit_logs
    (organization_id, actor_id, actor_label, action, entity_type, entity_id, after)
  values (
    new.organization_id, auth.uid(), v_label, v_action, 'platform_website', new.id::text,
    jsonb_build_object('name', new.name, 'slug', new.slug::text,
                       'site_type', new.site_type, 'status', new.status)
  );

  return null;
end;
$$;

create trigger platform_websites_audit
  after insert or update on public.platform_websites
  for each row execute function app.audit_platform_website();

-- ---------------------------------------------------------------------------
-- 8. RLS.
--
-- Enabled and forced. Platform Admin only, evaluated by the database, on every
-- statement. A tenant user — owner or otherwise — matches no policy here, and
-- tenant RBAC is never consulted: there is deliberately no bridge between the
-- two authorization systems.
--
-- No delete policy: a website is retired with deleted_at, never removed, so
-- its published history stays attached to something.
--
-- anon gets nothing at all. Public serving is a later, narrower projection.
-- ---------------------------------------------------------------------------
alter table public.platform_websites         enable row level security;
alter table public.platform_website_versions enable row level security;
alter table public.platform_websites         force row level security;
alter table public.platform_website_versions force row level security;

create policy platform_websites_read on public.platform_websites
  for select to authenticated using (app.is_platform_admin());

create policy platform_websites_insert on public.platform_websites
  for insert to authenticated with check (app.is_platform_admin());

-- USING and WITH CHECK both: a row cannot be updated out of reach of the
-- policy that let it be read.
create policy platform_websites_update on public.platform_websites
  for update to authenticated
  using (app.is_platform_admin())
  with check (app.is_platform_admin());

create policy platform_website_versions_read on public.platform_website_versions
  for select to authenticated using (app.is_platform_admin());

revoke all on public.platform_websites         from anon;
revoke all on public.platform_website_versions from anon;
grant select, insert, update on public.platform_websites         to authenticated;
grant select                 on public.platform_website_versions to authenticated;

-- ---------------------------------------------------------------------------
-- 9. Publish.
--
-- Promotes the validated draft to published in one statement: snapshot, live
-- copy, status and timestamp together, so there is no moment where a site is
-- published with nothing in it.
--
-- The draft is already structurally valid — the trigger saw to that on every
-- write — so what is added here is the editorial minimum: a site has to have
-- a home page with something on it before it can be called published.
-- ---------------------------------------------------------------------------
create or replace function public.platform_website_publish(
  p_website_id uuid,
  p_note       text default null
)
returns table (out_version int, out_page_count int)
language plpgsql security definer set search_path = '' as $$
declare
  v_def     jsonb;
  v_org     uuid;
  v_version int;
  v_pages   int;
  v_home    boolean;
begin
  perform app.require_platform_admin();

  select w.draft_definition, w.organization_id into v_def, v_org
  from public.platform_websites w
  where w.id = p_website_id and w.deleted_at is null;

  if v_def is null then
    raise exception 'website not found' using errcode = 'check_violation';
  end if;

  perform app.check_site_definition(v_def);

  select count(*) into v_pages from jsonb_array_elements(v_def -> 'pages');

  select exists (
    select 1 from jsonb_array_elements(v_def -> 'pages') p
    where p ->> 'slug' = '/' and jsonb_array_length(p -> 'sections') > 0
  ) into v_home;

  if not v_home then
    raise exception 'أضف صفحة رئيسية تحتوي على قسم واحد على الأقل قبل النشر'
      using errcode = 'check_violation';
  end if;

  select coalesce(max(v.version), 0) + 1 into v_version
  from public.platform_website_versions v where v.website_id = p_website_id;

  insert into public.platform_website_versions
    (website_id, version, definition, published_by, note)
  values (p_website_id, v_version, v_def, auth.uid(),
          nullif(left(trim(coalesce(p_note, '')), 500), ''));

  update public.platform_websites
     set published_definition = v_def,
         status               = 'published',
         published_at         = now()
   where id = p_website_id;

  return query select v_version, v_pages;
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Grants.
--
-- PUBLIC first, then the role that may actually call it — Postgres grants
-- EXECUTE to PUBLIC on creation and a later narrower grant does not take that
-- away (the lesson of 0028).
--
-- The validators are granted to authenticated because the BEFORE trigger runs
-- as the writer. They are pure functions of their arguments: they read no
-- table and reveal nothing the caller did not pass in.
-- ---------------------------------------------------------------------------
revoke all on function app.check_platform_website()  from public, anon, authenticated;
revoke all on function app.audit_platform_website()  from public, anon, authenticated;

revoke all on function app.site_section_types()                  from public, anon;
revoke all on function app.site_node_ok(text, jsonb, int)        from public, anon;
revoke all on function app.check_site_definition(jsonb)          from public, anon;
grant execute on function app.site_section_types()               to authenticated;
grant execute on function app.site_node_ok(text, jsonb, int)     to authenticated;
grant execute on function app.check_site_definition(jsonb)       to authenticated;

revoke all on function public.platform_website_publish(uuid, text) from public, anon;
grant execute on function public.platform_website_publish(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 11. Business data for the builder.
--
-- The builder needs the customer's real brand and contact details as INPUT —
-- it must not hold a second copy of them. Two of the sources it needs,
-- branding_settings and settings, are tenant-only tables with no platform read
-- policy, and widening them would give the console a handle on far more than
-- it displays.
--
-- So this follows 0041: a narrow, explicit projection rather than a table
-- read. It returns exactly the fields the builder puts in front of an operator
-- and nothing else, and it checks the caller itself.
-- ---------------------------------------------------------------------------
create or replace function public.platform_website_business_profile(p_org uuid)
returns table (
  organization_name text,
  organization_slug text,
  primary_module    text,
  currency          text,
  display_name      text,
  logo_url          text,
  primary_color     text,
  secondary_color   text,
  phone             text,
  whatsapp          text,
  email             text,
  opening_hours     jsonb,
  branch_count      int
)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_platform_admin();

  return query
  select
    o.name::text,
    o.slug::text,
    o.primary_module::text,
    o.currency::text,
    b.display_name::text,
    b.logo_url::text,
    b.primary_color::text,
    b.secondary_color::text,
    b.phone::text,
    b.whatsapp::text,
    b.email::text,
    coalesce(s.value, 'null'::jsonb),
    (select count(*)::int from public.branches br
      where br.organization_id = o.id and br.is_active and br.deleted_at is null)
  from public.organizations o
  left join public.branding_settings b on b.organization_id = o.id
  left join public.settings s
    on s.organization_id = o.id and s.branch_id is null
   and s.key = 'restaurant.opening_hours'
  where o.id = p_org and o.deleted_at is null;
end;
$$;

revoke all on function public.platform_website_business_profile(uuid) from public, anon;
grant execute on function public.platform_website_business_profile(uuid) to authenticated;
