import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SiteDetail } from '@/modules/sites/types';

/**
 * The preview route, as the layer that SELECTS a page.
 *
 * The renderer's own tests prove it draws the page it is handed. These prove
 * the route hands it the right one — and that a page named in the URL and not
 * present produces a not-found state rather than the homepage.
 *
 * Markers rather than titles throughout: a title assertion would pass even if
 * the route quietly rendered the homepage's sections under another page's name.
 */

const h = vi.hoisted(() => {
  const state = { detail: null as SiteDetail | null };
  const writes: string[] = [];
  return { state, writes };
});

vi.mock('@/modules/core/tenancy/context', () => ({
  resolveTenantContext: async () => ({
    organizationId: 'org-a',
    organizationSlug: 'alpha',
    branchSlug: 'main',
  }),
}));

vi.mock('@/modules/sites/service', () => ({
  getSiteDetail: async () => h.state.detail,
  // Every write the module exports, recorded. A preview that calls one fails.
  createSite: async () => h.writes.push('createSite'),
  updateSite: async () => h.writes.push('updateSite'),
  updateSection: async () => h.writes.push('updateSection'),
  reorderSections: async () => h.writes.push('reorderSections'),
  deleteSection: async () => h.writes.push('deleteSection'),
  createPage: async () => h.writes.push('createPage'),
  renamePage: async () => h.writes.push('renamePage'),
  reorderPages: async () => h.writes.push('reorderPages'),
  deletePage: async () => h.writes.push('deletePage'),
}));

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));

import SitePreviewPage from './page';

const PARAMS = { orgSlug: 'alpha', branchSlug: 'main', siteId: 'site-1' };

const DETAIL: SiteDetail = {
  site: {
    id: 'site-1',
    organizationId: 'org-a',
    createdBy: null,
    name: 'Alpha Site',
    slug: 'alpha-site',
    templateId: 'business',
    status: 'draft',
    createdAt: '',
    updatedAt: '',
  },
  pages: [
    { id: 'page-a', siteId: 'site-1', title: 'الرئيسية', slug: 'home', isHomepage: true, sortOrder: 0 },
    { id: 'page-b', siteId: 'site-1', title: 'من نحن', slug: 'about-us', isHomepage: false, sortOrder: 1 },
  ],
  sections: [
    { id: 'a1', pageId: 'page-a', sectionType: 'hero', content: { title: 'HOMEPAGE_MARKER' }, sortOrder: 0, isVisible: true },
    { id: 'b1', pageId: 'page-b', sectionType: 'about', content: { title: 'INNER_MARKER' }, sortOrder: 0, isVisible: true },
  ],
  settings: { siteId: 'site-1', settings: {} },
};

async function render(page?: string | string[]) {
  const node = await SitePreviewPage({
    params: PARAMS,
    searchParams: page === undefined ? {} : { page },
  });
  return renderToStaticMarkup(node);
}

beforeEach(() => {
  h.state.detail = DETAIL;
  h.writes.length = 0;
});

describe('site preview page selection', () => {
  it('renders the homepage when no page is named', () => {
    return render().then((out) => {
      expect(out).toContain('HOMEPAGE_MARKER');
      expect(out).not.toContain('INNER_MARKER');
    });
  });

  it('renders the named page, and none of the homepage', async () => {
    const out = await render('page-b');
    expect(out).toContain('INNER_MARKER');
    expect(out).not.toContain('HOMEPAGE_MARKER');
    // The selected page's own title, not the site's name and not the homepage's.
    expect(out).toContain('من نحن');
  });

  it('shows a not-found state for a page this site does not have', async () => {
    const out = await render('page-that-does-not-exist');
    expect(out).toContain('الصفحة المطلوبة غير موجودة');
    // Explicitly NOT the homepage: a stale link must not look like it worked.
    expect(out).not.toContain('HOMEPAGE_MARKER');
    expect(out).not.toContain('INNER_MARKER');
  });

  it('treats a page id from another site as not-found', async () => {
    // getSiteDetail already scoped to this organization's site, so a foreign
    // id is simply not among its pages. Nothing here fetches it to check.
    const out = await render('page-of-another-organizations-site');
    expect(out).toContain('الصفحة المطلوبة غير موجودة');
  });

  it('treats a blank or repeated parameter as "no page named"', async () => {
    for (const value of ['', '   ', ['page-a', 'page-b']] as (string | string[])[]) {
      const out = await render(value);
      expect(out).toContain('HOMEPAGE_MARKER');
    }
  });

  it('offers a switcher listing every page, with the current one marked', async () => {
    const out = await render('page-b');
    expect(out).toContain('صفحات الموقع');
    expect(out).toContain('page=page-b');
    expect(out).toContain('aria-current="page"');
  });

  it('shows no switcher for a single-page site', async () => {
    h.state.detail = {
      ...DETAIL,
      pages: [DETAIL.pages[0]!],
      sections: [DETAIL.sections[0]!],
    };
    const out = await render();
    expect(out).not.toContain('صفحات الموقع');
    expect(out).toContain('HOMEPAGE_MARKER');
  });

  it('reports a site with no pages rather than rendering an empty frame', async () => {
    h.state.detail = { ...DETAIL, pages: [], sections: [] };
    const out = await render();
    expect(out).toContain('لا توجد صفحات في هذا الموقع');
  });

  it('is read-only: no page selection calls a write service', async () => {
    await render();
    await render('page-b');
    await render('missing');
    expect(h.writes).toEqual([]);
  });

  it('404s when the site is out of reach, before any page selection', async () => {
    h.state.detail = null;
    await expect(render('page-b')).rejects.toThrow('NEXT_NOT_FOUND');
  });
});
