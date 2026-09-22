import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@/lib/errors';

/**
 * The Site Engine write layer, at the service boundary.
 *
 * The database tests (28, 29, 30) prove the policies, triggers and the reorder
 * function. This proves what the service is responsible for and the database
 * cannot be: that the permission is checked before any query runs, that
 * ownership is re-established through the whole parent chain rather than
 * assumed from the id a caller sent, that only the named columns reach the
 * update payload, and that a section's content is judged against the type the
 * ROW says it is rather than the type a caller claims.
 *
 * The fake client records every query so a test can assert on the filters the
 * service applied, not merely on what it returned.
 */

type Row = Record<string, unknown> | null;

const h = vi.hoisted(() => {
  const state = {
    permissions: new Set<string>(['site.read', 'site.manage']),
    organizationId: 'org-a',
    /** Row returned per table, keyed by table name. */
    rows: {} as Record<string, Row>,
    rpcError: null as { code?: string; message: string } | null,
    rpcData: null as unknown,
  };
  const calls: {
    table: string;
    op: string;
    filters: Record<string, unknown>;
    payload?: Record<string, unknown>;
  }[] = [];
  const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];
  return { state, calls, rpcCalls };
});

vi.mock('@/modules/core/tenancy/context', () => ({
  can: (_ctx: unknown, perm: string) => h.state.permissions.has(perm),
  requirePermission: (_ctx: unknown, perm: string) => {
    if (!h.state.permissions.has(perm)) throw new AppError('forbidden');
  },
}));

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      h.rpcCalls.push({ fn, args });
      return { data: h.state.rpcData, error: h.state.rpcError };
    },
    from: (table: string) => {
      const call = { table, op: 'select', filters: {} as Record<string, unknown> };
      h.calls.push(call);
      const b: Record<string, unknown> = {
        select: () => b,
        order: () => b,
        in: () => b,
        eq: (col: string, val: unknown) => {
          call.filters[col] = val;
          return b;
        },
        update: (payload: Record<string, unknown>) => {
          call.op = 'update';
          (call as { payload?: unknown }).payload = payload;
          return b;
        },
        delete: () => {
          call.op = 'delete';
          return b;
        },
        maybeSingle: async () => ({ data: h.state.rows[table] ?? null, error: null }),
      };
      return b;
    },
  }),
}));

import {
  updateSite,
  updateSection,
  reorderSections,
  deleteSection,
  createPage,
  renamePage,
  reorderPages,
  deletePage,
} from './service';
import { createPageSchema, renamePageSchema, reorderPagesSchema } from './schemas';

const CTX = { organizationId: 'org-a', organizationSlug: 'alpha', branchSlug: 'main' } as never;

/** A section that legitimately belongs to org A, resolvable end to end. */
function reachableSection(type = 'hero') {
  h.state.rows = {
    site_sections: { id: 'sec-1', page_id: 'page-1', section_type: type },
    site_pages: { id: 'page-1', site_id: 'site-1' },
    sites: { id: 'site-1' },
  };
}

beforeEach(() => {
  h.calls.length = 0;
  h.rpcCalls.length = 0;
  h.state.permissions = new Set(['site.read', 'site.manage']);
  h.state.organizationId = 'org-a';
  h.state.rows = {};
  h.state.rpcError = null;
  h.state.rpcData = null;
});

