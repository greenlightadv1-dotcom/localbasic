import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@/lib/errors';
import { draftDiffersFrom, parseSnapshot, type SiteSnapshot } from './publishing';

/**
 * Publishing, at the two layers TypeScript owns.
 *
 * The database tests (33_site_publishing.sql) prove immutability, the one-live
 * rule, rollback and the permission checks — those live in SQL and are tested
 * in SQL. These cover what the application is responsible for: that a snapshot
 * read back from jsonb degrades rather than throws, that the draft/live
 * comparison is honest, and that every publishing service refuses a caller
 * without `site.manage` before reaching the database.
 */

const h = vi.hoisted(() => {
  const state = {
    permissions: new Set<string>(['site.read', 'site.manage']),
    rpcError: null as { code?: string; message: string } | null,
    rpcData: null as unknown,
    row: null as Record<string, unknown> | null,
    rows: [] as Record<string, unknown>[],
  };
  const calls: { table: string; filters: Record<string, unknown> }[] = [];
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
      const call = { table, filters: {} as Record<string, unknown> };
      h.calls.push(call);
      const b: Record<string, unknown> = {
        select: () => b,
        order: () => b,
        eq: (c: string, v: unknown) => ((call.filters[c] = v), b),
        maybeSingle: async () => ({ data: h.state.row, error: null }),
        then: (resolve: (r: unknown) => unknown) =>
          resolve({ data: h.state.rows, error: null }),
      };
      return b;
    },
  }),
}));

import {
  getLiveRevision,
  listRevisions,
  publishSite,
  rollbackSite,
  unpublishSite,
} from './service';

const CTX = { organizationId: 'org-a', organizationSlug: 'alpha', branchSlug: 'main' } as never;

const SNAPSHOT: SiteSnapshot = {
  site: { id: 'site-1', name: 'Alpha', slug: 'alpha-site', templateId: 'business' },
  settings: { locale: 'ar' },
  pages: [
    {
      id: 'page-a',
      title: 'الرئيسية',
      slug: 'home',
      isHomepage: true,
      sortOrder: 0,
      sections: [
        { id: 'sec-1', sectionType: 'hero', content: { title: 'منشور' }, sortOrder: 0 },
      ],
    },
  ],
};

beforeEach(() => {
  h.calls.length = 0;
  h.rpcCalls.length = 0;
  h.state.permissions = new Set(['site.read', 'site.manage']);
  h.state.rpcError = null;
  h.state.rpcData = null;
  h.state.row = null;
  h.state.rows = [];
});

describe('snapshot parsing', () => {
  it('round-trips a well-formed snapshot', () => {
    expect(parseSnapshot(SNAPSHOT)).toEqual(SNAPSHOT);
  });

  it('never throws on anything a jsonb column can hold', () => {
    for (const bad of [null, undefined, 'text', 42, [], {}, { pages: 'no' }, { pages: [1, 2] }]) {
      expect(() => parseSnapshot(bad)).not.toThrow();
    }
    expect(parseSnapshot(null).pages).toEqual([]);
    expect(parseSnapshot({ pages: 'no' }).pages).toEqual([]);
  });

  it('drops a section whose type this build cannot render', () => {
    // A snapshot written by a later build. Dropping beats rendering a blank,
    // and matches what getSiteDetail does with a draft.
    const future = {
      ...SNAPSHOT,
      pages: [
        {
          ...SNAPSHOT.pages[0]!,
          sections: [
            SNAPSHOT.pages[0]!.sections[0]!,
            { id: 'x', sectionType: 'gallery', content: {}, sortOrder: 1 },
          ],
        },
      ],
    };
    const parsed = parseSnapshot(future);
    expect(parsed.pages[0]!.sections.map((s) => s.id)).toEqual(['sec-1']);
  });

  it('keeps a page whose content is unreadable rather than losing the page', () => {
    const odd = {
      ...SNAPSHOT,
      pages: [{ ...SNAPSHOT.pages[0]!, sections: 'not a list' }],
    };
    const parsed = parseSnapshot(odd);
    expect(parsed.pages).toHaveLength(1);
    expect(parsed.pages[0]!.sections).toEqual([]);
  });
});

describe('draft versus live', () => {
  const draft = {
    pages: [{ id: 'page-a', title: 'الرئيسية', slug: 'home', isHomepage: true }],
    sections: [
      { id: 'sec-1', pageId: 'page-a', content: { title: 'منشور' }, isVisible: true },
    ],
  };

  it('reports no change when the draft matches what was published', () => {
    expect(draftDiffersFrom(SNAPSHOT, draft)).toBe(false);
  });

  it('notices edited content', () => {
    expect(
      draftDiffersFrom(SNAPSHOT, {
        ...draft,
        sections: [{ ...draft.sections[0]!, content: { title: 'مسودة' } }],
      }),
    ).toBe(true);
  });

  it('notices a renamed page, an added page and a removed page', () => {
    expect(
      draftDiffersFrom(SNAPSHOT, {
        ...draft,
        pages: [{ ...draft.pages[0]!, title: 'جديد' }],
      }),
    ).toBe(true);
    expect(
      draftDiffersFrom(SNAPSHOT, {
        ...draft,
        pages: [...draft.pages, { id: 'p2', title: 'ب', slug: 'b', isHomepage: false }],
      }),
    ).toBe(true);
    expect(draftDiffersFrom(SNAPSHOT, { pages: [], sections: [] })).toBe(true);
  });

  it('notices a section hidden or added since the publish', () => {
    // Hiding is how a section is taken down, so it counts as a pending change.
    expect(
      draftDiffersFrom(SNAPSHOT, {
        ...draft,
        sections: [{ ...draft.sections[0]!, isVisible: false }],
      }),
    ).toBe(true);
    expect(
      draftDiffersFrom(SNAPSHOT, {
        ...draft,
        sections: [
          ...draft.sections,
          { id: 'sec-2', pageId: 'page-a', content: {}, isVisible: true },
        ],
      }),
    ).toBe(true);
  });

  it('ignores hidden sections that were never published', () => {
    // A section hidden before the publish is absent from the snapshot and
    // still hidden, so nothing has changed.
    const withHidden = {
      ...draft,
      sections: [
        ...draft.sections,
        { id: 'sec-hidden', pageId: 'page-a', content: {}, isVisible: false },
      ],
    };
    expect(draftDiffersFrom(SNAPSHOT, withHidden)).toBe(false);
  });
});

