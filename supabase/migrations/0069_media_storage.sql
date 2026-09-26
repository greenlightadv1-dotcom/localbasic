-- =============================================================================
-- LOCAL BASIC — Direct file uploads: a "media" Storage bucket
--
-- Every image field in this product (branding_settings.logo_url,
-- restaurant_products.image_url, restaurant_categories.image_url,
-- restaurant_bundles.image_url, a banner section's imageUrl) has been a
-- plain text column an admin pastes a URL into. This is the storage side of
-- replacing that with a real upload: one public bucket, path-scoped RLS, no
-- server code in the middle — the browser uploads straight to Storage under
-- the signed-in member's own session, and RLS is the only gate.
--
-- PATH CONVENTION IS THE SECURITY BOUNDARY.
--
-- Every object's path starts with the organization id: {org_id}/{purpose}/
-- {filename}. storage.foldername(name)[1] is that first segment, and every
-- policy below checks it against app.has_permission() the same way every
-- other tenant-scoped table in this schema does — an org id embedded in a
-- path is exactly as trustworthy as one embedded in a row, checked the same
-- way, by the same function.
--
-- PUBLIC READ, GATED WRITE. The bucket is public: these are images meant to
-- appear on a public menu, storefront or site page, and gating reads would
-- mean every public page needs a signed URL for every image, which is not
-- what any of the existing image fields do today (they are plain URLs).
-- Writing is gated to whoever holds branding.manage, site.manage or
-- restaurant.menu.manage on the org named by the path — the same three
-- permissions that already govern the fields this bucket's files end up in.
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'media', 'media', true,
  8 * 1024 * 1024,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create or replace function app.media_path_org(p_name text)
returns uuid language sql immutable set search_path = '' as $$
  select nullif((storage.foldername(p_name))[1], '')::uuid;
$$;

create policy media_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'media'
    and (
      app.has_permission(app.media_path_org(name), 'branding.manage')
      or app.has_permission(app.media_path_org(name), 'site.manage')
      or app.has_permission(app.media_path_org(name), 'restaurant.menu.manage')
    )
  );

create policy media_update on storage.objects for update to authenticated
  using (
    bucket_id = 'media'
    and (
      app.has_permission(app.media_path_org(name), 'branding.manage')
      or app.has_permission(app.media_path_org(name), 'site.manage')
      or app.has_permission(app.media_path_org(name), 'restaurant.menu.manage')
    )
  )
  with check (
    bucket_id = 'media'
    and (
      app.has_permission(app.media_path_org(name), 'branding.manage')
      or app.has_permission(app.media_path_org(name), 'site.manage')
      or app.has_permission(app.media_path_org(name), 'restaurant.menu.manage')
    )
  );

create policy media_delete on storage.objects for delete to authenticated
  using (
    bucket_id = 'media'
    and (
      app.has_permission(app.media_path_org(name), 'branding.manage')
      or app.has_permission(app.media_path_org(name), 'site.manage')
      or app.has_permission(app.media_path_org(name), 'restaurant.menu.manage')
    )
  );

-- Authenticated members can also list/read their own org's folder directly
-- (the upload widget needs this to show what is already there); the public
-- bucket already serves reads to anyone regardless, this only affects the
-- authenticated Storage API's listing.
create policy media_select_own_org on storage.objects for select to authenticated
  using (
    bucket_id = 'media'
    and app.media_path_org(name) is not null
    and exists (
      select 1 from public.organization_members m
      where m.user_id = auth.uid() and m.organization_id = app.media_path_org(name)
    )
  );