describe('authorization', () => {
  it.each([
    ['updateSite', () => updateSite(CTX, 'site-1', { name: 'New' })],
    ['updateSection', () => updateSection(CTX, 'sec-1', { isVisible: false })],
    ['reorderSections', () => reorderSections(CTX, 'page-1', { sectionIds: [] })],
    ['deleteSection', () => deleteSection(CTX, 'sec-1')],
  ])('%s refuses a caller without site.manage', async (_name, run) => {
    h.state.permissions = new Set(['site.read']);
    await expect(run()).rejects.toBeInstanceOf(AppError);
    // Refused before any query ran: the permission is not a filter applied to
    // results, it is a gate in front of them.
    expect(h.calls).toHaveLength(0);
    expect(h.rpcCalls).toHaveLength(0);
  });

  it('updateSite scopes every write to the context organization', async () => {
    h.state.rows = { sites: { id: 'site-1' } };
    await updateSite(CTX, 'site-1', { name: 'New' });

    const call = h.calls.find((c) => c.table === 'sites')!;
    expect(call.op).toBe('update');
    // The organization comes from the context. There is no input field that
    // could carry another one, which is what makes a forged id inert.
    expect(call.filters).toEqual({ id: 'site-1', organization_id: 'org-a' });
  });

  it('updateSite reports a site in another organization as missing', async () => {
    // RLS and the organization filter both refuse it; zero rows come back.
    h.state.rows = { sites: null };
    await expect(updateSite(CTX, 'other-org-site', { name: 'New' })).rejects.toBeInstanceOf(
      AppError,
    );
  });

  it('updateSection refuses a section whose site is in another organization', async () => {
    h.state.rows = {
      site_sections: { id: 'sec-1', page_id: 'page-1', section_type: 'hero' },
      site_pages: { id: 'page-1', site_id: 'site-1' },
      // The site does not resolve under this organization.
      sites: null,
    };
    await expect(updateSection(CTX, 'sec-1', { isVisible: false })).rejects.toBeInstanceOf(
      AppError,
    );
    // It never reached the update.
    expect(h.calls.filter((c) => c.op === 'update')).toHaveLength(0);
  });

  it('updateSection refuses a section whose page does not resolve', async () => {
    h.state.rows = {
      site_sections: { id: 'sec-1', page_id: 'page-x', section_type: 'hero' },
      site_pages: null,
      sites: { id: 'site-1' },
    };
    await expect(updateSection(CTX, 'sec-1', { isVisible: false })).rejects.toBeInstanceOf(
      AppError,
    );
  });

  it('updateSection walks the whole parent chain before writing', async () => {
    reachableSection();
    await updateSection(CTX, 'sec-1', { isVisible: false });

    const tables = h.calls.map((c) => c.table);
    expect(tables).toEqual(['site_sections', 'site_pages', 'sites', 'site_sections']);
    // The site lookup is the one that carries the organization.
    expect(h.calls[2]!.filters).toEqual({ id: 'site-1', organization_id: 'org-a' });
  });

  it('reorderSections refuses a page in another organization before calling the RPC', async () => {
    h.state.rows = { site_pages: { id: 'page-1', site_id: 'site-1' }, sites: null };
    await expect(
      reorderSections(CTX, 'page-1', { sectionIds: ['a'] }),
    ).rejects.toBeInstanceOf(AppError);
    expect(h.rpcCalls).toHaveLength(0);
  });
});

describe('data integrity', () => {
  it('updateSite sends only the field that changed', async () => {
    h.state.rows = { sites: { id: 'site-1' } };
    await updateSite(CTX, 'site-1', { name: 'New' });

    const call = h.calls.find((c) => c.op === 'update')!;
    expect(call.payload).toEqual({ name: 'New' });
    // status untouched, so an unrelated field cannot be reset by a rename.
    expect(call.payload).not.toHaveProperty('status');
  });

  it('updateSite never sends an identity column, even if one is passed', async () => {
    h.state.rows = { sites: { id: 'site-1' } };
    await updateSite(CTX, 'site-1', {
      name: 'New',
      // Not part of UpdateSiteInput. The service builds the payload field by
      // field, so an extra property has nowhere to land.
      organization_id: 'org-b',
      created_by: 'someone-else',
      id: 'another-site',
    } as never);

    const call = h.calls.find((c) => c.op === 'update')!;
    expect(call.payload).toEqual({ name: 'New' });
  });

  it('updateSection writes only the intended section, on its own page', async () => {
    reachableSection();
    await updateSection(CTX, 'sec-1', { isVisible: false });

    const write = h.calls.filter((c) => c.table === 'site_sections').at(-1)!;
    expect(write.op).toBe('update');
    // page_id is repeated in the predicate so the statement itself cannot
    // reach a row on another page.
    expect(write.filters).toEqual({ id: 'sec-1', page_id: 'page-1' });
    expect(write.payload).toEqual({ is_visible: false });
  });

  it('deleteSection deletes only the intended section, on its own page', async () => {
    reachableSection();
    await deleteSection(CTX, 'sec-1');

    const del = h.calls.filter((c) => c.table === 'site_sections').at(-1)!;
    expect(del.op).toBe('delete');
    expect(del.filters).toEqual({ id: 'sec-1', page_id: 'page-1' });
  });

  it('reorderSections passes the page and the ids to the RPC unchanged', async () => {
    h.state.rows = { site_pages: { id: 'page-1', site_id: 'site-1' }, sites: { id: 'site-1' } };
    await reorderSections(CTX, 'page-1', { sectionIds: ['s1', 's2', 's3'] });

    expect(h.rpcCalls).toEqual([
      { fn: 'site_sections_reorder', args: { p_page: 'page-1', p_ids: ['s1', 's2', 's3'] } },
    ]);
  });

  it('reorderSections turns the function refusal into a validation error', async () => {
    h.state.rows = { site_pages: { id: 'page-1', site_id: 'site-1' }, sites: { id: 'site-1' } };
    h.state.rpcError = { code: '22023', message: 'every section must belong to this page' };

    // A list that is not a permutation is the caller's mistake, not a fault —
    // and the database's own words are not shown to them.
    await expect(
      reorderSections(CTX, 'page-1', { sectionIds: ['s1'] }),
    ).rejects.toMatchObject({ code: 'validation' });
  });
});

