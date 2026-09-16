import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { resolveHost } from '@/modules/restaurant/website/domains';
import { getBranches, getWebsite } from '@/modules/restaurant/website/service';
import { RestaurantSite } from '../../../r/[orgSlug]/page-shell';

/**
 * A restaurant's website, reached on the restaurant's own hostname.
 *
 * Middleware rewrites custom-domain traffic here, putting the request host in
 * the path. THE HOSTNAME IS THE AUTHORITY: it is the only thing that decides
 * which organization is rendered, and there is no query parameter, header or
 * body field that can point a hostname at a different restaurant.
 *
 * Only ACTIVE domains resolve, so a row existing is never enough to route
 * traffic, and the same published-website check that governs the LocalBasic
 * address governs this one.
 *
 * Rendering is delegated to the component the LocalBasic address uses. There
 * is no second renderer, no second menu and no second ordering path — the only
 * thing that differs between the two entry points is how the organization was
 * identified.
 */
export const dynamic = 'force-dynamic';

type Params = { params: { host: string; segments?: string[] } };

/** Only the root and one branch segment are website paths on a custom domain. */
function branchFrom(segments?: string[]): string | null | false {
  if (!segments || segments.length === 0) return null;
  if (segments.length > 1) return false;
  return segments[0]!.toLowerCase();
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const resolved = await resolveHost(decodeURIComponent(params.host));
  if (!resolved) {
    return { title: 'الصفحة غير موجودة', robots: { index: false, follow: false } };
  }

  const site = await getWebsite(resolved.orgSlug);
  if (!site) {
    return { title: 'الصفحة غير موجودة', robots: { index: false, follow: false } };
  }

  const branch = branchFrom(params.segments);
  if (branch === false) {
    return { title: 'الصفحة غير موجودة', robots: { index: false, follow: false } };
  }

  // A branch segment that names no branch of this restaurant is not found, and
  // its metadata must say so: the title and canonical are resolved separately
  // from the page body, so without this an unknown path would advertise itself
  // as an indexable page of a real restaurant.
  if (branch) {
    const branches = await getBranches(resolved.orgSlug);
    if (!branches.some((b) => b.slug === branch)) {
      return { title: 'الصفحة غير موجودة', robots: { index: false, follow: false } };
    }
  }

  // Canonical on the custom domain, not on the LocalBasic address: this
  // hostname is where the restaurant wants to be found, and pointing search
  // engines back at /r/<slug> would undo the reason they bought a domain.
  //
  // When this hostname is an alias — www alongside the bare domain — the
  // canonical names the primary instead, which is how the pair settle on one
  // address. `rel=canonical` rather than a 308: the redirect would have to be
  // issued before rendering, and middleware cannot resolve a hostname without
  // a database round trip on every request. A canonical link is the mechanism
  // search engines are built for, and it cannot loop.
  const host = decodeURIComponent(params.host);
  const canonicalHost = resolved.redirectTo ?? host;
  const path = branch ? `/${branch}` : '';
  const description =
    site.tagline ?? site.about?.slice(0, 160) ?? `منيو وطلبات ${site.organizationName}`;

  return {
    title: site.organizationName,
    description,
    robots: { index: true, follow: true },
    alternates: { canonical: `https://${canonicalHost}${path}` },
    openGraph: {
      type: 'website',
      title: site.organizationName,
      description,
      url: `https://${canonicalHost}${path}`,
      siteName: site.organizationName,
      locale: 'ar_EG',
      ...(site.heroUrl ? { images: [{ url: site.heroUrl }] } : {}),
    },
  };
}

export default async function CustomDomainSitePage({ params }: Params) {
  const host = decodeURIComponent(params.host);
  const resolved = await resolveHost(host);
  // No active domain for this hostname — including one that is merely pending,
  // verified or disabled. Not found, with nothing to say which it was.
  if (!resolved) notFound();

  const branch = branchFrom(params.segments);
  if (branch === false) notFound();

  // A branch segment must name a real branch of THIS restaurant. Anything else
  // is not found rather than a silent fall back to the default branch.
  if (branch) {
    const branches = await getBranches(resolved.orgSlug);
    if (!branches.some((b) => b.slug === branch)) notFound();
  }

  return (
    <RestaurantSite
      orgSlug={resolved.orgSlug}
      {...(branch ? { branchSlug: branch } : {})}
    />
  );
}
