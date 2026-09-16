-- =============================================================================
-- LOCAL BASIC — 0042 Website builder foundation
--
-- D2 gave every restaurant the same page with its own content in it. This lets
-- a restaurant decide which sections appear, in what order, and what each one
-- says — without becoming a page builder, and without letting a tenant put
-- code on a page we serve.
--
-- THE MODEL
--
--   DRAFT      restaurant_website_sections  — the working set the builder edits
--              settings['restaurant.website_theme'] — the working theme
--   PUBLISHED  restaurant_website_revisions — append-only snapshots, one live
--
-- Publishing validates the whole configuration, freezes it into a revision and
-- flips which revision is live, in one statement. The public read never touches
-- the draft tables at all: it reads the live revision or nothing. A visitor
-- therefore cannot see work in progress even if a policy were later loosened,
-- because the draft is not on the path.
--
-- BACKWARD COMPATIBILITY
--
-- A restaurant with no live revision has no rows here, and the public site
-- falls back to the D2 layout unchanged. Nothing in 0039 is altered.
--
-- WHAT A TENANT MAY NOT PUT IN
--
-- No HTML, no CSS, no JavaScript — not "sanitised", simply refused. Text
-- fields reject angle brackets, image URLs must be https, fonts come from a
-- fixed list and colours must match a hex pattern. Validated here as well as
-- in the application, because the application is not the only way in.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. The section catalogue.
--
-- A domain over an explicit list rather than free text: an unknown section
-- type cannot be stored at all, so the renderer never meets one it cannot draw.
-- ---------------------------------------------------------------------------
create table public.restaurant_website_sections (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  section_type    text not null check (section_type in (
    'hero', 'about', 'menu', 'gallery', 'contact', 'hours', 'branches', 'cta'
  )),
  -- Deterministic order. Ties break on id so two sections sharing a position
  -- still render in a stable sequence rather than whatever the planner returns.
  sort_order      int not null default 0 check (sort_order between 0 and 999),
  enabled         boolean not null default true,
  -- Per-type content. Shape is enforced by the trigger below.
  config          jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid references public.profiles(id)
);

create index restaurant_website_sections_org_idx
  on public.restaurant_website_sections(organization_id, sort_order, id);

-- A restaurant cannot have two MENU sections or two HOURS sections: they would
-- render the same authoritative data twice and mean nothing different.
create unique index restaurant_website_sections_one_per_type
  on public.restaurant_website_sections(organization_id, section_type)
  where section_type in ('menu', 'hours', 'branches', 'contact', 'about', 'hero');

create trigger restaurant_website_sections_touch
  before update on public.restaurant_website_sections
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 2. Published revisions.
--
-- Append-only: no UPDATE policy except the live flag, no DELETE policy, and no
-- DELETE privilege. What was public on a given day stays answerable.
-- ---------------------------------------------------------------------------
create table public.restaurant_website_revisions (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  version         int not null check (version > 0),
  -- The frozen snapshot. Sections as an ordered array, theme as an object.
  sections        jsonb not null,
  theme           jsonb not null default '{}'::jsonb,
  is_live         boolean not null default false,
  published_at    timestamptz not null default now(),
  published_by    uuid references public.profiles(id),
  note            text check (length(note) <= 500),
  unique (organization_id, version)
);

-- Exactly one live revision per restaurant, enforced by the database rather
-- than by whichever code path wrote last.
create unique index restaurant_website_revisions_one_live
  on public.restaurant_website_revisions(organization_id) where is_live;

create index restaurant_website_revisions_org_idx
  on public.restaurant_website_revisions(organization_id, version desc);

-- ---------------------------------------------------------------------------
-- 3. What a section may contain.
--
-- One function, per type, run on every write. The rules are boring on purpose:
-- known keys, bounded lengths, https images, and no angle brackets anywhere in
-- anything that will be rendered.
-- ---------------------------------------------------------------------------
create or replace function app.website_text_ok(p_value text, p_max int)
returns boolean language sql immutable set search_path = '' as $$
  -- Angle brackets are refused outright. This is not sanitisation — nothing is
  -- stripped or escaped — it is a flat refusal to store markup, so no renderer
  -- downstream can ever be tricked into treating stored text as HTML.
  select p_value is null
      or (length(p_value) <= p_max and p_value !~ '[<>]');
$$;

