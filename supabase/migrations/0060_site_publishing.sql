-- =============================================================================
-- LOCAL BASIC — 0060 Site Engine publishing
--
-- sites.status has existed since 0055 and meant nothing: nothing read it, and
-- a site marked 'published' was published nowhere. This gives it a referent.
--
-- WHAT PUBLISHING IS HERE
--
-- A revision is a FROZEN SNAPSHOT of a site's pages, sections and settings at
-- one moment, taken from the draft rows and never read back into them. The
-- draft keeps changing; the live revision does not. That separation is the
-- whole feature — without it "publish" would just mean "the draft is now
-- visible", and every half-finished edit would be live the second it was saved.
--
-- Modelled on restaurant_website_revisions (0042) and platform_website_versions
-- (0051), because a third shape for the same idea would be a third thing to
-- reason about. Same partial unique index for one-live, same demote-then-
-- promote inside one transaction, same audit entry.
--
-- APPEND-ONLY, ENFORCED THREE WAYS
--
--   1. No INSERT, UPDATE or DELETE grant exists on the table for any role.
--      Only the definer functions below can write it.
--   2. A trigger refuses any UPDATE that changes anything except is_live, so
--      even a future function cannot rewrite a snapshot in place.
--   3. There are no policies for insert, update or delete, so FORCE RLS has
--      nothing to permit.
--
-- WHY THE FUNCTIONS ARE SECURITY DEFINER
--
-- Because of (1). A table nobody may insert into is what makes a ledger
-- append-only, and a function that writes it must therefore run as the owner.
-- This is the pattern 0042 established for exactly this reason.
--
-- The elevation is bounded by what they do with it. Each one takes a SITE id,
-- resolves the organization FROM THE SITE ROW, and refuses unless the caller
-- holds `site.manage` on that organization — so the id names which site to act
-- on and never who may act. `set search_path = ''` throughout.
--
-- WHAT IS NOT HERE
--
-- No public route, no slug resolution, no custom domain, no cache policy.
-- Publishing records what is live; serving it is the next phase, and it is
-- still blocked on a decision this migration deliberately does not make:
-- sites.slug is unique per ORGANIZATION, not globally, so a published site is
-- not yet addressable by slug alone.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. The revisions.
-- ---------------------------------------------------------------------------
create table public.site_revisions (
  id           uuid primary key default gen_random_uuid(),
  site_id      uuid not null references public.sites(id) on delete cascade,
  -- Denormalised from the site so a revision can be authorized and audited
  -- without joining a row that might have been deleted. 0056 forbids a site
  -- changing organization, so this cannot drift.
  organization_id uuid not null references public.organizations(id) on delete cascade,
  version      int not null check (version > 0),
  -- The frozen snapshot: pages, their sections, and the site's settings, in
  -- render order. Shape is checked below.
  snapshot     jsonb not null,
  is_live      boolean not null default false,
  published_at timestamptz not null default now(),
  published_by uuid references public.profiles(id) on delete set null,
  note         text check (length(note) <= 500),
  unique (site_id, version)
);

-- Exactly one live revision per site, enforced by the database rather than by
-- whichever code path wrote last.
create unique index site_revisions_one_live
  on public.site_revisions(site_id) where is_live;

create index site_revisions_site_idx
  on public.site_revisions(site_id, version desc);

-- ---------------------------------------------------------------------------
-- 2. A snapshot's shape.
--
-- Checked on write so a malformed one cannot become the thing a public route
-- renders. Deliberately structural — pages are a list, each page has a slug
-- and a list of sections — and NOT a re-validation of section content: that
-- already passed app.check_site_section_content() on its way into the draft,
-- and repeating it here would be a second copy of the same rules to keep in
-- step.
-- ---------------------------------------------------------------------------
create or replace function app.check_site_snapshot()
returns trigger language plpgsql set search_path = '' as $$
declare v_page jsonb;
begin
  if jsonb_typeof(new.snapshot) <> 'object' then
    raise exception 'a snapshot must be an object' using errcode = '22023';
  end if;
  if jsonb_typeof(new.snapshot -> 'pages') <> 'array' then
    raise exception 'a snapshot must carry a list of pages' using errcode = '22023';
  end if;
  -- A site with no pages has nothing to serve. Publishing one would put an
  -- empty address live, so it is refused rather than obeyed.
  if jsonb_array_length(new.snapshot -> 'pages') = 0 then
    raise exception 'a snapshot must carry at least one page' using errcode = '22023';
  end if;

  for v_page in select * from jsonb_array_elements(new.snapshot -> 'pages') loop
    if jsonb_typeof(v_page) <> 'object'
       or coalesce(v_page ->> 'slug', '') = ''
       or jsonb_typeof(v_page -> 'sections') <> 'array' then
      raise exception 'every page in a snapshot needs a slug and a list of sections'
        using errcode = '22023';
    end if;
  end loop;

  -- Exactly one homepage, the same invariant 0058 holds over the draft. A
  -- snapshot that lost it would render a site with no entry point.
  if (select count(*) from jsonb_array_elements(new.snapshot -> 'pages') p
       where (p ->> 'isHomepage')::boolean) <> 1 then
    raise exception 'a snapshot must have exactly one homepage' using errcode = '22023';
  end if;

  return new;
