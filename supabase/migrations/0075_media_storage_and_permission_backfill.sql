-- =============================================================================
-- LOCAL BASIC — 0075 Media Storage RLS + permission-catalog backfill
--
-- THE "new row violates row-level security policy" REPORT, ROOT-CAUSED.
--
-- Two separate things were wrong, and only one of them was Storage:
--
-- 1) storage.objects' media_insert/media_update/media_delete policies had
--    drifted, outside of any tracked migration, to a bare `bucket_id =
--    'media'` check with no organization scoping at all — wide open to any
--    authenticated user of ANY organization, not just the one narrowing
--    0072 intended. This restores the org-scoped, any-active-member check
--    0072 already designed (org id embedded in the path, checked against
--    organization_members), as a tracked migration this time so it cannot
--    silently drift again.
--
-- 2) The upload itself was never the actual failure for the reports that
--    kept recurring after 0072 shipped. Querying production directly: the
--    live organization's `admin` role is missing `site.manage` and
--    `site.read`, and its `cashier` role is missing three retail
--    permissions — while the current system role template (roles with
--    organization_id is null, is_system = true) grants all of them for
--    those same role keys. This organization was provisioned before the
--    permission catalog picked up `site.*` (site engine) and those retail
--    keys, and nothing ever backfilled it. So: an admin uploads a banner
--    image (Storage now happily accepts it), the website builder then
--    tries to save that image onto a site_sections/site_pages row, which
--    is gated by app.site_can_manage() -> app.has_permission(org,
--    'site.manage') — the admin doesn't hold it, and Postgres returns
--    exactly "new row violates row-level security policy for table
--    site_sections". Same error text, wrong table, not fixable in Storage
--    at all.
--
-- The backfill is strictly additive: for every real (non-system) role,
-- insert whichever permissions the system template grants the same role
-- key that this role is still missing. It never removes a permission an
-- org was deliberately given beyond the template, and it is idempotent —
-- re-running this migration inserts nothing the first run already added.
-- =============================================================================

drop policy if exists media_insert on storage.objects;
drop policy if exists media_update on storage.objects;
drop policy if exists media_delete on storage.objects;

create policy media_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'media'
    and app.media_path_org(name) is not null
    and exists (
      select 1 from public.organization_members m
      where m.user_id = auth.uid()
        and m.organization_id = app.media_path_org(name)
        and m.status = 'active'
    )
  );

create policy media_update on storage.objects for update to authenticated
  using (
    bucket_id = 'media'
    and app.media_path_org(name) is not null
    and exists (
      select 1 from public.organization_members m
      where m.user_id = auth.uid()
        and m.organization_id = app.media_path_org(name)
        and m.status = 'active'
    )
  )
  with check (
    bucket_id = 'media'
    and app.media_path_org(name) is not null
    and exists (
      select 1 from public.organization_members m
      where m.user_id = auth.uid()
        and m.organization_id = app.media_path_org(name)
        and m.status = 'active'
    )
  );

create policy media_delete on storage.objects for delete to authenticated
  using (
    bucket_id = 'media'
    and app.media_path_org(name) is not null
    and exists (
      select 1 from public.organization_members m
      where m.user_id = auth.uid()
        and m.organization_id = app.media_path_org(name)
        and m.status = 'active'
    )
  );

insert into public.role_permissions (role_id, permission_key)
select org_role.id, template_perm.permission_key
from public.roles org_role
join public.roles template_role
  on template_role.organization_id is null
  and template_role.is_system = true
  and template_role.key = org_role.key
join public.role_permissions template_perm
  on template_perm.role_id = template_role.id
where org_role.organization_id is not null
  and not exists (
    select 1 from public.role_permissions existing
    where existing.role_id = org_role.id
      and existing.permission_key = template_perm.permission_key
  )
on conflict do nothing;