create or replace function app.website_image_ok(p_url text)
returns boolean language sql immutable set search_path = '' as $$
  -- https only. javascript:, data: and every other scheme are refused here so
  -- a stored value can never become an injection vector later.
  select p_url is null or p_url = ''
      or (length(p_url) <= 500 and p_url ~ '^https://[^[:space:]<>"]+$');
$$;

create or replace function app.check_website_section()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_key   text;
  v_item  jsonb;
  v_n     int;
  v_allowed text[];
begin
  if jsonb_typeof(new.config) <> 'object' then
    raise exception 'section configuration must be an object' using errcode = '22023';
  end if;

  -- Allowed keys per type. An unknown key is refused rather than ignored, so
  -- nothing can be smuggled into the snapshot for a future renderer to read.
  v_allowed := case new.section_type
    when 'hero'     then array['title', 'subtitle', 'image_url', 'button_label', 'show_order_button']
    when 'about'    then array['title', 'body', 'image_url']
    when 'menu'     then array['title', 'subtitle', 'show_prices']
    when 'gallery'  then array['title', 'images']
    when 'contact'  then array['title', 'subtitle', 'show_phone', 'show_whatsapp', 'show_email']
    when 'hours'    then array['title']
    when 'branches' then array['title', 'show_addresses']
    when 'cta'      then array['title', 'subtitle', 'button_label', 'button_target']
    else array[]::text[]
  end;

  for v_key in select jsonb_object_keys(new.config) loop
    if not (v_key = any (v_allowed)) then
      raise exception 'unknown setting "%" for a % section', v_key, new.section_type
        using errcode = '22023';
    end if;
  end loop;

  -- Text fields. Every one of them is plain text, bounded, and free of markup.
  foreach v_key in array array['title', 'subtitle', 'button_label'] loop
    if new.config ? v_key then
      if jsonb_typeof(new.config -> v_key) <> 'string' then
        raise exception '% must be text', v_key using errcode = '22023';
      end if;
      if not app.website_text_ok(new.config ->> v_key, 200) then
        raise exception '% is too long or contains markup', v_key using errcode = '22023';
      end if;
    end if;
  end loop;

  if new.config ? 'body' then
    if jsonb_typeof(new.config -> 'body') <> 'string' then
      raise exception 'the body must be text' using errcode = '22023';
    end if;
    if not app.website_text_ok(new.config ->> 'body', 4000) then
      raise exception 'the body is too long or contains markup' using errcode = '22023';
    end if;
  end if;

  if new.config ? 'image_url' then
    if jsonb_typeof(new.config -> 'image_url') <> 'string'
       or not app.website_image_ok(new.config ->> 'image_url') then
      raise exception 'the image must be an https URL' using errcode = '22023';
    end if;
  end if;

  -- Booleans.
  foreach v_key in array array[
    'show_prices', 'show_phone', 'show_whatsapp', 'show_email',
    'show_addresses', 'show_order_button'
  ] loop
    if new.config ? v_key and jsonb_typeof(new.config -> v_key) <> 'boolean' then
      raise exception '% must be true or false', v_key using errcode = '22023';
    end if;
  end loop;

  -- The CTA's destination is a choice from a fixed list, never a URL a tenant
  -- supplies: an arbitrary target would make the site an open redirect.
  if new.config ? 'button_target' then
    if new.config ->> 'button_target' not in ('order', 'menu', 'contact', 'branches') then
      raise exception 'the button target must be one of order, menu, contact, branches'
        using errcode = '22023';
    end if;
  end if;

  -- Gallery: a bounded list of https image URLs and nothing else.
  if new.config ? 'images' then
    if jsonb_typeof(new.config -> 'images') <> 'array' then
      raise exception 'the gallery must be a list of image URLs' using errcode = '22023';
    end if;
    v_n := jsonb_array_length(new.config -> 'images');
    if v_n > 12 then
      raise exception 'a gallery holds at most 12 images' using errcode = '22023';
    end if;
    for v_item in select * from jsonb_array_elements(new.config -> 'images') loop
      if jsonb_typeof(v_item) <> 'string'
         or coalesce(v_item #>> '{}', '') = ''
         or not app.website_image_ok(v_item #>> '{}') then
        raise exception 'every gallery image must be an https URL' using errcode = '22023';
      end if;
    end loop;
  end if;

  return new;
end;
$$;

create trigger restaurant_website_sections_check
  before insert or update on public.restaurant_website_sections
  for each row execute function app.check_website_section();

-- ---------------------------------------------------------------------------
-- 4. The theme.
--
-- Kept in public.settings rather than a new table: the restaurant already has
-- a settings store with validation and audit wired into it, and a second one
-- would be a second thing to keep in step. This extends the 0039 trigger the
-- same way 0039 extended D1.1's.
-- ---------------------------------------------------------------------------
create or replace function app.check_restaurant_setting()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_num numeric;
  v_day jsonb;
  v_key text;
  v_fonts text[] := array['system', 'cairo', 'tajawal', 'ibm-plex-arabic'];
begin
  if new.key in (
    'restaurant.online_ordering_enabled',
    'restaurant.pickup_enabled',
    'restaurant.delivery_enabled',
    'restaurant.public_ordering_enabled',
    'restaurant.website_enabled'
  ) then
    if jsonb_typeof(new.value) <> 'boolean' then
      raise exception '% must be true or false', new.key using errcode = '22023';
    end if;

  elsif new.key = 'restaurant.delivery_fee_cents' then
    if jsonb_typeof(new.value) <> 'number' then
      raise exception 'the delivery fee must be a number of minor units'
        using errcode = '22023';
    end if;
    v_num := (new.value #>> '{}')::numeric;
    if v_num <> floor(v_num) then
      raise exception 'the delivery fee must be a whole number of minor units'
        using errcode = '22023';
    end if;
    if v_num < 0 or v_num > 1000000 then
      raise exception 'the delivery fee must be between 0 and 1000000 minor units'
        using errcode = '22023';
    end if;

  elsif new.key in ('restaurant.website_tagline', 'restaurant.website_about') then
    if jsonb_typeof(new.value) <> 'string' then
      raise exception '% must be text', new.key using errcode = '22023';
    end if;
    if length(new.value #>> '{}') > 2000 then
      raise exception '% is too long', new.key using errcode = '22023';
    end if;

  elsif new.key = 'restaurant.website_hero_url' then
    if jsonb_typeof(new.value) <> 'string' then
      raise exception 'the hero image must be a URL' using errcode = '22023';
    end if;
    if new.value #>> '{}' <> '' then
      if length(new.value #>> '{}') > 500 then
        raise exception 'the hero image URL is too long' using errcode = '22023';
      end if;
      if new.value #>> '{}' !~ '^https://[^[:space:]<>"]+$' then
        raise exception 'the hero image must be an https URL' using errcode = '22023';
      end if;
    end if;

  elsif new.key = 'restaurant.opening_hours' then
    if jsonb_typeof(new.value) <> 'array' then
      raise exception 'opening hours must be a list of days' using errcode = '22023';
    end if;
    if jsonb_array_length(new.value) <> 7 then
      raise exception 'opening hours need exactly seven days' using errcode = '22023';
    end if;
    for v_day in select * from jsonb_array_elements(new.value) loop
      if jsonb_typeof(v_day) <> 'object'
         or jsonb_typeof(v_day -> 'closed') <> 'boolean' then
        raise exception 'each day needs a closed flag' using errcode = '22023';
      end if;
      if not (v_day ->> 'closed')::boolean then
        if coalesce(v_day ->> 'opens', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
           or coalesce(v_day ->> 'closes', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
          raise exception 'opening times must be HH:MM' using errcode = '22023';
        end if;
      end if;
    end loop;

  -- 0042: the website theme.
  elsif new.key = 'restaurant.website_theme' then
    if jsonb_typeof(new.value) <> 'object' then
      raise exception 'the theme must be an object' using errcode = '22023';
    end if;

    for v_key in select jsonb_object_keys(new.value) loop
      if not (v_key = any (array[
        'primary_color', 'accent_color', 'background', 'font', 'button_style', 'width'
      ])) then
        raise exception 'unknown theme setting "%"', v_key using errcode = '22023';
      end if;
    end loop;

    -- Colours are hex literals, never arbitrary CSS. A value like
    -- `red; background: url(...)` cannot survive this pattern, so the style
    -- attribute the renderer builds can only ever contain a colour.
    foreach v_key in array array['primary_color', 'accent_color'] loop
      if new.value ? v_key then
        if jsonb_typeof(new.value -> v_key) <> 'string'
           or (new.value ->> v_key) !~ '^#[0-9A-Fa-f]{6}$' then
          raise exception '% must be a hex colour like #1E2FC8', v_key using errcode = '22023';
        end if;
      end if;
    end loop;

    -- The rest are choices from fixed lists. No free text reaches a stylesheet.
    if new.value ? 'background'
       and new.value ->> 'background' not in ('light', 'dark', 'warm') then
      raise exception 'the background must be light, dark or warm' using errcode = '22023';
    end if;
    if new.value ? 'font' and not (new.value ->> 'font' = any (v_fonts)) then
      raise exception 'that font is not available' using errcode = '22023';
    end if;
    if new.value ? 'button_style'
       and new.value ->> 'button_style' not in ('rounded', 'square', 'pill') then
      raise exception 'the button style must be rounded, square or pill' using errcode = '22023';
    end if;
    if new.value ? 'width' and new.value ->> 'width' not in ('normal', 'wide') then
      raise exception 'the width must be normal or wide' using errcode = '22023';
    end if;
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. RLS.
--
-- Enabled and forced. Sections are readable and writable only by a member of
-- the owning organization holding settings.manage — the same permission that
-- already governs the website settings screen. anon has no policy and no
-- privilege: the public site reads published revisions through a SECURITY
-- DEFINER function, never these tables.
-- ---------------------------------------------------------------------------
alter table public.restaurant_website_sections  enable row level security;
alter table public.restaurant_website_revisions enable row level security;
alter table public.restaurant_website_sections  force row level security;
alter table public.restaurant_website_revisions force row level security;

create policy restaurant_website_sections_select on public.restaurant_website_sections
  for select to authenticated
  using (app.has_permission(organization_id, 'settings.manage'));

create policy restaurant_website_sections_insert on public.restaurant_website_sections
  for insert to authenticated
  with check (app.has_permission(organization_id, 'settings.manage'));

-- USING and WITH CHECK both, so a row can never be moved into another
-- organization by an update.
create policy restaurant_website_sections_update on public.restaurant_website_sections
  for update to authenticated
  using (app.has_permission(organization_id, 'settings.manage'))
  with check (app.has_permission(organization_id, 'settings.manage'));

create policy restaurant_website_sections_delete on public.restaurant_website_sections
  for delete to authenticated
  using (app.has_permission(organization_id, 'settings.manage'));

-- Revisions are readable by the tenant and written only by the publish
-- function below. No insert, update or delete policy: append-only in practice
-- as well as in intent.
create policy restaurant_website_revisions_select on public.restaurant_website_revisions
  for select to authenticated
  using (app.has_permission(organization_id, 'settings.manage'));

revoke all on public.restaurant_website_sections  from anon;
revoke all on public.restaurant_website_revisions from anon;
grant select, insert, update, delete on public.restaurant_website_sections  to authenticated;
grant select                         on public.restaurant_website_revisions to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Publish.
--
-- Validates, snapshots and flips the live pointer in one transaction. The
-- snapshot is built from the draft rows by the database, not handed in by the
-- caller, so what goes live is what the builder actually holds.
-- ---------------------------------------------------------------------------
create or replace function public.restaurant_website_publish(
  p_org_slug text,
  p_note     text default null
)
returns table (out_version int, out_section_count int)
language plpgsql security definer set search_path = '' as $$
declare
  v_org      uuid;
  v_sections jsonb;
  v_theme    jsonb;
  v_version  int;
  v_count    int;
begin
  -- Tenant context from the slug plus the caller's own membership. The browser
  -- never names an organization id, and a slug the caller has no permission on
  -- resolves to nothing.
  select o.id into v_org
  from public.organizations o
  join public.organization_modules m
    on m.organization_id = o.id and m.module_key = 'restaurant' and m.enabled
  where lower(o.slug::text) = lower(trim(p_org_slug))
    and o.status = 'active' and o.deleted_at is null
    and app.has_permission(o.id, 'settings.manage')
  limit 1;

  if v_org is null then
    raise exception 'website not found' using errcode = 'check_violation';
  end if;

  select jsonb_agg(
           jsonb_build_object(
             'type', s.section_type,
             'sort_order', s.sort_order,
             'config', s.config
           ) order by s.sort_order, s.id
         ),
         count(*)
    into v_sections, v_count
  from public.restaurant_website_sections s
  where s.organization_id = v_org and s.enabled;

  -- A site with nothing switched on is not a site. Publishing it would blank
  -- the restaurant's public page, so it is refused rather than obeyed.
  if v_count = 0 then
    raise exception 'أضف قسمًا واحدًا على الأقل قبل النشر' using errcode = 'check_violation';
  end if;

  select coalesce(s.value, '{}'::jsonb) into v_theme
  from public.settings s
  where s.organization_id = v_org and s.branch_id is null
    and s.key = 'restaurant.website_theme';

  select coalesce(max(r.version), 0) + 1 into v_version
  from public.restaurant_website_revisions r where r.organization_id = v_org;

  -- Demote the current live revision before promoting the new one: the partial
  -- unique index allows exactly one, and both statements are in this
  -- transaction, so there is no moment with two live or none.
  update public.restaurant_website_revisions
     set is_live = false
   where organization_id = v_org and is_live;

  insert into public.restaurant_website_revisions
    (organization_id, version, sections, theme, is_live, published_by, note)
  values (v_org, v_version, v_sections, coalesce(v_theme, '{}'::jsonb), true, auth.uid(),
          nullif(left(trim(coalesce(p_note, '')), 500), ''));

  insert into public.audit_logs
    (organization_id, branch_id, actor_id, actor_label, action,
     entity_type, entity_id, after)
  values (
    v_org, null, auth.uid(),
    (select p.full_name from public.profiles p where p.id = auth.uid()),
    'restaurant.website_published', 'website', v_version::text,
    jsonb_build_object('version', v_version, 'sections', v_count)
  );

  return query select v_version, v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Unpublish.
--
-- Takes the custom layout down without destroying its history: the revision
-- stays, it simply stops being live, and the public site falls back to the
-- default layout. Nothing is deleted.
-- ---------------------------------------------------------------------------
create or replace function public.restaurant_website_unpublish(p_org_slug text)
returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid;
begin
  select o.id into v_org
  from public.organizations o
  where lower(o.slug::text) = lower(trim(p_org_slug))
    and o.deleted_at is null
    and app.has_permission(o.id, 'settings.manage')
  limit 1;

  if v_org is null then
    raise exception 'website not found' using errcode = 'check_violation';
  end if;

  update public.restaurant_website_revisions
     set is_live = false
   where organization_id = v_org and is_live;

  insert into public.audit_logs
    (organization_id, branch_id, actor_id, actor_label, action,
     entity_type, entity_id, after)
  values (
    v_org, null, auth.uid(),
    (select p.full_name from public.profiles p where p.id = auth.uid()),
    'restaurant.website_unpublished', 'website', 'live', '{}'::jsonb
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. What the public site renders.
--
-- The live revision, or nothing. Gated on the same published-website check
-- every other public function uses, so switching the website off hides the
-- custom layout exactly as it hides everything else.
--
-- Returns no draft column and touches no draft table. A restaurant that has
-- never published returns zero rows and the site renders its default layout.
-- ---------------------------------------------------------------------------
create or replace function public.restaurant_website_layout(p_org_slug text)
returns table (version int, sections jsonb, theme jsonb, published_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare v record;
begin
  select * into v from app.restaurant_website_org(p_org_slug);
  if v.org_id is null then
    return;
  end if;

  return query
  select r.version, r.sections, r.theme, r.published_at
  from public.restaurant_website_revisions r
  where r.organization_id = v.org_id and r.is_live
  limit 1;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Grants.
--
-- PUBLIC first: Postgres grants EXECUTE to PUBLIC on creation, and a later
-- grant to a role would not take it away (the lesson of 0028).
--
-- The layout read is anonymous, because the public site is. Publishing and
-- unpublishing are `authenticated` only and re-check the permission inside.
-- ---------------------------------------------------------------------------
revoke all on function app.check_website_section() from public, anon, authenticated;

-- The two predicates are granted to `authenticated` because the validation
-- trigger runs as the writer, not as an owner — a BEFORE trigger that only
-- checks its input has no business being SECURITY DEFINER. Both are pure
-- functions of their arguments: they read no table, hold no state and reveal
-- nothing the caller did not already pass in, so executing one is equivalent
-- to running a regex.
revoke all on function app.website_text_ok(text, int) from public, anon;
revoke all on function app.website_image_ok(text)     from public, anon;
grant execute on function app.website_text_ok(text, int) to authenticated;
grant execute on function app.website_image_ok(text)     to authenticated;

revoke all on function public.restaurant_website_publish(text, text) from public, anon;
revoke all on function public.restaurant_website_unpublish(text)     from public, anon;
grant execute on function public.restaurant_website_publish(text, text) to authenticated;
grant execute on function public.restaurant_website_unpublish(text)     to authenticated;

revoke all on function public.restaurant_website_layout(text) from public;
grant execute on function public.restaurant_website_layout(text) to anon, authenticated;
