import { redirect } from 'next/navigation';

/**
 * This screen merged into the unified Site Customizer (settings/branding) —
 * see BrandingPage, which now renders brand identity, site content and
 * publish status on one page. Kept as a redirect, not a 404, for anyone
 * with the old URL bookmarked; /settings/website/domains and
 * /settings/website/builder are unaffected, they were never duplicated.
 */
export default function WebsiteSettingsRedirect({
  params,
}: {
  params: { orgSlug: string; branchSlug: string };
}) {
  redirect(`/${params.orgSlug}/${params.branchSlug}/settings/branding`);
}
