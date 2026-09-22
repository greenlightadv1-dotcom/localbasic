import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@/lib/errors';

/**
 * The editor's service boundary.
 *
 * The UI is forms posting to Server Actions; the Actions call these services.
 * These tests cover the layer both depend on — that every editor operation
 * refuses a caller without `site.manage`, scopes through the parent chain, and
 * stores only what the schema allows.
 *
 * TEST-SETUP NOTE. The repository has no browser test runner (no Playwright,
 * Cypress or Testing Library), and this phase does not add one. Server
 * Components that post to Server Actions cannot be driven end to end here, so
 * the UI is covered structurally — the section registry the "add section" list
 * is built from, the schemas the forms are built from — and behaviourally at
 * the service boundary, which is where the security actually lives. The gap is
 * real and is reported rather than papered over.
 */

const h = vi.hoisted(() => {
  const state = {
    permissions: new Set<string>(['site.read', 'site.manage']),
    rows: {} as Record<string, Record<string, unknown> | null>,
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
  can: (_c: unknown, p: string) => h.state.permissions.has(p),
  requirePermission: (_c: unknown, p: string) => {
    if (!h.state.permissions.has(p)) throw new AppError('forbidden');
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
        limit: () => b,
        in: () => b,
        is: (c: string, v: unknown) => ((call.filters[c] = v), b),
        eq: (c: string, v: unknown) => ((call.filters[c] = v), b),
        insert: (payload: Record<string, unknown>) => {
          call.op = 'insert';
          (call as { payload?: unknown }).payload = payload;
          return b;
        },
        update: (payload: Record<string, unknown>) => {
          call.op = 'update';
          (call as { payload?: unknown }).payload = payload;
          return b;
        },
        delete: () => ((call.op = 'delete'), b),
        maybeSingle: async () => ({ data: h.state.rows[table] ?? null, error: null }),
      };
      return b;
    },
  }),
}));

import {
  createPage,
  createSection,
  deletePage,
  deleteSection,
  renamePage,
  reorderPages,
  reorderSections,
  updateSection,
  updateSite,
} from './service';
import {
  SECTION_DESCRIPTIONS,
  SECTION_LABELS,
  SECTION_TYPES,
  createSectionSchema,
  isDataBoundSection,
} from './schemas';
import { SECTION_WRITE_SCHEMAS } from './sections/content';

const CTX = { organizationId: 'org-a', organizationSlug: 'alpha', branchSlug: 'main' } as never;

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
  h.state.rows = {};
  h.state.rpcError = null;
  h.state.rpcData = null;
});

describe('every editor operation requires site.manage', () => {
  // The single test that covers the whole surface: a reader can open the
  // screens, and can change nothing through any path behind them.
  it.each([
    ['updateSite', () => updateSite(CTX, 'site-1', { name: 'New' })],
    ['createPage', () => createPage(CTX, 'site-1', { title: 'T', slug: 'p' })],
    ['renamePage', () => renamePage(CTX, 'page-1', { title: 'T' })],
    ['reorderPages', () => reorderPages(CTX, 'site-1', { pageIds: [] })],
    ['deletePage', () => deletePage(CTX, 'page-1')],
    ['createSection', () => createSection(CTX, 'page-1', { sectionType: 'hero' })],
    ['updateSection', () => updateSection(CTX, 'sec-1', { isVisible: false })],
    ['reorderSections', () => reorderSections(CTX, 'page-1', { sectionIds: [] })],
    ['deleteSection', () => deleteSection(CTX, 'sec-1')],
  ])('%s refuses a site.read-only caller, before any query', async (_n, run) => {
    h.state.permissions = new Set(['site.read']);
    await expect(run()).rejects.toBeInstanceOf(AppError);
    expect(h.calls).toHaveLength(0);
    expect(h.rpcCalls).toHaveLength(0);
  });
});

