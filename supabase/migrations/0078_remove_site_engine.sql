-- =============================================================================
-- LOCAL BASIC — Remove the Site Engine (0055-0062)
--
-- The Site Engine let an organization run many named, independently
-- publishable "sites" alongside the restaurant's one real website
-- (restaurant_website_*, 0039/0042). In practice this produced two competing
-- "edit your website" screens and a confusing list of sites with no
-- meaningful use, so the product is consolidating onto the single-site
-- builder only. This migration removes the Site Engine's tables, functions,
-- and its Platform Admin wrapper (0061) and public read surface (0062)
-- entirely.
--
-- What this does NOT touch:
--   - restaurant_website_* (0039/0042/0043/0068/0076): the one real website,
--     untouched.
--   - platform_websites/platform_website_versions (0051): a different,
--     unrelated platform-admin AI site builder, untouched.
--   - the 'site.read'/'site.manage' permission keys and their role grants
--     (0055): kept, because the media storage RLS policies (0069/0072/0075)
--     also accept 'site.manage' as one of several valid grants for writing
--     an organization's media bucket. Dropping the keys would silently
--     narrow that OR-condition for any role that held only this permission.
--     Removing the Site Engine's OWN use of them (the /settings/sites nav
--     item and its RLS policies) is enough; the keys staying seeded and
--     granted to owner/admin is inert once nothing reads them for this
--     feature.
--
-- Tables first, THEN functions: a policy on site_sections/site_pages calls
-- app.site_page_can_manage()/app.site_page_can_read() etc, so dropping those
-- functions before the tables that reference them in a policy fails with
-- "cannot drop function ... because other objects depend on it". CASCADE on
-- the table drop clears the policy (and its function reference) along with
-- the table; only then can the now-unreferenced functions themselves go.
-- =============================================================================

-- Tables first: CASCADE clears their own policies, triggers, indexes and
-- check constraints, including everything that depends on the functions
-- below (RLS policies calling app.site_can_read/site_can_manage/etc).
drop table if exists public.site_revisions cascade;
drop table if exists public.site_settings cascade;
drop table if exists public.site_sections cascade;
drop table if exists public.site_pages cascade;
drop table if exists public.sites cascade;

-- Public read surface (0062)
drop function if exists public.site_public_page(text, text);

-- Platform Admin wrapper (0061)
drop function if exists public.platform_site_unpublish(text, uuid);
drop function if exists public.platform_site_rollback(text, uuid, uuid);
drop function if exists public.platform_site_publish(text, uuid, text);
drop function if exists public.platform_site_theme_update(text, uuid, jsonb);
drop function if exists public.platform_site_revisions_list(text, uuid);
drop function if exists public.platform_site_detail(text, uuid);
drop function if exists public.platform_site_list(text);
drop function if exists app.platform_customer_site(text, uuid);

-- Publishing (0060)
drop function if exists public.site_unpublish(uuid);
drop function if exists public.site_rollback(uuid, uuid);
drop function if exists public.site_publish(uuid, text);
drop function if exists app.site_snapshot(uuid);
drop function if exists app.check_site_revision_immutable();
drop function if exists app.check_site_snapshot();

-- Page operations (0058)
drop function if exists public.site_page_delete(uuid);
drop function if exists public.site_pages_reorder(uuid, uuid[]);
drop function if exists public.site_page_create(uuid, text, text);
drop function if exists app.assert_site_homepage();
drop function if exists app.check_site_page_identity();

-- Write layer (0057/0059)
drop function if exists public.site_sections_reorder(uuid, uuid[]);
drop function if exists app.check_site_settings();
drop function if exists app.check_site_section_content();

-- Core (0055/0056)
drop function if exists public.site_provision(uuid, text, text, uuid);
drop function if exists app.check_site_identity();
drop function if exists app.site_page_can_manage(uuid);
drop function if exists app.site_page_can_read(uuid);
drop function if exists app.site_can_manage(uuid);
drop function if exists app.site_can_read(uuid);
