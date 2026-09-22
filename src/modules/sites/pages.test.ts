import { describe, expect, it } from 'vitest';
import { pageSelectionFromParam, selectPage } from './pages';
import type { SitePage, SiteSection, SiteDetail } from './types';
import type { SectionType } from './schemas';

/**
 * Page selection is where "no page was requested" and "a page was requested
 * and is not there" become different answers. Before Phase 2 both routes wrote
 * `pages.find(isHomepage) ?? pages[0]`, which can only express the first.
 */

function page(id: string, over: Partial<SitePage> = {}): SitePage {
  return {
    id,
    siteId: 'site-1',
    title: id,
    slug: id,
    isHomepage: false,
    sortOrder: 0,
    ...over,
  };
}

function section(id: string, pageId: string, type: SectionType = 'about'): SiteSection {
  return {
    id,
    pageId,
    sectionType: type,
    content: {},
    sortOrder: 0,
    isVisible: true,
  };
}

/** Homepage A and inner page B, each with its own sections. */
const DETAIL: Pick<SiteDetail, 'pages' | 'sections'> = {
  pages: [page('a', { isHomepage: true, slug: 'home' }), page('b', { slug: 'about-us' })],
  sections: [
    section('a1', 'a'),
    section('a2', 'a'),
    section('b1', 'b'),
    section('b2', 'b'),
    section('b3', 'b'),
  ],
};

describe('selectPage', () => {
  it('no explicit page selects the homepage', () => {
    const r = selectPage(DETAIL, { kind: 'homepage' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.page.id).toBe('a');
    expect(r.viaHomepageFallback).toBe(false);
    expect(r.sections.map((s) => s.id)).toEqual(['a1', 'a2']);
  });

  it('an explicit valid page selects that page', () => {
    const r = selectPage(DETAIL, { kind: 'id', pageId: 'b' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.page.id).toBe('b');
    expect(r.viaHomepageFallback).toBe(false);
    // Only B's sections, and none of A's.
    expect(r.sections.map((s) => s.id)).toEqual(['b1', 'b2', 'b3']);
  });

  it('an explicit invalid page is not-found, NOT the homepage', () => {
    const r = selectPage(DETAIL, { kind: 'id', pageId: 'does-not-exist' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('unknown-page');
  });

  it('a page id from another site is simply absent, so it is not-found', () => {
    // The array came from getSiteDetail(ctx, siteId), which already applied the
    // tenant context, site.read and RLS. There is no query here to cross a site
    // boundary with — a foreign id is just not in the list.
    const r = selectPage(DETAIL, { kind: 'id', pageId: 'page-of-another-site' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('unknown-page');
  });

  it('selects by slug, case-insensitively', () => {
    // site_pages.slug is citext under UNIQUE (site_id, slug), so a site cannot
    // hold two slugs differing only in case and this cannot be ambiguous.
    for (const slug of ['about-us', 'About-Us', '  ABOUT-US  ']) {
      const r = selectPage(DETAIL, { kind: 'slug', slug });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.page.id).toBe('b');
    }
  });

  it('an unknown slug is not-found, not the homepage', () => {
    const r = selectPage(DETAIL, { kind: 'slug', slug: 'nope' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('unknown-page');
  });

  it('a site with no pages is not-found with its own reason', () => {
    const r = selectPage({ pages: [], sections: [] }, { kind: 'homepage' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('site-has-no-pages');
  });

  describe('the homepage fallback', () => {
    // 0058's deferred constraint makes this unreachable for any site created or
    // edited since. A site written before it can still hit it, so the fallback
    // is kept — and reported, rather than hidden.
    const flagless: Pick<SiteDetail, 'pages' | 'sections'> = {
      pages: [page('x', { sortOrder: 0 }), page('y', { sortOrder: 1 })],
      sections: [section('x1', 'x'), section('y1', 'y')],
    };

    it('stands in the first page and says so', () => {
      const r = selectPage(flagless, { kind: 'homepage' });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.page.id).toBe('x');
      expect(r.viaHomepageFallback).toBe(true);
      expect(r.sections.map((s) => s.id)).toEqual(['x1']);
    });

    it('applies to the homepage request and to no other', () => {
      // An explicitly named page that does not exist must never reach it.
      const r = selectPage(flagless, { kind: 'id', pageId: 'missing' });
      expect(r.ok).toBe(false);
      const bySlug = selectPage(flagless, { kind: 'slug', slug: 'missing' });
      expect(bySlug.ok).toBe(false);
    });
  });
});

describe('pageSelectionFromParam', () => {
  it('treats every shape of "nothing was given" as the homepage', () => {
    expect(pageSelectionFromParam(undefined)).toEqual({ kind: 'homepage' });
    expect(pageSelectionFromParam('')).toEqual({ kind: 'homepage' });
    expect(pageSelectionFromParam('   ')).toEqual({ kind: 'homepage' });
    // ?page=a&page=b — Next.js gives an array. Not a caller naming one page.
    expect(pageSelectionFromParam(['a', 'b'])).toEqual({ kind: 'homepage' });
  });

  it('treats any value as a request for that page', () => {
    expect(pageSelectionFromParam('b')).toEqual({ kind: 'id', pageId: 'b' });
    expect(pageSelectionFromParam(' b ')).toEqual({ kind: 'id', pageId: 'b' });
  });
});
