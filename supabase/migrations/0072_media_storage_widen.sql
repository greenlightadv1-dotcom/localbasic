-- =============================================================================
-- LOCAL BASIC — 0072 Widen media Storage writes to any active org member
--
-- 0069 gated INSERT/UPDATE/DELETE on the media bucket to whichever of
-- branding.manage / site.manage / restaurant.menu.manage the caller held.
-- In practice that meant a role missing exactly the right one of those three
-- (a 'manager', who has restaurant.menu.manage but not site.manage; an
-- 'admin', who has branding.manage + restaurant.menu.manage but not
-- site.manage) hit "new row violates row-level security policy" the moment
-- they opened an upload widget that happened to require a different
-- permission than the one their role was granted — reported as a storage
-- bug, but really a mismatch between which screen required which
-- permission and which roles held it.
--
-- Storage is not where that authorization belongs. Uploading a file to
-- Storage does not, by itself, put its URL anywhere: every screen's own
-- server action (setProductImageAction, setCategoryImageAction, the site
-- section actions, updateBrandingAction, …) re-checks the specific
-- permission it always has, before writing that URL into
-- branding_settings / restaurant_products / restaurant_categories /
-- restaurant_bundles / site_sections. So gating Storage itself down to one
-- specific permission bought no real protection — it only meant the wrong
-- role saw an opaque RLS error instead of the upload just working and the
-- follow-up save being the thing that (correctly) refuses them.
--
-- The new rule: any ACTIVE member of the organization named by the path may
-- write into that organization's own folder. Cross-organization writes are
-- still impossible — the path's own org id is still the check.
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
