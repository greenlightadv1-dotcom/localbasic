import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Platform Admin Site Engine service, at the boundary.
 *
 * The SQL suite (34) proves the database refuses a non-admin, refuses a site
 * from the wrong customer code, and holds every publishing invariant. This
 * proves what the TypeScript layer is responsible for: that
 * requirePlatformAdmin() is checked before any RPC runs, that the customer
 * code and site id are passed straight through to the RPC rather than
 * resolved from anything client-supplied, that theme input is validated
 * against the exact tenant updateAppearanceSchema before it ever reaches the
 * database, and that a SQL "not found" (22023) becomes AppError('not_found')
 * rather than a raw error reaching a screen.
 */

const h = vi.hoisted(() => {
  const state = {
    isPlatformAdmin: true,
    rpcError: null as { code?: string; message: string } | null,
    rpcData: null as unknown,
    /** When set, only THIS rpc name fails (with rpcError); every other call succeeds with rpcData. */
    failOn: null as string | null,
  };
  const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];
  return { state, rpcCalls };
});

vi.mock('@/modules/platform/admin/context', () => ({
  requirePlatformAdmin: async () => {
    if (!h.state.isPlatformAdmin) {
      // The real requirePlatformAdmin() calls Next's notFound(), which throws
      // a special (non-AppError) value. This mock's shape is what matters for
      // these tests: something is thrown, and it is thrown before any RPC.
      throw new Error('NEXT_NOT_FOUND');
    }
    return { user: { id: 'admin-1', email: 'admin@test.local', fullName: null }, role: 'owner' };
  },
}));

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      h.rpcCalls.push({ fn, args });
      if (h.state.failOn === fn) return { data: null, error: h.state.rpcError };
      return { data: h.state.rpcData, error: null };
    },
  }),
}));

import {
  platformListSites,
  platformGetSiteDetail,
  platformUpdateTheme,
  platformPublishSite,
  platformRollbackSite,
  platformUnpublishSite,
  platformListRevisions,
} from './service';

beforeEach(() => {
  h.rpcCalls.length = 0;
  h.state.isPlatformAdmin = true;
  h.state.rpcError = null;
  h.state.rpcData = null;
  h.state.failOn = null;
});

const VALID_THEME = {
  direction: 'rtl' as const,
  locale: 'ar',
  primary: '#111827',
  background: '#ffffff',
  foreground: '#111827',
  border: '#e5e7eb',
};

describe('authorization', () => {
  it.each([
    ['platformListSites', () => platformListSites('LB-000001')],
    ['platformGetSiteDetail', () => platformGetSiteDetail('LB-000001', 'site-1')],
    ['platformUpdateTheme', () => platformUpdateTheme('LB-000001', 'site-1', VALID_THEME)],
    ['platformPublishSite', () => platformPublishSite('LB-000001', 'site-1')],
    ['platformRollbackSite', () => platformRollbackSite('LB-000001', 'site-1', 'rev-1')],
    ['platformUnpublishSite', () => platformUnpublishSite('LB-000001', 'site-1')],
    ['platformListRevisions', () => platformListRevisions('LB-000001', 'site-1')],
  ])('%s refuses a non-admin before any RPC runs', async (_name, run) => {
    h.state.isPlatformAdmin = false;
    await expect(run()).rejects.toThrow();
    expect(h.rpcCalls).toHaveLength(0);
  });
});

describe('platformListSites', () => {
  it('passes the customer code straight through and maps the row shape', async () => {
    h.state.rpcData = [
      { id: 's1', name: 'Site', slug: 'site', status: 'draft', created_at: 'a', updated_at: 'b' },
    ];
    const sites = await platformListSites('LB-000001');
    expect(h.rpcCalls).toEqual([
      { fn: 'platform_site_list', args: { p_customer_code: 'LB-000001' } },
    ]);
    expect(sites).toEqual([
      { id: 's1', name: 'Site', slug: 'site', status: 'draft', createdAt: 'a', updatedAt: 'b' },
    ]);
  });
});