end;
$$;

create trigger site_revisions_snapshot_check
  before insert on public.site_revisions
  for each row execute function app.check_site_snapshot();

-- ---------------------------------------------------------------------------
-- 3. Immutability.
--
-- is_live moves — that is how rollback works, and how 0042's unpublish works.
-- Everything else about a published revision is history and does not.
--
-- This is belt to the grants' braces: no role can UPDATE the table at all, so
-- only a definer function could try. The trigger means that even a future
-- function, written by someone who has forgotten this file, cannot rewrite
-- what was published on a given day.
-- ---------------------------------------------------------------------------
create or replace function app.check_site_revision_immutable()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.id is distinct from old.id
     or new.site_id is distinct from old.site_id
     or new.organization_id is distinct from old.organization_id
     or new.version is distinct from old.version
     or new.snapshot is distinct from old.snapshot
     or new.published_at is distinct from old.published_at
     or new.published_by is distinct from old.published_by
     or new.note is distinct from old.note then
    raise exception 'a published revision cannot be changed; only is_live moves'
      using errcode = '22023';
  end if;
  return new;
end;
$$;

create trigger site_revisions_immutable
  before update on public.site_revisions
  for each row execute function app.check_site_revision_immutable();

-- ---------------------------------------------------------------------------
-- 4. Row level security.
--
-- SELECT only, and only for a member who may read the site. There is no
-- insert, update or delete policy and no such grant: the table is written
-- exclusively by the definer functions below, which is what append-only means
-- here.
-- ---------------------------------------------------------------------------
alter table public.site_revisions enable row level security;
alter table public.site_revisions force row level security;

create policy site_revisions_select on public.site_revisions
  for select to authenticated
  using (app.has_permission(organization_id, 'site.read'));

revoke all on public.site_revisions from anon, authenticated;
grant select on public.site_revisions to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Building a snapshot.
--
-- One place that decides what a published site contains, so publish and any
-- later caller cannot disagree about it.
--
-- HIDDEN SECTIONS ARE EXCLUDED, matching 0042, which snapshots only enabled
-- sections. Hiding a section and publishing is how you take it down; showing
-- it again needs another publish, which is the point of a draft/live split.
--
-- SECURITY DEFINER because its callers are, and because it must see the site's
-- rows regardless of whether the publishing caller holds `site.read` as well as
-- `site.manage` — the catalog keeps those separate. It reads and returns a
-- snapshot of ONE site, named by its caller, which has already checked
-- permission on that site.
-- ---------------------------------------------------------------------------
create or replace function app.site_snapshot(p_site uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'site', jsonb_build_object(
      'id', s.id,
      'name', s.name,
      'slug', s.slug::text,
      'templateId', s.template_id
    ),
    'settings', coalesce(
      (select st.settings from public.site_settings st where st.site_id = s.id),
      '{}'::jsonb
    ),
    'pages', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', p.id,
          'title', p.title,
          'slug', p.slug::text,
          'isHomepage', p.is_homepage,
          'sortOrder', p.sort_order,
          'sections', coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'id', sec.id,
                'sectionType', sec.section_type,
                'content', sec.content,
                'sortOrder', sec.sort_order
              ) order by sec.sort_order, sec.id
            )
            from public.site_sections sec
            where sec.page_id = p.id and sec.is_visible
          ), '[]'::jsonb)
        ) order by p.sort_order, p.id
      )
      from public.site_pages p where p.site_id = s.id
    ), '[]'::jsonb)
  )
  from public.sites s where s.id = p_site;
$$;

