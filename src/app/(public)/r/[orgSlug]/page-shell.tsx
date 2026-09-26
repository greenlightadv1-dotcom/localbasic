import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { clientEnv } from '@/lib/env';
import {
  getWebsite, getBranches,
  type Website, type PublicBranch,
} from '@/modules/restaurant/website/service';
import {
  currentUser, getFavorites, getProfile, getAddresses,
} from '@/modules/restaurant/account/service';
import { getOnlineMenu, type MenuItem, type ModifierGroup } from '@/modules/restaurant/online/service';
import { getPublishedLayout } from '@/modules/restaurant/website/builder';
import {
  DEFAULT_SECTIONS, DEFAULT_THEME,
  type SectionConfig, type SectionType, type Theme,
} from '@/modules/restaurant/website/builder-shared';
import {
  brandStyle, backgroundClass, containerClass,
  SiteHeader, Hero, About, BranchPicker, Location, Hours, Contact, Gallery, Cta, SiteFooter,
} from './parts';
import { Storefront } from '../../order/[orgSlug]/[branchSlug]/storefront';

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
    signedIn: boolean;
    favoriteIds: Set<string>;
    menuItems: MenuItem[];
    modifierGroups: ModifierGroup[];
    savedAddresses: { id: string; label: string; address: string; isDefault: boolean }[];
    customerName: string;
    customerPhone: string;
  },
) {
  const { config } = spec;
  switch (spec.type) {
    case 'hero':
      return (
        <Hero
          site={ctx.site} orgSlug={ctx.orgSlug} branch={ctx.branch}
          signedIn={ctx.signedIn} config={config}
        />
      );
    case 'about':
      return <About site={ctx.site} config={config} />;
    case 'menu':
      // The one interactive section: the site builder's static, read-only
      // menu display is replaced by the same category-browse + item-grid +
      // floating-cart storefront /order/<org>/<branch> and a table's QR code
      // (/p/[token]) both already use — one ordering experience, reached
      // from every entry point, exactly as the custom-domain route's own
      // comment already promised for the rest of this page ("no second
      // ordering path"). config.title/subtitle from the builder still frame
      // it; config.showPrices does not apply here, since a live storefront
      // always shows what it will actually charge.
      return (
        <Storefront
          orgSlug={ctx.orgSlug}
          branchSlug={ctx.branch.slug}
          items={ctx.menuItems}
          modifierGroups={ctx.modifierGroups}
          currency={ctx.site.currency}
          pickupEnabled={ctx.branch.pickupEnabled}
          deliveryEnabled={ctx.branch.deliveryEnabled}
          savedAddresses={ctx.savedAddresses}
          customerName={ctx.customerName}
          customerPhone={ctx.customerPhone}
          signedIn={ctx.signedIn}
          favoriteProductIds={[...ctx.favoriteIds]}
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

  const [onlineMenu, user, published] = await Promise.all([
    getOnlineMenu({ orgSlug, branchSlug: branch.slug }).catch(() => ({ items: [], modifierGroups: [] })),
    currentUser(),
    draft ? Promise.resolve(null) : getPublishedLayout(orgSlug),
  ]);

  // D3/D4: the menu is identical whether or not anyone is signed in. A
  // session adds saved addresses, favorites, prefilled contact details and an
  // account link; it changes nothing about what the page is allowed to show,
  // which is why the page stays public.
  const signedIn = Boolean(user);
  const [favorites, profile, addresses] = signedIn
    ? await Promise.all([getFavorites(orgSlug), getProfile(orgSlug), getAddresses(orgSlug)])
    : [[], null, []];
  const favoriteIds = new Set(favorites.map((f) => f.productId));

  let sections: SectionSpec[] = draft?.sections ?? published?.sections ?? DEFAULT_SECTIONS;
  const theme: Theme = draft?.theme ?? published?.theme ?? DEFAULT_THEME;

  // Ordering is a platform guarantee, not a section a builder configuration
  // can accidentally remove: every restaurant reaches it from this page,
  // /order/<org>/<branch> and a table's QR code alike, so a layout that never
  // added (or that deleted) a 'menu' section still gets one, appended last.
  if (!sections.some((s) => s.type === 'menu')) {
    sections = [...sections, { type: 'menu', config: {} }];
  }

  const ctx = {
    site, orgSlug, branch, branches, signedIn, favoriteIds,
    menuItems: onlineMenu.items,
    modifierGroups: onlineMenu.modifierGroups,
    savedAddresses: addresses.map((a) => ({
      id: a.id, label: a.label, address: a.address, isDefault: a.isDefault,
    })),
    customerName: profile?.fullName ?? '',
    customerPhone: profile?.phone ?? '',
  };

  return (
    <div style={brandStyle(site, theme)} className={`min-h-dvh ${backgroundClass(theme)}`}>
      <SiteHeader site={site} orgSlug={orgSlug} branch={branch} signedIn={signedIn} theme={theme} />
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