describe('content validation', () => {
  it('judges content against the STORED section type, not a claimed one', async () => {
    // The row says footer. `ctaHref` is a hero field, so it must be refused
    // however the caller describes the section.
    reachableSection('footer');
    await expect(
      updateSection(CTX, 'sec-1', { content: { ctaHref: '/contact' } }),
    ).rejects.toThrow();
    expect(h.calls.filter((c) => c.op === 'update')).toHaveLength(0);
  });

  it('rejects an unsafe link target', async () => {
    reachableSection('hero');
    await expect(
      updateSection(CTX, 'sec-1', { content: { ctaHref: 'javascript:alert(1)' } }),
    ).rejects.toThrow();
    expect(h.calls.filter((c) => c.op === 'update')).toHaveLength(0);
  });

  it('rejects an unknown field rather than dropping it', async () => {
    reachableSection('about');
    await expect(
      updateSection(CTX, 'sec-1', { content: { title: 'ok', script: 'x' } }),
    ).rejects.toThrow();
  });

  it('stores valid content', async () => {
    reachableSection('hero');
    await updateSection(CTX, 'sec-1', {
      content: { title: 'مرحبا', ctaHref: '/contact', align: 'start' },
    });

    const write = h.calls.filter((c) => c.table === 'site_sections').at(-1)!;
    expect(write.payload).toEqual({
      content: { title: 'مرحبا', ctaHref: '/contact', align: 'start' },
    });
  });

  it('refuses a section whose stored type this build has no schema for', async () => {
    // Unreachable while SECTION_TYPES and the 0055 check constraint agree.
    // Refusing rather than guessing is what keeps it unreachable if they stop.
    reachableSection('gallery');
    await expect(updateSection(CTX, 'sec-1', { isVisible: true })).rejects.toBeInstanceOf(
      AppError,
    );
  });
});


// ===========================================================================
// PAGE OPERATIONS (Phase 1b)
// ===========================================================================

/** A page that legitimately belongs to org A, resolvable end to end. */
function reachablePage() {
  h.state.rows = {
    site_pages: { id: 'page-1', site_id: 'site-1' },
    sites: { id: 'site-1' },
  };
}

describe('page schemas reject privileged fields', () => {
  it('createPageSchema refuses siteId, organizationId and isHomepage', () => {
    expect(() => createPageSchema.parse({ title: 'x', slug: 'x' })).not.toThrow();
    for (const extra of [
      { site_id: 'other' },
      { siteId: 'other' },
      { organization_id: 'org-b' },
      { organizationId: 'org-b' },
      { is_homepage: true },
      { isHomepage: true },
      { id: 'chosen' },
      { created_at: '2020-01-01' },
      { sort_order: 0 },
    ]) {
      // .strict(), so these are REFUSED rather than quietly stripped: a caller
      // sending them has misunderstood, and a silent success teaches them the
      // misunderstanding was right.
      expect(() => createPageSchema.parse({ title: 'x', slug: 'x', ...extra })).toThrow();
    }
  });

  it('renamePageSchema accepts only a title', () => {
    expect(() => renamePageSchema.parse({ title: 'x' })).not.toThrow();
    expect(() => renamePageSchema.parse({ title: 'x', slug: 'y' })).toThrow();
    expect(() => renamePageSchema.parse({ title: 'x', is_homepage: true })).toThrow();
    expect(() => renamePageSchema.parse({ title: 'x', site_id: 'other' })).toThrow();
  });

  it('reorderPagesSchema accepts only a list of ids', () => {
    expect(() => reorderPagesSchema.parse({ pageIds: [] })).not.toThrow();
    expect(() => reorderPagesSchema.parse({ pageIds: [], siteId: 'other' })).toThrow();
  });
});

