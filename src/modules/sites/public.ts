import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import {
  getBestSellers,
  getBranches,
  getBundles,
  getMenu,
  getWebsite,
} from '@/modules/restaurant/website/service';
import type { SitePage, SiteSection } from './types';
import type { SectionType } from './schemas';
import type { ResolvedSectionMap } from './resolved';

/**
 * The public Site Engine read path.
 *
 * Everything here is reachable with no session at all — this is what an
 * anonymous visitor's request runs. Structure (which sections exist, in what
 * order, with what literal content) comes from site_public_page(), a
 * SECURITY DEFINER function that only ever returns a PUBLISHED site's
 * content (see supabase/migrations/0062_site_engine_public.sql).
 *
 * Live data for a data-bound section is resolved through the SAME public
 * functions the LocalBasic address (/r/<org>) already uses —
 * getWebsite/getBranches/getMenu — rather than a second implementation of
 * that resolution living in SQL, untested, next to the one in ./resolve.ts.
 */

export type PublicSiteStructure = {
  siteName: string;
  organizationName: string;
  currency: string;
  settings: Record<string, unknown>;
  pages: Pick<SitePage, 'id' | 'title' | 'slug' | 'isHomepage'>[];
  page: SitePage;
  sections: SiteSection[];
};

type PublicPageRow = {
  organization: { name: string; slug: string; currency: string };
  site: { id: string; name: string; slug: string };
  settings: Record<string, unknown>;
  pages: { id: string; title: string; slug: string; isHomepage: boolean }[];
  page: { id: string; title: string; slug: string; isHomepage: boolean };
  sections: {
    id: string;
    sectionType: string;
    content: Record<string, unknown>;
    sortOrder: number;
  }[];
};

/** Structure only. Null for anything not found — including a draft site. */
export async function getPublicSitePage(
  orgSlug: string,
  pageSlug?: string | null,
): Promise<PublicSiteStructure | null> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('site_public_page', {
    p_org_slug: orgSlug,
    p_page_slug: pageSlug ?? null,
  });
  if (error || !data) return null;

  const row = data as PublicPageRow;

  const page: SitePage = {
    id: row.page.id,
    siteId: row.site.id,
    title: row.page.title,
    slug: row.page.slug,
    isHomepage: row.page.isHomepage,
    sortOrder: 0,
  };

  const sections: SiteSection[] = row.sections.map((s) => ({
    id: s.id,
    pageId: page.id,
    sectionType: s.sectionType as SectionType,
    content: s.content,
    sortOrder: s.sortOrder,
    isVisible: true,
  }));

  return {
    siteName: row.site.name,
    organizationName: row.organization.name,
    currency: row.organization.currency,
    settings: row.settings,
    pages: row.pages,
    page,
    sections,
  };
}

const DATA_BOUND: SectionType[] = [
  'menu', 'business_info', 'hours', 'branches', 'best_sellers', 'bundles',
];

/**
 * SIMPLIFICATION, stated rather than hidden: a Site Engine menu section is
 * organization-wide (see resolve.ts's own docstring on why), but the public
 * menu RPC this reuses is branch-scoped. This resolves it against the
 * organization's first active branch. For a single-branch organization —
 * the only kind live today — that is the whole menu. A multi-branch
 * organization publishing a Site Engine site would need a true org-wide
 * public menu RPC; that is a real follow-up, not something to guess at here.
 */
export async function resolvePublicSectionData(
  orgSlug: string,
  sections: SiteSection[],
): Promise<ResolvedSectionMap> {
  const dataBound = sections.filter((s) => DATA_BOUND.includes(s.sectionType));
  if (dataBound.length === 0) return {};

  const [website, branches] = await Promise.all([getWebsite(orgSlug), getBranches(orgSlug)]);
  const map: ResolvedSectionMap = {};

  for (const s of dataBound) {
    switch (s.sectionType) {
      case 'business_info':
        map[s.id] = {
          type: 'business_info',
          name: website?.organizationName ?? orgSlug,
          phone: website?.phone ?? null,
          whatsapp: website?.whatsapp ?? null,
          email: website?.email ?? null,
          logoUrl: website?.logoUrl ?? null,
        };
        break;
      case 'hours':
        map[s.id] = {
          type: 'hours',
          days: (website?.openingHours ?? []).map((d, i) => ({
            index: i,
            closed: d.closed,
            opens: d.closed ? null : (d.opens ?? null),
            closes: d.closed ? null : (d.closes ?? null),
          })),
        };
        break;
      case 'branches':
        map[s.id] = {
          type: 'branches',
          branches: branches.map((b) => ({
            id: b.slug,
            name: b.name,
            slug: b.slug,
            address: b.address,
            phone: b.phone,
          })),
        };
        break;
      case 'menu': {
        const primaryBranch = branches[0];
        const categories = primaryBranch ? await getMenu(orgSlug, primaryBranch.slug) : [];
        map[s.id] = {
          type: 'menu',
          currency: website?.currency ?? 'EGP',
          categories: categories.map((c) => ({
            id: c.id,
            name: c.name,
            products: c.products.map((p) => ({
              id: p.productId,
              name: p.name,
              description: p.description,
              imageUrl: p.imageUrl,
              fromPriceCents: p.fromPriceCents,
              variants: p.variants,
            })),
          })),
        };
        break;
      }
      case 'best_sellers': {
        const categories = await getBestSellers(orgSlug);
        const products = categories[0]?.products ?? [];
        map[s.id] = {
          type: 'best_sellers',
          currency: website?.currency ?? 'EGP',
          products: products.map((p) => ({
            id: p.productId,
            name: p.name,
            description: p.description,
            imageUrl: p.imageUrl,
            fromPriceCents: p.fromPriceCents,
            variants: p.variants,
          })),
        };
        break;
      }
      case 'bundles': {
        const bundles = await getBundles(orgSlug);
        map[s.id] = {
          type: 'bundles',
          currency: website?.currency ?? 'EGP',
          bundles: bundles.map((b) => ({
            id: b.id,
            name: b.name,
            description: b.description,
            imageUrl: b.imageUrl,
            priceCents: b.priceCents,
          })),
        };
        break;
      }
    }
  }

  return map;
}
