import type { SitePage, SiteSection, SiteDetail } from './types';

/**
 * Choosing which page of a site to render.
 *
 * Page selection is deliberately NOT the renderer's job and NOT the database's.
 * The renderer draws the page it is handed; the service loads the whole site
 * for a caller who is allowed to see it; this decides which of those pages the
 * caller asked for. Keeping it here means the rule is stated once instead of
 * being re-derived in every route that renders a site.
 *
 * THE DISTINCTION THIS FILE EXISTS TO MAKE
 *
 * "No page was requested" and "a page was requested and it is not there" are
 * different questions with different answers. Before this, both routes wrote:
 *
 *     pages.find((p) => p.isHomepage) ?? pages[0] ?? null
 *
 * which could only ever mean the first. Once a caller can name a page, that
 * shape becomes actively wrong: a stale link or a mistyped id would quietly
 * render the homepage and look like it worked. So the request is a value with
 * a `kind`, not an optional string, and the result is a discriminated union
 * rather than `SitePage | null`.
 */

/** What the caller asked for. `homepage` is a request, not the absence of one. */
export type PageSelection =
  | { kind: 'homepage' }
  | { kind: 'id'; pageId: string }
  | { kind: 'slug'; slug: string };

export type PageNotFoundReason =
  /** The site has no pages at all. Unreachable through the product: 0058's
   *  deferred constraint keeps a site with pages at exactly one homepage, and
   *  site_page_delete() refuses to remove the last page. Represented anyway,
   *  because "cannot happen" is a claim about today's schema. */
  | 'site-has-no-pages'
  /** A page was named and this site does not have it. */
  | 'unknown-page';

/**
 * A page and the sections that belong to it. Nothing else.
 *
 * The sections are already narrowed to this page, in page-local order, so a
 * consumer cannot accidentally be holding another page's content.
 */
export type RenderablePage = {
  page: SitePage;
  sections: SiteSection[];
  /**
   * True only when `homepage` was requested and no page carried the flag, so
   * the first page stood in.
   *
   * This is the one fallback in the file, it applies to the `homepage` request
   * and to no other, and it is surfaced rather than hidden. 0058 makes it
   * unreachable for any site created or edited since; a site written before
   * it, or by hand, can still hit it, and a caller that wants to notice can.
   */
  viaHomepageFallback: boolean;
};

export type PageSelectionResult =
  | ({ ok: true } & RenderablePage)
  | { ok: false; reason: PageNotFoundReason };

/**
 * Sections of one page, in the order that page puts them in.
 *
 * getSiteDetail() already sorts by (sort_order, id) across the whole site, and
 * a filter preserves order, so the page-local order falls out of it. Sorting
 * again here would be a second opinion about ordering, and two opinions is how
 * they diverge.
 */
function sectionsOf(pageId: string, sections: SiteSection[]): SiteSection[] {
  return sections.filter((s) => s.pageId === pageId);
}

/**
 * Resolves a selection against a site the caller is already authorized to see.
 *
 * `detail` comes from getSiteDetail(ctx, siteId), which applied the tenant
 * context, `site.read` and RLS before returning anything. Every lookup below
 * is a search within THAT result — there is no query here, and no id from a
 * URL is ever used to fetch a page and then checked for which site it belongs
 * to. A page id naming another organization's page simply is not in the array,
 * so it comes back `unknown-page`, which is the same answer a typo gets.
 */
export function selectPage(
  detail: Pick<SiteDetail, 'pages' | 'sections'>,
  selection: PageSelection,
): PageSelectionResult {
  const { pages, sections } = detail;

  if (pages.length === 0) return { ok: false, reason: 'site-has-no-pages' };

  switch (selection.kind) {
    case 'homepage': {
      const homepage = pages.find((p) => p.isHomepage);
      if (homepage) {
        return {
          ok: true,
          page: homepage,
          sections: sectionsOf(homepage.id, sections),
          viaHomepageFallback: false,
        };
      }
      // No page carries the flag. pages[0] is the site's first page in
      // (sort_order, id), so the stand-in is at least deterministic — and the
      // caller is told it happened.
      const first = pages[0]!;
      return {
        ok: true,
        page: first,
        sections: sectionsOf(first.id, sections),
        viaHomepageFallback: true,
      };
    }

    case 'id': {
      const page = pages.find((p) => p.id === selection.pageId);
      // Not the homepage. A page that was asked for and is not here is a
      // not-found, and rendering something else instead would make a dead link
      // look like a working one.
      if (!page) return { ok: false, reason: 'unknown-page' };
      return {
        ok: true,
        page,
        sections: sectionsOf(page.id, sections),
        viaHomepageFallback: false,
      };
    }

    case 'slug': {
      // site_pages.slug is citext and carries UNIQUE (site_id, slug), so a
      // site cannot hold two pages whose slugs differ only in case and this
      // comparison cannot be ambiguous. Lower-casing here rather than relying
      // on the stored casing keeps it the same comparison the database makes.
      const wanted = selection.slug.trim().toLowerCase();
      const page = pages.find((p) => p.slug.toLowerCase() === wanted);
      if (!page) return { ok: false, reason: 'unknown-page' };
      return {
        ok: true,
        page,
        sections: sectionsOf(page.id, sections),
        viaHomepageFallback: false,
      };
    }
  }
}

/**
 * Turns a URL parameter into a selection.
 *
 * An absent, blank or repeated parameter means the homepage — those are the
 * shapes Next.js produces for "no value was given", and none of them is a
 * caller naming a page. Anything else is a request for that page, and will be
 * answered with a not-found if the site does not have it.
 */
export function pageSelectionFromParam(value: string | string[] | undefined): PageSelection {
  if (typeof value !== 'string') return { kind: 'homepage' };
  const trimmed = value.trim();
  if (trimmed === '') return { kind: 'homepage' };
  return { kind: 'id', pageId: trimmed };
}