describe('add section', () => {
  it('creates an empty section at the end of its page', async () => {
    h.state.rows = {
      site_pages: { id: 'page-1', site_id: 'site-1' },
      sites: { id: 'site-1' },
      site_sections: { sort_order: 4, id: 'new-1' },
    };
    await createSection(CTX, 'page-1', { sectionType: 'menu' });

    const insert = h.calls.find((c) => c.op === 'insert')!;
    expect(insert.table).toBe('site_sections');
    expect(insert.payload).toEqual({
      page_id: 'page-1',
      section_type: 'menu',
      content: {},
      sort_order: 5,
      is_visible: true,
    });
  });

  it('refuses a page in another organization before inserting', async () => {
    h.state.rows = { site_pages: { id: 'page-1', site_id: 'site-1' }, sites: null };
    await expect(
      createSection(CTX, 'page-1', { sectionType: 'hero' }),
    ).rejects.toBeInstanceOf(AppError);
    expect(h.calls.filter((c) => c.op === 'insert')).toHaveLength(0);
  });

  it('cannot create an unsupported section type', () => {
    // The "add section" list is built from SECTION_TYPES and the action parses
    // with this schema, so a type the renderer cannot draw is refused before
    // the database's own CHECK constraint is reached.
    for (const bad of ['gallery', 'reservations', 'html', 'script', '']) {
      expect(createSectionSchema.safeParse({ sectionType: bad }).success).toBe(false);
    }
    for (const good of SECTION_TYPES) {
      expect(createSectionSchema.safeParse({ sectionType: good }).success).toBe(true);
    }
  });

  it('refuses privileged fields in the create payload', () => {
    expect(
      createSectionSchema.safeParse({ sectionType: 'hero', pageId: 'other' }).success,
    ).toBe(false);
    expect(
      createSectionSchema.safeParse({ sectionType: 'hero', sortOrder: 0 }).success,
    ).toBe(false);
    expect(
      createSectionSchema.safeParse({ sectionType: 'hero', content: {} }).success,
    ).toBe(false);
  });
});

describe('editing a section', () => {
  it('saves content against the STORED type, not a claimed one', async () => {
    reachableSection('footer');
    // The editor posts sectionType so the action knows which fields to read,
    // but the service reads the type from the row — so hero fields on a footer
    // are refused however the form describes itself.
    await expect(
      updateSection(CTX, 'sec-1', { content: { ctaHref: '/contact' } }),
    ).rejects.toThrow();
  });

  it('rejects an unsafe CTA target', async () => {
    reachableSection('hero');
    for (const href of ['javascript:alert(1)', 'https://evil.example', '//evil.example']) {
      await expect(
        updateSection(CTX, 'sec-1', { content: { ctaHref: href } }),
      ).rejects.toThrow();
    }
  });

  it('stores a valid hero edit', async () => {
    reachableSection('hero');
    await updateSection(CTX, 'sec-1', {
      content: { title: 'مرحبا', ctaLabel: 'اطلب', ctaHref: '/contact', align: 'start' },
    });
    const write = h.calls.filter((c) => c.table === 'site_sections').at(-1)!;
    expect(write.payload).toEqual({
      content: { title: 'مرحبا', ctaLabel: 'اطلب', ctaHref: '/contact', align: 'start' },
    });
  });

  it('toggles visibility without touching content', async () => {
    reachableSection('about');
    await updateSection(CTX, 'sec-1', { isVisible: false });
    const write = h.calls.filter((c) => c.table === 'site_sections').at(-1)!;
    expect(write.payload).toEqual({ is_visible: false });
    expect(write.payload).not.toHaveProperty('content');
  });
});

