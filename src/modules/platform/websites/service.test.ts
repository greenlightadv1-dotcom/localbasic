import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@/lib/errors';

const h = vi.hoisted(() => {
  const state = {
    isPlatformAdmin: true,
    /** What the business-profile projection returns; null = not available. */
    business: null as unknown,
    insertError: null as { code?: string; message: string } | null,
  };
  const inserted: Record<string, unknown>[] = [];

  // notFound() is how requirePlatformAdmin refuses. Thrown here so a test can
  // tell "refused" apart from "returned nothing".
  const notFound = vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  });

  return { state, inserted, notFound };
});

vi.mock('next/navigation', () => ({ notFound: h.notFound }));

vi.mock('@/modules/platform/admin/context', () => ({
  getPlatformContext: async () =>
    h.state.isPlatformAdmin ? { user: { id: 'admin-1' }, role: 'owner' } : null,
  requirePlatformAdmin: async () => {
    if (!h.state.isPlatformAdmin) h.notFound();
    return { user: { id: 'admin-1' }, role: 'owner' };
  },
}));

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () => ({
    rpc: async (fn: string) =>
      fn === 'platform_website_business_profile'
        ? { data: h.state.business, error: null }
        : { data: null, error: null },
    from: () => {
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        in: () => b,
        is: () => b,
        order: () => b,
        maybeSingle: async () => ({ data: null, error: null }),
        single: async () => ({ data: { id: 'new-website' }, error: h.state.insertError }),
        insert: (row: Record<string, unknown>) => {
          h.inserted.push(row);
          return b;
        },
        update: () => b,
        then: (resolve: (r: unknown) => unknown) => resolve({ data: [], error: null }),
      };
      return b;
    },
  }),
}));

import { createWebsite, listWebsites, getWebsite, publishWebsite } from './service';

const BUSINESS_ROW = {
  organization_name: 'مطعم لافيشي',
  organization_slug: 'lavechi',
  primary_module: 'restaurant',
  currency: 'EGP',
  display_name: null,
  logo_url: null,
  primary_color: '#1E2FC8',
  secondary_color: '#6B8BFA',
  phone: '0100',
  whatsapp: null,
  email: null,
  opening_hours: null,
  branch_count: 1,
};

const INPUT = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  name: 'موقع لافيشي',
  slug: 'lavechi-site',
  siteType: 'restaurant',
  locale: 'ar',
  brief: { notes: 'موقع بسيط' },
};

beforeEach(() => {
  vi.clearAllMocks();
  h.inserted.length = 0;
  h.state.isPlatformAdmin = true;
  h.state.business = [BUSINESS_ROW];
  h.state.insertError = null;
});

describe('platform gate', () => {
  // Every surface, not just the pages. A tenant user posting straight at the
  // service gets the same refusal the UI gives them.
  it.each([
    ['listWebsites', () => listWebsites()],
    ['getWebsite', () => getWebsite('any')],
    ['createWebsite', () => createWebsite(INPUT)],
    ['publishWebsite', () => publishWebsite('any')],
  ])('refuses %s for a non platform admin', async (_name, call) => {
    h.state.isPlatformAdmin = false;
    await expect(call()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(h.notFound).toHaveBeenCalled();
  });

  it('admits a platform admin', async () => {
    await expect(listWebsites()).resolves.toEqual([]);
    expect(h.notFound).not.toHaveBeenCalled();
  });
});

describe('createWebsite', () => {
  it('creates a website for a valid organization', async () => {
    await expect(createWebsite(INPUT)).resolves.toBe('new-website');
    expect(h.inserted).toHaveLength(1);
  });

  // The foreign key would catch a fabricated id. This catches the case worth
  // checking: an id naming a customer that is gone or not visible.
  it('refuses an organization the projection will not return', async () => {
    h.state.business = [];
    await expect(createWebsite(INPUT)).rejects.toThrow(AppError);
    expect(h.inserted).toHaveLength(0);
  });

  it('refuses a forged organization id that is not a uuid', async () => {
    await expect(createWebsite({ ...INPUT, organizationId: "' or 1=1--" })).rejects.toThrow(
      AppError,
    );
    expect(h.inserted).toHaveLength(0);
  });

  // Authorship is not accepted from the caller. The row is written with nulls
  // and the database sets both columns from auth.uid().
  it('never carries a caller-supplied creator into the insert', async () => {
    await createWebsite({ ...INPUT, createdBy: 'someone-else' } as never);
    expect(h.inserted[0]!.created_by).toBeNull();
    expect(h.inserted[0]!.updated_by).toBeNull();
  });

  // The first draft goes through the same AI boundary a generated one will,
  // so nothing is ever stored that the schema has not accepted.
  it('stores a first draft that is a valid definition', async () => {
    await createWebsite(INPUT);
    const draft = h.inserted[0]!.draft_definition as { version: number; pages: unknown[] };
    expect(draft.version).toBe(1);
    expect(draft.pages.length).toBeGreaterThan(0);
  });

  it('rejects a name carrying markup', async () => {
    await expect(createWebsite({ ...INPUT, name: '<script>x</script>' })).rejects.toThrow(AppError);
    expect(h.inserted).toHaveLength(0);
  });

  it('rejects a slug that is not a slug', async () => {
    for (const slug of ['Has Spaces', '../etc', 'a', 'has_underscore', '-leading']) {
      await expect(createWebsite({ ...INPUT, slug })).rejects.toThrow(AppError);
    }
    expect(h.inserted).toHaveLength(0);
  });

  // Normalised rather than refused, matching how provisionWorkspace treats an
  // organization slug: the operator types what they like and gets one form.
  it('lowercases a slug instead of rejecting it', async () => {
    await createWebsite({ ...INPUT, slug: '  LaVeChi-Site  ' });
    expect(h.inserted[0]!.slug).toBe('lavechi-site');
  });
});