describe('page operations', () => {
  it.each([
    ['createPage', () => createPage(CTX, 'site-1', { title: 'x', slug: 'x' })],
    ['renamePage', () => renamePage(CTX, 'page-1', { title: 'x' })],
    ['reorderPages', () => reorderPages(CTX, 'site-1', { pageIds: [] })],
    ['deletePage', () => deletePage(CTX, 'page-1')],
  ])('%s refuses a caller without site.manage', async (_name, run) => {
    h.state.permissions = new Set(['site.read']);
    await expect(run()).rejects.toBeInstanceOf(AppError);
    expect(h.calls).toHaveLength(0);
    expect(h.rpcCalls).toHaveLength(0);
  });

  it('createPage refuses a site in another organization before calling the RPC', async () => {
    h.state.rows = { sites: null };
    await expect(
      createPage(CTX, 'other-org-site', { title: 'x', slug: 'x' }),
    ).rejects.toBeInstanceOf(AppError);
    expect(h.rpcCalls).toHaveLength(0);
  });

  it('createPage scopes the site lookup to the context organization', async () => {
    h.state.rows = { sites: { id: 'site-1' } };
    h.state.rpcData = 'page-new';
    await createPage(CTX, 'site-1', { title: 'عنّا', slug: 'about' });

    expect(h.calls[0]!.filters).toEqual({ id: 'site-1', organization_id: 'org-a' });
    // No is_homepage, no sort_order, no organization: the function decides both,
    // and there is no parameter through which a caller could claim the homepage.
    expect(h.rpcCalls).toEqual([
      { fn: 'site_page_create', args: { p_site: 'site-1', p_title: 'عنّا', p_slug: 'about' } },
    ]);
  });

  it('renamePage writes only the title, only on its own site', async () => {
    reachablePage();
    await renamePage(CTX, 'page-1', { title: 'جديد' });

    const write = h.calls.filter((c) => c.table === 'site_pages').at(-1)!;
    expect(write.op).toBe('update');
    expect(write.payload).toEqual({ title: 'جديد' });
    expect(write.filters).toEqual({ id: 'page-1', site_id: 'site-1' });
  });

  it('renamePage refuses a page whose site is in another organization', async () => {
    h.state.rows = { site_pages: { id: 'page-1', site_id: 'site-1' }, sites: null };
    await expect(renamePage(CTX, 'page-1', { title: 'x' })).rejects.toBeInstanceOf(AppError);
    expect(h.calls.filter((c) => c.op === 'update')).toHaveLength(0);
  });

  it('reorderPages passes the site and ids to the RPC unchanged', async () => {
    h.state.rows = { sites: { id: 'site-1' } };
    await reorderPages(CTX, 'site-1', { pageIds: ['p1', 'p2'] });
    expect(h.rpcCalls).toEqual([
      { fn: 'site_pages_reorder', args: { p_site: 'site-1', p_ids: ['p1', 'p2'] } },
    ]);
  });

  it('reorderPages turns a non-permutation into a validation error', async () => {
    h.state.rows = { sites: { id: 'site-1' } };
    h.state.rpcError = { code: '22023', message: 'the order must list every page' };
    await expect(
      reorderPages(CTX, 'site-1', { pageIds: ['p1'] }),
    ).rejects.toMatchObject({ code: 'validation' });
  });

  it('deletePage reports the promoted homepage', async () => {
    reachablePage();
    h.state.rpcData = 'page-2';
    await expect(deletePage(CTX, 'page-1')).resolves.toEqual({ promotedPageId: 'page-2' });
    expect(h.rpcCalls).toEqual([{ fn: 'site_page_delete', args: { p_page: 'page-1' } }]);
  });

  it('deletePage reports no promotion when an ordinary page is removed', async () => {
    reachablePage();
    h.state.rpcData = null;
    await expect(deletePage(CTX, 'page-1')).resolves.toEqual({ promotedPageId: null });
  });

  it('deletePage turns "last page" into a validation error, not a fault', async () => {
    reachablePage();
    h.state.rpcError = { code: '23514', message: 'a site must keep at least one page' };
    await expect(deletePage(CTX, 'page-1')).rejects.toMatchObject({ code: 'validation' });
  });

  it('deletePage refuses a page in another organization before calling the RPC', async () => {
    h.state.rows = { site_pages: { id: 'page-1', site_id: 'site-1' }, sites: null };
    await expect(deletePage(CTX, 'page-1')).rejects.toBeInstanceOf(AppError);
    expect(h.rpcCalls).toHaveLength(0);
  });
});
