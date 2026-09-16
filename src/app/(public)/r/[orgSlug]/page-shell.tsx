import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { clientEnv } from '@/lib/env';
import { getWebsite, getBranches, getMenu } from '@/modules/restaurant/website/service';
import { currentUser, getFavorites } from '@/modules/restaurant/account/service';
import {
  brandStyle, SiteHeader, Hero, About, BranchPicker, Menu, Location, Hours, Contact, SiteFooter,
} from './parts';

/**
 * One implementation for both /r/<org> and /r/<org>/<branch>.
 *
 * Without a branch in the URL the first active branch is shown, so a
 * single-branch restaurant — the common case — needs no choice at all.
 */
export async function buildMetadata(
  orgSlug: string,
  branchSlug?: string,
): Promise<Metadata> {
  const site = await getWebsite(orgSlug);
  // An unpublished restaurant gets no title that would confirm it exists.
  if (!site) return { title: 'الصفحة غير موجودة', robots: { index: false, follow: false } };

  const canonicalPath = branchSlug ? `/r/${orgSlug}/${branchSlug}` : `/r/${orgSlug}`;
  const url = `${clientEnv.NEXT_PUBLIC_APP_URL}${canonicalPath}`;
  const description =
    site.tagline ?? site.about?.slice(0, 160) ?? `منيو وطلبات ${site.organizationName}`;

  return {
    title: site.organizationName,
    description,
    // A published restaurant is meant to be found.
    robots: { index: true, follow: true },
    alternates: { canonical: url },
    openGraph: {
      type: 'website',
      title: site.organizationName,
      description,
      url,
      siteName: site.organizationName,
      locale: 'ar_EG',
      ...(site.heroUrl ? { images: [{ url: site.heroUrl }] } : {}),
    },
  };
}

export async function RestaurantSite({
  orgSlug,
  branchSlug,
}: {
  orgSlug: string;
  branchSlug?: string;
}) {
  const [site, branches] = await Promise.all([getWebsite(orgSlug), getBranches(orgSlug)]);
  if (!site) notFound();

  // A restaurant with no active branch has nothing to show publicly.
  if (branches.length === 0) notFound();

  const branch = branchSlug
    ? branches.find((b) => b.slug === branchSlug.toLowerCase())
    : branches[0];
  // An inactive or foreign branch slug is not found, never a silent fallback
  // to a different branch than the one asked for.
  if (!branch) notFound();

  const [menu, user] = await Promise.all([getMenu(orgSlug, branch.slug), currentUser()]);

  // D3: the menu is identical whether or not anyone is signed in. A session
  // adds a save button and an account link; it changes nothing about what the
  // page is allowed to show, which is why the page stays public.
  const signedIn = Boolean(user);
  const favoriteIds = new Set(
    signedIn ? (await getFavorites(orgSlug)).map((f) => f.productId) : [],
  );

  return (
    <div style={brandStyle(site)} className="min-h-dvh bg-bg">
      <SiteHeader site={site} orgSlug={orgSlug} branch={branch} signedIn={signedIn} />
      <main>
        <Hero site={site} orgSlug={orgSlug} branch={branch} />
        <BranchPicker orgSlug={orgSlug} branches={branches} current={branch} />
        <About site={site} />
        <Menu
          categories={menu}
          site={site}
          orgSlug={orgSlug}
          branch={branch}
          signedIn={signedIn}
          favoriteIds={favoriteIds}
        />
        <Location branches={branches} />
        <Hours hours={site.openingHours} />
        <Contact site={site} />
      </main>
      <SiteFooter site={site} orgSlug={orgSlug} branch={branch} />
    </div>
  );
}