describe('data-bound section forms store configuration only', () => {
  // The acceptance criterion for Phase 3, enforced at the editor's boundary:
  // whatever the form posts, only declarative configuration can be stored.
  const copied: Record<string, unknown>[] = [
    { items: [{ name: 'لاتيه', price: 6500 }] },
    { prices: { latte: 6500 } },
    { name: 'Lavechi' },
    { phone: '0100' },
    { address: 'شارع ٩' },
    { days: [] },
    { opens: '09:00' },
    { branches: [] },
    { organization_id: 'org-b' },
    { branch_id: 'branch-b' },
    { organizationId: 'org-b' },
  ];

  it.each(['menu', 'business_info', 'hours', 'branches'] as const)(
    '%s refuses copied business data',
    (type) => {
      for (const payload of copied) {
        expect(
          SECTION_WRITE_SCHEMAS[type].safeParse({ source: 'live', ...payload }).success,
          `${type} accepted ${JSON.stringify(payload)}`,
        ).toBe(false);
      }
    },
  );

  it('accepts exactly the declarative options each type supports', () => {
    expect(
      SECTION_WRITE_SCHEMAS.menu.safeParse({
        title: 'القائمة',
        source: 'live',
        categoryIds: ['11111111-1111-4111-8111-111111111111'],
        limit: 20,
      }).success,
    ).toBe(true);
    for (const type of ['business_info', 'hours', 'branches'] as const) {
      expect(SECTION_WRITE_SCHEMAS[type].safeParse({ title: 'ع', source: 'live' }).success).toBe(
        true,
      );
    }
  });

  it('refuses a source other than live', () => {
    for (const type of ['menu', 'business_info', 'hours', 'branches'] as const) {
      expect(SECTION_WRITE_SCHEMAS[type].safeParse({ source: 'snapshot' }).success).toBe(false);
    }
  });
});

describe('the section registry the editor is built from', () => {
  it('describes and labels every type, so the add list cannot show a blank', () => {
    for (const t of SECTION_TYPES) {
      expect(SECTION_LABELS[t], `${t} has no label`).toBeTruthy();
      expect(SECTION_DESCRIPTIONS[t], `${t} has no description`).toBeTruthy();
    }
    expect(Object.keys(SECTION_DESCRIPTIONS).sort()).toEqual([...SECTION_TYPES].sort());
  });

  it('marks exactly the live-data types, so the UI can say which are live', () => {
    expect(SECTION_TYPES.filter(isDataBoundSection)).toEqual([
      'menu',
      'business_info',
      'hours',
      'branches',
    ]);
  });

  it('offers a write schema for every creatable type', () => {
    // The editor builds each form from its type's write schema, so a type in
    // the registry without one would render an uneditable section.
    for (const t of SECTION_TYPES) {
      expect(SECTION_WRITE_SCHEMAS[t], `${t} has no write schema`).toBeTruthy();
    }
  });
});

describe('pages, through the editor', () => {
  it('creates a page without naming its site, order or homepage state', async () => {
    h.state.rows = { sites: { id: 'site-1' } };
    h.state.rpcData = 'page-new';
    await createPage(CTX, 'site-1', { title: 'من نحن', slug: 'about' });
    expect(h.rpcCalls).toEqual([
      { fn: 'site_page_create', args: { p_site: 'site-1', p_title: 'من نحن', p_slug: 'about' } },
    ]);
  });

  it('renames only the title', async () => {
    h.state.rows = { site_pages: { id: 'page-1', site_id: 'site-1' }, sites: { id: 'site-1' } };
    await renamePage(CTX, 'page-1', { title: 'جديد' });
    const write = h.calls.filter((c) => c.table === 'site_pages').at(-1)!;
    expect(write.payload).toEqual({ title: 'جديد' });
  });

  it('delegates homepage deletion entirely to the server', async () => {
    h.state.rows = { site_pages: { id: 'page-1', site_id: 'site-1' }, sites: { id: 'site-1' } };
    h.state.rpcData = 'page-2';
    // The UI does not decide what happens; it reports what came back.
    await expect(deletePage(CTX, 'page-1')).resolves.toEqual({ promotedPageId: 'page-2' });
  });

  it('surfaces the last-page refusal as a validation error, not a crash', async () => {
    h.state.rows = { site_pages: { id: 'page-1', site_id: 'site-1' }, sites: { id: 'site-1' } };
    h.state.rpcError = { code: '23514', message: 'a site must keep at least one page' };
    await expect(deletePage(CTX, 'page-1')).rejects.toMatchObject({ code: 'validation' });
  });

  it('deleting a section leaves the page in place', async () => {
    reachableSection('about');
    h.state.rows.site_sections = { id: 'sec-1', page_id: 'page-1', section_type: 'about' };
    await deleteSection(CTX, 'sec-1');
    // Only the section row is touched; nothing deletes a page.
    expect(h.calls.filter((c) => c.op === 'delete').map((c) => c.table)).toEqual([
      'site_sections',
    ]);
  });
});
