-- =============================================================================
-- LOCAL BASIC — 0061 Site Engine, operated by Platform Admin
--
-- WHY THIS DOES NOT TOUCH 0055-0060
--
-- 0055 says it plainly: sites belongs to tenant RBAC, gated by
-- app.has_permission(organization_id, 'site.*'), and platform_websites is the
-- OTHER website system, gated by app.is_platform_admin() and never joined to
-- tenant RLS. platform/admin/context.ts says the same thing about identity:
-- "Platform Admin ... Deliberately NOT part of TenantContext ... The two
-- authorization systems never meet."
--
-- Widening app.site_can_read/app.site_can_manage, or the sites_* policies, to
-- also accept app.is_platform_admin() would make that true no longer, and
-- would do it silently for every existing policy built on those four helpers
-- — including page and section CRUD and site deletion, which is far more than
-- "customize the theme". So none of that is touched here.
--
-- Instead this follows the OTHER precedent already in the codebase: 0032 and
-- 0041's platform_* functions. Every one of those is its own SECURITY DEFINER
-- function that calls app.require_platform_admin() itself and is granted to
-- authenticated wholesale — the function is the gate, not a table policy.
-- Nothing on sites/site_pages/site_sections/site_settings/site_revisions
-- changes: no new policy, no widened helper. A Platform Admin still cannot
-- see a row in those tables through ordinary PostgREST/RLS access. They reach
-- them only through the seven functions below, each scoped to exactly the
-- operation named.
--
-- WHAT A PLATFORM ADMIN MAY DO HERE, AND NOT MORE
--
-- List an organization's sites, read one site's structure and settings well
-- enough to orient in the existing editor and preview it, update its THEME
-- (site_settings.settings — the same shape and the same Zod schema the
-- tenant appearance editor writes), and drive the SAME publish / rollback /
-- unpublish machinery tenants use (site_revisions, its one-live-per-site
-- index, its immutability trigger — all from 0060, unmodified).
--
-- What is deliberately absent: creating, renaming, reordering or deleting a
-- page or a section, renaming or deleting a site. A Platform Admin operating
-- a customer's THEME is not the same authority as operating their COPY, and
-- granting the second because the first was asked for is not this migration's
-- call to make.
--
-- Every function resolves the organization FROM THE SITE ROW (or the site
-- from the (customer_code, site_id) pair), the same rule 0060 states for its
-- own functions: an id names which site to act on, never who may act on it.
-- Every write is audited into audit_logs with the site's real
-- organization_id, exactly as 0060's own functions are, so an operator's
-- theme change appears on the SAME customer timeline app.platform_customer_audit
-- (0041) already reads — no new audit surface, no new screen to build for it.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Resolve a site scoped to a customer code, for an admin only.
--
-- Mirrors app.platform_customer_org (0041): null for a code that resolves to
-- no organization, a site that does not belong to it, or a caller who is not
-- an admin — every caller of this gets the same "not found" for all three,
-- so a probing request cannot tell which one it hit.
-- ---------------------------------------------------------------------------
create or replace function app.platform_customer_site(p_customer_code text, p_site uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select s.id
  from public.sites s
  join public.organizations o on o.id = s.organization_id
  where app.is_platform_admin()
    and s.id = p_site
    and upper(o.customer_code) = upper(trim(p_customer_code))
  limit 1;
$$;

-- ---------------------------------------------------------------------------
-- 2. List an organization's sites — the picker.
-- ---------------------------------------------------------------------------
create or replace function public.platform_site_list(p_customer_code text)
returns table (
  id         uuid,
  name       text,
  slug       text,
  status     text,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid;
begin
  perform app.require_platform_admin();
  v_org := app.platform_customer_org(p_customer_code);
  if v_org is null then
    return;
  end if;

  return query
  select s.id, s.name, s.slug::text, s.status, s.created_at, s.updated_at
  from public.sites s
  where s.organization_id = v_org
  order by s.created_at;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. One site's detail: enough to orient in the read-only editor, to drive
--    the Theme Customizer's live preview, and to know what is currently live.
--
-- `snapshot` reuses app.site_snapshot(), the exact function site_publish()
-- freezes into a revision — the DRAFT, in the same shape site_revisions
-- stores it, which is what parseSnapshot() on the TypeScript side already
-- knows how to read. No second projection of "what a site contains" exists.
-- ---------------------------------------------------------------------------
create or replace function public.platform_site_detail(p_customer_code text, p_site uuid)
returns table (
  organization_id     uuid,
  organization_name   text,
  organization_code   text,
  organization_currency text,
  site_name           text,
  site_slug           text,
  site_status         text,
  site_created_at     timestamptz,
  site_updated_at     timestamptz,
  settings            jsonb,
  snapshot            jsonb,
  live_version        int,
  live_published_at   timestamptz,
  live_note           text,
  -- The live revision's OWN frozen snapshot, not the draft's — so the caller
  -- can tell whether the draft has moved since publish (draftDiffersFrom, the
  -- same comparison the tenant editor makes) without a second round trip.
  live_snapshot       jsonb
)
language plpgsql stable security definer set search_path = '' as $$
declare v_site uuid;
begin
  perform app.require_platform_admin();
  v_site := app.platform_customer_site(p_customer_code, p_site);
  if v_site is null then
    return;
  end if;

  return query
  select
    o.id, o.name, o.customer_code, o.currency::text,
    s.name, s.slug::text, s.status, s.created_at, s.updated_at,
    coalesce((select st.settings from public.site_settings st where st.site_id = s.id), '{}'::jsonb),
    app.site_snapshot(s.id),
    r.version, r.published_at, r.note, r.snapshot
  from public.sites s
  join public.organizations o on o.id = s.organization_id
  left join public.site_revisions r on r.site_id = s.id and r.is_live
  where s.id = v_site;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Revision history — the rollback list.
-- ---------------------------------------------------------------------------
create or replace function public.platform_site_revisions_list(p_customer_code text, p_site uuid)
returns table (
  id                 uuid,
  version            int,
  is_live            boolean,
  published_at       timestamptz,
  published_by_name  text,
  note               text
)
language plpgsql stable security definer set search_path = '' as $$
declare v_site uuid;
begin
  perform app.require_platform_admin();
  v_site := app.platform_customer_site(p_customer_code, p_site);
  if v_site is null then
    return;
  end if;

  return query
  select r.id, r.version, r.is_live, r.published_at,
         (select p.full_name from public.profiles p where p.id = r.published_by),
         r.note
  from public.site_revisions r
  where r.site_id = v_site
  order by r.version desc;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Update the theme.
--
-- Takes the WHOLE settings object, already merged and validated on the
-- TypeScript side against the same siteSettingsSchema/updateAppearanceSchema
-- the tenant editor uses — this function does not re-decide the shape, it
-- writes what it is given to the one column that holds it, the same column
-- updateAppearance() (tenant) writes. Draft only: nothing here touches
-- site_revisions or sites.status, so a theme edit is not live until a
-- publish call says so, exactly like every other draft edit in this system.
-- ---------------------------------------------------------------------------
create or replace function public.platform_site_theme_update(
  p_customer_code text,
  p_site          uuid,
  p_settings      jsonb
)
returns void language plpgsql security definer set search_path = '' as $$
declare v_site uuid; v_org uuid;
begin
  perform app.require_platform_admin();
  v_site := app.platform_customer_site(p_customer_code, p_site);
  if v_site is null then
    raise exception 'site not found' using errcode = '22023';
  end if;

  select organization_id into v_org from public.sites where id = v_site;

  update public.site_settings set settings = p_settings where site_id = v_site;
  if not found then
    raise exception 'site not found' using errcode = '22023';
  end if;

  insert into public.audit_logs
    (organization_id, branch_id, actor_id, actor_label, action,
     entity_type, entity_id, after)
  values (
    v_org, null, auth.uid(),
    (select full_name from public.profiles where id = auth.uid()),
    'site.theme_updated_by_platform_admin', 'site', v_site::text,
    p_settings
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Publish, rollback, unpublish.
--
-- Same mechanics as public.site_publish/site_rollback/site_unpublish (0060):
-- same demote-then-promote in one transaction, same append-only revision,
-- same immutability trigger, same one-live-per-site unique index. The only
-- difference is the guard — app.require_platform_admin() in place of
-- app.has_permission(v_org, 'site.manage') — because a Platform Admin session
-- holds no tenant permission to check, by the design 0055 and context.ts both
-- state. Duplicated rather than shared, the same way 0060 itself duplicates
-- restaurant_website_revisions (0042) and platform_website_versions (0051)
-- instead of factoring a generic publisher: three subsystems that happen to
-- share a shape are not one subsystem, and a shared helper would be a fourth
-- thing to keep in step with all three call sites' authorization rules.
-- ---------------------------------------------------------------------------
create or replace function public.platform_site_publish(
  p_customer_code text,
  p_site          uuid,
  p_note          text default null
)
returns table (out_version int, out_revision uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_site uuid; v_org uuid; v_snapshot jsonb; v_version int; v_id uuid;
begin
  perform app.require_platform_admin();
  v_site := app.platform_customer_site(p_customer_code, p_site);
  if v_site is null then
    raise exception 'site not found' using errcode = '22023';
  end if;

  select organization_id into v_org from public.sites where id = v_site;
  v_snapshot := app.site_snapshot(v_site);

  select coalesce(max(r.version), 0) + 1 into v_version
    from public.site_revisions r where r.site_id = v_site;

  update public.site_revisions set is_live = false
   where site_id = v_site and is_live;

  insert into public.site_revisions
    (site_id, organization_id, version, snapshot, is_live, published_by, note)
  values (v_site, v_org, v_version, v_snapshot, true, auth.uid(),
          nullif(left(btrim(coalesce(p_note, '')), 500), ''))
  returning id into v_id;

  update public.sites set status = 'published' where id = v_site;

  insert into public.audit_logs
    (organization_id, branch_id, actor_id, actor_label, action,
     entity_type, entity_id, after)
  values (
    v_org, null, auth.uid(),
    (select full_name from public.profiles where id = auth.uid()),
    'site.published_by_platform_admin', 'site', v_site::text,
    jsonb_build_object('version', v_version, 'revision', v_id)
  );

  return query select v_version, v_id;
end;
$$;

create or replace function public.platform_site_rollback(
  p_customer_code text,
  p_site          uuid,
  p_revision      uuid
)
returns int language plpgsql security definer set search_path = '' as $$
declare v_site uuid; v_org uuid; v_version int;
begin
  perform app.require_platform_admin();
  v_site := app.platform_customer_site(p_customer_code, p_site);
  if v_site is null then
    raise exception 'site not found' using errcode = '22023';
  end if;

  select organization_id into v_org from public.sites where id = v_site;

  select r.version into v_version
    from public.site_revisions r
   where r.id = p_revision and r.site_id = v_site;
  if v_version is null then
    raise exception 'revision not found' using errcode = '22023';
  end if;

  update public.site_revisions set is_live = false
   where site_id = v_site and is_live and id <> p_revision;
  update public.site_revisions set is_live = true
   where id = p_revision and not is_live;

  update public.sites set status = 'published' where id = v_site;

  insert into public.audit_logs
    (organization_id, branch_id, actor_id, actor_label, action,
     entity_type, entity_id, after)
  values (
    v_org, null, auth.uid(),
    (select full_name from public.profiles where id = auth.uid()),
    'site.rolled_back_by_platform_admin', 'site', v_site::text,
    jsonb_build_object('version', v_version, 'revision', p_revision)
  );

  return v_version;
end;
$$;

create or replace function public.platform_site_unpublish(p_customer_code text, p_site uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_site uuid; v_org uuid;
begin
  perform app.require_platform_admin();
  v_site := app.platform_customer_site(p_customer_code, p_site);
  if v_site is null then
    raise exception 'site not found' using errcode = '22023';
  end if;

  select organization_id into v_org from public.sites where id = v_site;

  update public.site_revisions set is_live = false where site_id = v_site and is_live;
  update public.sites set status = 'draft' where id = v_site;

  insert into public.audit_logs
    (organization_id, branch_id, actor_id, actor_label, action,
     entity_type, entity_id, after)
  values (
    v_org, null, auth.uid(),
    (select full_name from public.profiles where id = auth.uid()),
    'site.unpublished_by_platform_admin', 'site', v_site::text, '{}'::jsonb
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Grants. PUBLIC first so a later narrower grant is not a no-op (0028),
-- then authenticated — the function is the gate, per app.require_platform_admin().
-- ---------------------------------------------------------------------------
revoke all on function app.platform_customer_site(text, uuid) from public, anon;
grant execute on function app.platform_customer_site(text, uuid) to authenticated;

revoke all on function public.platform_site_list(text)                    from public, anon;
revoke all on function public.platform_site_detail(text, uuid)            from public, anon;
revoke all on function public.platform_site_revisions_list(text, uuid)    from public, anon;
revoke all on function public.platform_site_theme_update(text, uuid, jsonb) from public, anon;
revoke all on function public.platform_site_publish(text, uuid, text)     from public, anon;
revoke all on function public.platform_site_rollback(text, uuid, uuid)    from public, anon;
revoke all on function public.platform_site_unpublish(text, uuid)         from public, anon;

grant execute on function public.platform_site_list(text)                    to authenticated;
grant execute on function public.platform_site_detail(text, uuid)            to authenticated;
grant execute on function public.platform_site_revisions_list(text, uuid)    to authenticated;
grant execute on function public.platform_site_theme_update(text, uuid, jsonb) to authenticated;
grant execute on function public.platform_site_publish(text, uuid, text)     to authenticated;
grant execute on function public.platform_site_rollback(text, uuid, uuid)    to authenticated;
grant execute on function public.platform_site_unpublish(text, uuid)         to authenticated;
