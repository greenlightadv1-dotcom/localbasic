import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { clientEnv } from '@/lib/env';
import {
  getWebsite, getBranches, getMenu,
  type Website, type PublicBranch, type MenuCategory,
} from '@/modules/restaurant/website/service';
import { currentUser, getFavorites } from '@/modules/restaurant/account/service';
import { getPublishedLayout } from '@/modules/restaurant/website/builder';
import {
  DEFAULT_SECTIONS, DEFAULT_THEME,
  type SectionConfig, type SectionType, type Theme,
} from '@/modules/restaurant/website/builder-shared';
import {
  brandStyle, backgroundClass, containerClass,
  SiteHeader, Hero, About, BranchPicker, Menu, Location, Hours, Contact, Gallery, Cta, SiteFooter,
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

type SectionSpec = { type: SectionType; config: SectionConfig };

/**
 * Renders one configured section.
 *
 * The section decides its own heading and which optional parts to show. It
 * never decides what a product costs or whether a branch may take an order —
 * those come from the menu and the D1.1 settings, exactly as they did before
 * the builder existed.
 */
function renderSection(
  spec: SectionSpec,
  ctx: {
    site: Website;
    orgSlug: string;
    branch: PublicBranch;
    branches: PublicBranch[];
    menu: MenuCategory[];
    signedIn: boolean;
    favoriteIds: Set<string>;
  },
) {
  const { config } = spec;
  switch (spec.type) {
    case 'hero':
      return <Hero site={ctx.site} orgSlug={ctx.orgSlug} branch={ctx.branch} config={config} />;
    case 'about':
      return <About site={ctx.site} config={config} />;
    case 'menu':
      return (
        <Menu
          categories={ctx.menu}
          site={ctx.site}
          orgSlug={ctx.orgSlug}
          branch={ctx.branch}
          signedIn={ctx.signedIn}
          favoriteIds={ctx.favoriteIds}
          config={config}
        />
      );
    case 'gallery':
      return <Gallery config={config} />;
    case 'contact':
      return <Contact site={ctx.site} config={config} />;
    case 'hours':
      return <Hours hours={ctx.site.openingHours} config={config} />;
    case 'branches':
      return <Location branches={ctx.branches} config={config} />;
    case 'cta':
      return <Cta orgSlug={ctx.orgSlug} branch={ctx.branch} config={config} />;
    default:
      return null;
  }
}

/**
 * The public restaurant site.
 *
 * `layout` is the published revision when the restaurant has published one,
 * and null otherwise — in which case DEFAULT_SECTIONS reproduces the original
 * D2 page exactly. A restaurant that never opens the builder sees no change.
 *
 * Draft content is not reachable from here at all: the read goes to the live
 * revision only, and the draft tables are behind tenant RLS.
 */
export async function RestaurantSite({
  orgSlug,
  branchSlug,
  draft,
}: {
  orgSlug: string;
  branchSlug?: string;
  /**
   * Preview override. Supplied only by the authenticated builder preview route,
   * which has already proved the caller may manage this restaurant's settings.
   * Public routes never pass it.
   */
  draft?: { sections: SectionSpec[]; theme: Theme } | null;
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

  const [menu, user, published] = await Promise.all([
    getMenu(orgSlug, branch.slug),
    currentUser(),
    draft ? Promise.resolve(null) : getPublishedLayout(orgSlug),
  ]);

  // D3: the menu is identical whether or not anyone is signed in. A session
  // adds a save button and an account link; it changes nothing about what the
  // page is allowed to show, which is why the page stays public.
  const signedIn = Boolean(user);
  const favoriteIds = new Set(
    signedIn ? (await getFavorites(orgSlug)).map((f) => f.productId) : [],
  );

  const sections: SectionSpec[] = draft?.sections ?? published?.sections ?? DEFAULT_SECTIONS;
  const theme: Theme = draft?.theme ?? published?.theme ?? DEFAULT_THEME;

  const ctx = { site, orgSlug, branch, branches, menu, signedIn, favoriteIds };

  return (
    <div style={brandStyle(site, theme)} className={`min-h-dvh ${backgroundClass(theme)}`}>
      <SiteHeader site={site} orgSlug={orgSlug} branch={branch} signedIn={signedIn} />
      <main className={`mx-auto ${containerClass(theme)}`}>
        {/* The branch picker is structural rather than a section: a multi-branch
            restaurant must always be able to switch, whatever its layout. */}
        <BranchPicker orgSlug={orgSlug} branches={branches} current={branch} />
        {sections.map((spec, i) => (
          <div key={`${spec.type}-${i}`}>{renderSection(spec, ctx)}</div>
        ))}
      </main>
      <SiteFooter site={site} orgSlug={orgSlug} branch={branch} />
    </div>
  );
}