revoke all on function app.site_snapshot(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. Publish.
--
-- Freezes the current draft as the next version and makes it live. The demote
-- and the promote are in one transaction, so there is never a moment with two
-- live revisions or none.
-- ---------------------------------------------------------------------------
create or replace function public.site_publish(p_site uuid, p_note text default null)
returns table (out_version int, out_revision uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_org      uuid;
  v_snapshot jsonb;
  v_version  int;
  v_id       uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  -- The organization comes from the SITE ROW, never from the caller. The id
  -- names which site to publish; it does not assert who may publish it.
  select s.organization_id into v_org from public.sites s where s.id = p_site;
  if v_org is null then
    raise exception 'site not found' using errcode = '22023';
  end if;
  if not app.has_permission(v_org, 'site.manage') then
    raise exception 'site.manage required' using errcode = 'insufficient_privilege';
  end if;

  v_snapshot := app.site_snapshot(p_site);

  select coalesce(max(r.version), 0) + 1 into v_version
    from public.site_revisions r where r.site_id = p_site;

  update public.site_revisions set is_live = false
   where site_id = p_site and is_live;

  insert into public.site_revisions
    (site_id, organization_id, version, snapshot, is_live, published_by, note)
  values (p_site, v_org, v_version, v_snapshot, true, auth.uid(),
          nullif(left(btrim(coalesce(p_note, '')), 500), ''))
  returning id into v_id;

  -- What `status` has meant since 0055, finally: there is a live revision.
  update public.sites set status = 'published' where id = p_site;

  insert into public.audit_logs
    (organization_id, branch_id, actor_id, actor_label, action,
     entity_type, entity_id, after)
  values (
    v_org, null, auth.uid(),
    (select p.full_name from public.profiles p where p.id = auth.uid()),
    'site.published', 'site', p_site::text,
    jsonb_build_object('version', v_version, 'revision', v_id)
  );

  return query select v_version, v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Rollback.
--
-- Makes a PREVIOUS revision live again, by id. Nothing is copied and nothing
-- is rewritten: the snapshot that was published on that day is the snapshot
-- that goes back up, which is the only reading of "rollback" that is worth
-- having. The revision must belong to this site — a revision id from another
-- site resolves to nothing rather than to someone else's content.
-- ---------------------------------------------------------------------------
create or replace function public.site_rollback(p_site uuid, p_revision uuid)
returns int language plpgsql security definer set search_path = '' as $$
declare
  v_org     uuid;
  v_version int;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  select s.organization_id into v_org from public.sites s where s.id = p_site;
  if v_org is null then
    raise exception 'site not found' using errcode = '22023';
  end if;
  if not app.has_permission(v_org, 'site.manage') then
    raise exception 'site.manage required' using errcode = 'insufficient_privilege';
  end if;

  -- Scoped to the site, so a revision id belonging to another site is simply
  -- not found — the same answer a made-up id gets.
  select r.version into v_version
    from public.site_revisions r
   where r.id = p_revision and r.site_id = p_site;
  if v_version is null then
    raise exception 'revision not found' using errcode = '22023';
  end if;

  update public.site_revisions set is_live = false
   where site_id = p_site and is_live and id <> p_revision;
  update public.site_revisions set is_live = true
   where id = p_revision and not is_live;

  update public.sites set status = 'published' where id = p_site;

  insert into public.audit_logs
    (organization_id, branch_id, actor_id, actor_label, action,
     entity_type, entity_id, after)
  values (
    v_org, null, auth.uid(),
    (select p.full_name from public.profiles p where p.id = auth.uid()),
    'site.rolled_back', 'site', p_site::text,
    jsonb_build_object('version', v_version, 'revision', p_revision)
  );

  return v_version;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Unpublish.
--
-- Takes the site down without destroying its history: the revision stays, it
-- simply stops being live. Nothing is deleted, and republishing an old version
-- is still one rollback away.
-- ---------------------------------------------------------------------------
create or replace function public.site_unpublish(p_site uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_org uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  select s.organization_id into v_org from public.sites s where s.id = p_site;
  if v_org is null then
    raise exception 'site not found' using errcode = '22023';
  end if;
  if not app.has_permission(v_org, 'site.manage') then
    raise exception 'site.manage required' using errcode = 'insufficient_privilege';
  end if;

  update public.site_revisions set is_live = false where site_id = p_site and is_live;
  update public.sites set status = 'draft' where id = p_site;

  insert into public.audit_logs
    (organization_id, branch_id, actor_id, actor_label, action,
     entity_type, entity_id, after)
  values (
    v_org, null, auth.uid(),
    (select p.full_name from public.profiles p where p.id = auth.uid()),
    'site.unpublished', 'site', p_site::text, '{}'::jsonb
  );
end;
$$;

revoke all on function public.site_publish(uuid, text)   from public, anon;
revoke all on function public.site_rollback(uuid, uuid)  from public, anon;
revoke all on function public.site_unpublish(uuid)       from public, anon;
grant execute on function public.site_publish(uuid, text)  to authenticated;
grant execute on function public.site_rollback(uuid, uuid) to authenticated;
grant execute on function public.site_unpublish(uuid)      to authenticated;