describe('platformGetSiteDetail', () => {
  it('returns null rather than throwing when the RPC finds no matching row', async () => {
    h.state.rpcData = [];
    const detail = await platformGetSiteDetail('LB-000001', 'site-1');
    expect(detail).toBeNull();
  });

  it('parses settings and snapshot tolerantly, and reports no live revision as null', async () => {
    h.state.rpcData = [
      {
        organization_id: 'org-1', organization_name: 'Org', organization_code: 'LB-000001',
        organization_currency: 'EGP',
        site_name: 'Site', site_slug: 'site', site_status: 'draft',
        site_created_at: 'a', site_updated_at: 'b',
        settings: { theme: { primary: '#123456' } },
        snapshot: { site: { id: 'site-1' }, pages: [] },
        live_version: null, live_published_at: null, live_note: null, live_snapshot: null,
      },
    ];
    const detail = await platformGetSiteDetail('LB-000001', 'site-1');
    expect(detail?.live).toBeNull();
    expect(detail?.settings.theme.primary).toBe('#123456');
    // Fields the row did not set fall back rather than throwing — the same
    // tolerance siteSettingsSchema gives the tenant editor.
    expect(detail?.settings.theme.background).toBe('#ffffff');
  });
});

describe('platformUpdateTheme', () => {
  it('rejects an invalid colour before any RPC runs', async () => {
    await expect(
      platformUpdateTheme('LB-000001', 'site-1', { ...VALID_THEME, primary: 'red' }),
    ).rejects.toMatchObject({ code: 'validation' });
    expect(h.rpcCalls).toHaveLength(0);
  });

  it('reads the current settings, merges the theme over them, and writes the merged object', async () => {
    h.state.rpcData = [{ settings: { locale: 'en', direction: 'ltr', templateId: 'business' } }];
    await platformUpdateTheme('LB-000001', 'site-1', VALID_THEME);

    expect(h.rpcCalls.map((c) => c.fn)).toEqual(['platform_site_detail', 'platform_site_theme_update']);
    const written = h.rpcCalls[1]!.args.p_settings as Record<string, unknown>;
    // The form's own values win...
    expect(written.locale).toBe('ar');
    expect(written.direction).toBe('rtl');
    // ...and templateId, which the form never sends, survives the merge.
    expect(written.templateId).toBe('business');
  });

  it('turns a "site not found" (22023) from the write into AppError(not_found)', async () => {
    h.state.rpcData = [{ settings: {} }];
    h.state.failOn = 'platform_site_theme_update';
    h.state.rpcError = { code: '22023', message: 'site not found' };

    await expect(platformUpdateTheme('LB-000001', 'ghost', VALID_THEME)).rejects.toMatchObject({
      code: 'not_found',
    });
    // The read succeeded (call 1); only the write (call 2) was made to fail.
    expect(h.rpcCalls.map((c) => c.fn)).toEqual(['platform_site_detail', 'platform_site_theme_update']);
  });
});

describe('platformPublishSite / platformRollbackSite / platformUnpublishSite', () => {
  it('platformPublishSite passes an optional note through and maps out_version/out_revision', async () => {
    h.state.rpcData = [{ out_version: 2, out_revision: 'rev-2' }];
    const result = await platformPublishSite('LB-000001', 'site-1', 'launch');
    expect(h.rpcCalls).toEqual([
      {
        fn: 'platform_site_publish',
        args: { p_customer_code: 'LB-000001', p_site: 'site-1', p_note: 'launch' },
      },
    ]);
    expect(result).toEqual({ version: 2, revisionId: 'rev-2' });
  });

  it('platformRollbackSite passes the target revision id through unchanged', async () => {
    h.state.rpcData = 1;
    const result = await platformRollbackSite('LB-000001', 'site-1', 'rev-1');
    expect(h.rpcCalls).toEqual([
      {
        fn: 'platform_site_rollback',
        args: { p_customer_code: 'LB-000001', p_site: 'site-1', p_revision: 'rev-1' },
      },
    ]);
    expect(result).toEqual({ version: 1 });
  });

  it('platformUnpublishSite raises AppError(not_found) for a 22023 SQL error', async () => {
    h.state.failOn = 'platform_site_unpublish';
    h.state.rpcError = { code: '22023', message: 'site not found' };
    await expect(platformUnpublishSite('LB-000001', 'ghost')).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});