describe('publishing services', () => {
  it.each([
    ['publishSite', () => publishSite(CTX, 'site-1')],
    ['rollbackSite', () => rollbackSite(CTX, 'site-1', 'rev-1')],
    ['unpublishSite', () => unpublishSite(CTX, 'site-1')],
  ])('%s refuses a site.read-only caller before any call', async (_n, run) => {
    h.state.permissions = new Set(['site.read']);
    await expect(run()).rejects.toBeInstanceOf(AppError);
    expect(h.rpcCalls).toHaveLength(0);
    expect(h.calls).toHaveLength(0);
  });

  it('publishes through the database function, passing only a site and a note', async () => {
    h.state.rpcData = [{ out_version: 3, out_revision: 'rev-3' }];
    await expect(publishSite(CTX, 'site-1', ' نشر ')).resolves.toEqual({
      version: 3,
      revisionId: 'rev-3',
    });
    // No organization id and no snapshot travel from here: the function builds
    // the snapshot itself and reads the organization off the site row.
    expect(h.rpcCalls).toEqual([
      { fn: 'site_publish', args: { p_site: 'site-1', p_note: ' نشر ' } },
    ]);
  });

  it('turns an unpublishable site into a validation error', async () => {
    h.state.rpcError = { code: '22023', message: 'a snapshot must carry at least one page' };
    await expect(publishSite(CTX, 'site-1')).rejects.toMatchObject({ code: 'validation' });
  });

  it('turns an unknown revision into a not-found', async () => {
    h.state.rpcError = { code: '22023', message: 'revision not found' };
    await expect(rollbackSite(CTX, 'site-1', 'rev-of-another-site')).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('rolls back by revision id, scoped to the site', async () => {
    h.state.rpcData = 2;
    await expect(rollbackSite(CTX, 'site-1', 'rev-2')).resolves.toEqual({ version: 2 });
    expect(h.rpcCalls).toEqual([
      { fn: 'site_rollback', args: { p_site: 'site-1', p_revision: 'rev-2' } },
    ]);
  });
});

describe('reading revisions', () => {
  it('scopes the history to the context organization', async () => {
    h.state.rows = [
      {
        id: 'rev-1',
        site_id: 'site-1',
        version: 1,
        is_live: true,
        published_at: '2026-01-01T00:00:00Z',
        published_by: null,
        note: null,
      },
    ];
    const out = await listRevisions(CTX, 'site-1');
    expect(out).toHaveLength(1);
    expect(h.calls[0]!.filters).toEqual({ site_id: 'site-1', organization_id: 'org-a' });
  });

  it('returns nothing to a caller without site.read', async () => {
    h.state.permissions = new Set([]);
    expect(await listRevisions(CTX, 'site-1')).toEqual([]);
    expect(await getLiveRevision(CTX, 'site-1')).toBeNull();
    expect(h.calls).toHaveLength(0);
  });

  it('reads only the live revision, with its snapshot parsed', async () => {
    h.state.row = {
      id: 'rev-2',
      site_id: 'site-1',
      version: 2,
      is_live: true,
      published_at: '2026-01-02T00:00:00Z',
      published_by: 'user-1',
      note: 'ثانٍ',
      snapshot: SNAPSHOT,
    };
    const live = await getLiveRevision(CTX, 'site-1');
    expect(live?.version).toBe(2);
    expect(live?.snapshot.pages[0]!.sections[0]!.content).toEqual({ title: 'منشور' });
    expect(h.calls[0]!.filters).toEqual({
      site_id: 'site-1',
      organization_id: 'org-a',
      is_live: true,
    });
  });

  it('survives a malformed stored snapshot rather than failing the read', async () => {
    h.state.row = {
      id: 'rev-3',
      site_id: 'site-1',
      version: 3,
      is_live: true,
      published_at: '2026-01-03T00:00:00Z',
      published_by: null,
      note: null,
      snapshot: 'not an object',
    };
    const live = await getLiveRevision(CTX, 'site-1');
    expect(live?.snapshot.pages).toEqual([]);
  });

  it('returns null when nothing is live', async () => {
    h.state.row = null;
    expect(await getLiveRevision(CTX, 'site-1')).toBeNull();
  });
});
