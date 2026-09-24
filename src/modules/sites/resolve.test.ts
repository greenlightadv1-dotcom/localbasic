import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SiteSection } from './types';
import type { SectionType } from './schemas';

/**
 * The data-resolution layer, at the boundary it is responsible for.
 *
 * The fake client records every table, filter and column list, so these tests
 * assert on the QUERY the resolver built — not merely on what it returned.
 * A resolver that forgot its organization filter would still return the fake's
 * rows; only inspecting the filters catches that.
 */

type Call = { table: string; filters: Record<string, unknown>; ins: Record<string, unknown[]> };

const h = vi.hoisted(() => {
  const state = {
    rows: {} as Record<string, Record<string, unknown>[]>,
    single: {} as Record<string, Record<string, unknown> | null>,
  };
  const calls: Call[] = [];
  return { state, calls };
});

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () => ({
    from: (table: string) => {
      const call: Call = { table, filters: {}, ins: {} };
      h.calls.push(call);
      const b: Record<string, unknown> = {
        select: () => b,
        order: () => b,
        eq: (col: string, val: unknown) => {
          call.filters[col] = val;
          return b;
        },
        is: (col: string, val: unknown) => {
          call.filters[col] = val;
          return b;
        },
        in: (col: string, vals: unknown[]) => {
          call.ins[col] = vals;
          return b;
        },
        maybeSingle: async () => ({ data: h.state.single[table] ?? null, error: null }),
        then: (resolve: (r: unknown) => unknown) =>
          resolve({ data: h.state.rows[table] ?? [], error: null }),
      };
      return b;
    },
  }),
}));

import { resolveSectionData } from './resolve';

/**
 * Real uuids: categoryIds is `z.string().uuid()`, so a placeholder like
 * 'cat-2' is discarded by the schema's own .catch([]) and the narrowing
 * silently would not apply — which is the schema working, and a fixture that
 * would have tested nothing.
 */
const CAT_DRINKS = '11111111-1111-4111-8111-111111111111';
const CAT_SWEETS = '22222222-2222-4222-8222-222222222222';
const CAT_FOREIGN = '99999999-9999-4999-8999-999999999999';

const CTX = {
  organizationId: 'org-a',
  organizationName: 'مطعم لافيشي',
  organizationSlug: 'lavechi',
  currency: 'EGP',
  branchId: 'branch-1',
  branchSlug: 'main',
} as never;

function section(type: SectionType, content: unknown = {}, id = `s-${type}`): SiteSection {
  return {
    id,
    pageId: 'page-1',
    sectionType: type,
    content: content as Record<string, unknown>,
    sortOrder: 0,
    isVisible: true,
  };
}

/** Every table the resolver was allowed to touch, with its filters. */
const touched = (table: string) => h.calls.filter((c) => c.table === table);

beforeEach(() => {
  h.calls.length = 0;
  h.state.rows = {
    restaurant_categories: [
      { id: CAT_DRINKS, name: 'المشروبات', sort_order: 0 },
      { id: CAT_SWEETS, name: 'الحلويات', sort_order: 1 },
    ],
    restaurant_products: [
      { id: 'p1', name: 'لاتيه', description: 'حليب وإسبريسو', image_url: null, category_id: CAT_DRINKS, sort_order: 0 },
      { id: 'p2', name: 'تشيز كيك', description: null, image_url: 'https://x/i.jpg', category_id: CAT_SWEETS, sort_order: 0 },
    ],
    restaurant_variants: [
      { id: 'v1', product_id: 'p1', name: 'وسط', price_cents: 6500, sort_order: 0 },
      { id: 'v2', product_id: 'p1', name: 'كبير', price_cents: 8000, sort_order: 1 },
      { id: 'v3', product_id: 'p2', name: 'default', price_cents: 12000, sort_order: 0 },
    ],
    branches: [
      { id: 'b1', name: 'الفرع الرئيسي', slug: 'main', address: 'شارع ٩', phone: '0100', created_at: '2024-01-01' },
      { id: 'b2', name: 'فرع المعادي', slug: 'maadi', address: 'المعادي', phone: null, created_at: '2024-02-01' },
    ],
  };
  h.state.single = {
    branding_settings: {
      display_name: 'Lavechi Café',
      logo_url: 'https://x/logo.png',
      phone: '0100',
      whatsapp: '0111',
      email: 'hi@lavechi.test',
    },
    settings: {
      value: [
        { closed: false, opens: '09:00', closes: '23:00' },
        { closed: false, opens: '09:00', closes: '23:00' },
        { closed: false, opens: '09:00', closes: '23:00' },
        { closed: false, opens: '09:00', closes: '23:00' },
        { closed: false, opens: '09:00', closes: '01:00' },
        { closed: false, opens: '10:00', closes: '01:00' },
        { closed: true },
      ],
    },
  };
});

describe('menu resolution', () => {
  it('resolves the organization menu, grouped by category', async () => {
    const map = await resolveSectionData(CTX, [section('menu')]);
    const data = map['s-menu'];
    expect(data?.type).toBe('menu');
    if (data?.type !== 'menu') return;

    expect(data.categories.map((c) => c.name)).toEqual(['المشروبات', 'الحلويات']);
    expect(data.currency).toBe('EGP');
    expect(data.categories[0]!.products[0]!.name).toBe('لاتيه');
  });

  it('takes prices from restaurant_variants, cheapest first', async () => {
    const map = await resolveSectionData(CTX, [section('menu')]);
    const data = map['s-menu'];
    if (data?.type !== 'menu') throw new Error('expected menu');

    const latte = data.categories[0]!.products[0]!;
    expect(latte.fromPriceCents).toBe(6500);
    expect(latte.variants.map((v) => v.priceCents)).toEqual([6500, 8000]);
    // Ids stay traceable to the source rows.
    expect(latte.id).toBe('p1');
    expect(latte.variants.map((v) => v.id)).toEqual(['v1', 'v2']);
  });

  it('never consults branch availability', async () => {
    // The decision this phase made explicit: a site is organization-scoped, no
    // branch is selected, so restaurant_branch_availability is not part of the
    // organization's menu.
    await resolveSectionData(CTX, [section('menu')]);
    expect(touched('restaurant_branch_availability')).toHaveLength(0);
    expect(h.calls.map((c) => c.table)).not.toContain('restaurant_branch_availability');
  });

  it('does not go through the legacy website RPC or its toggle', async () => {
    // restaurant_website_menu() is gated on restaurant.website_enabled. The
    // Site Engine is a separate system and must render regardless.
    await resolveSectionData(CTX, [section('menu')]);
    const settingsReads = touched('settings');
    expect(settingsReads).toHaveLength(0);
  });

  it('scopes every menu query to the context organization', async () => {
    await resolveSectionData(CTX, [section('menu')]);
    for (const table of ['restaurant_categories', 'restaurant_products', 'restaurant_variants']) {
      const call = touched(table)[0];
      expect(call, `${table} was not queried`).toBeDefined();
      expect(call!.filters.organization_id, `${table} was not organization-scoped`).toBe('org-a');
    }
  });

  it('narrows to configured categories without widening the organization filter', async () => {
    const map = await resolveSectionData(CTX, [
      section('menu', { categoryIds: [CAT_SWEETS] }),
    ]);
    const data = map['s-menu'];
    if (data?.type !== 'menu') throw new Error('expected menu');

    expect(data.categories.map((c) => c.id)).toEqual([CAT_SWEETS]);
    // Still scoped to this organization — a category id narrows, never widens.
    expect(touched('restaurant_categories')[0]!.filters.organization_id).toBe('org-a');
  });

  it('a category id from another organization yields nothing, not their menu', async () => {
    // The id is never used to fetch anything. It is intersected with the
    // categories this organization actually has, so a foreign id can only
    // remove rows from the result.
    const map = await resolveSectionData(CTX, [
      section('menu', { categoryIds: [CAT_FOREIGN] }),
    ]);
    const data = map['s-menu'];
    if (data?.type !== 'menu') throw new Error('expected menu');
    expect(data.categories).toEqual([]);
  });

  it('ignores an organization_id or branch_id smuggled into content', async () => {
    // These are not fields of the schema, so parseSectionContent drops them —
    // and the SQL allow-list refuses to store them in the first place. Either
    // way the resolver reads ctx.organizationId and nothing else.
    await resolveSectionData(CTX, [
      section('menu', {
        organization_id: 'org-b',
        organizationId: 'org-b',
        branch_id: 'branch-of-org-b',
        branchId: 'branch-of-org-b',
      }),
    ]);
    for (const call of h.calls) {
      expect(Object.values(call.filters)).not.toContain('org-b');
      expect(Object.values(call.filters)).not.toContain('branch-of-org-b');
    }
    expect(touched('restaurant_categories')[0]!.filters.organization_id).toBe('org-a');
  });

  it('cannot be pointed at another table by content', async () => {
    await resolveSectionData(CTX, [
      section('menu', { table: 'profiles', from: 'organizations', source: 'live' }),
    ]);
    // The resolver's table list is fixed in code; content contributes none of it.
    expect(new Set(h.calls.map((c) => c.table))).toEqual(
      new Set(['restaurant_categories', 'restaurant_products', 'restaurant_variants']),
    );
  });

  it('handles an empty menu safely', async () => {
    h.state.rows.restaurant_products = [];
    const map = await resolveSectionData(CTX, [section('menu')]);
    const data = map['s-menu'];
    if (data?.type !== 'menu') throw new Error('expected menu');
    expect(data.categories).toEqual([]);
  });

  it('drops a product with no sellable variant', async () => {
    h.state.rows.restaurant_variants = [
      { id: 'v3', product_id: 'p2', name: 'default', price_cents: 12000, sort_order: 0 },
    ];
    const map = await resolveSectionData(CTX, [section('menu')]);
    const data = map['s-menu'];
    if (data?.type !== 'menu') throw new Error('expected menu');
    // The latte has no active variant, so it has no price and is not a menu
    // item; its now-empty category disappears with it.
    expect(data.categories.map((c) => c.id)).toEqual([CAT_SWEETS]);
  });

  it('applies the existing active/not-deleted rules', async () => {
    await resolveSectionData(CTX, [section('menu')]);
    expect(touched('restaurant_products')[0]!.filters).toMatchObject({
      organization_id: 'org-a',
      is_active: true,
      deleted_at: null,
    });
    expect(touched('restaurant_variants')[0]!.filters).toMatchObject({
      is_active: true,
      deleted_at: null,
    });
    expect(touched('restaurant_categories')[0]!.filters).toMatchObject({ is_active: true });
  });
});

describe('business info resolution', () => {
  it('resolves organization-level fields from branding', async () => {
    const map = await resolveSectionData(CTX, [section('business_info')]);
    const data = map['s-business_info'];
    expect(data).toEqual({
      type: 'business_info',
      name: 'Lavechi Café',
      phone: '0100',
      whatsapp: '0111',
      email: 'hi@lavechi.test',
      logoUrl: 'https://x/logo.png',
    });
  });

  it('falls back to the organization name when no display name is set', async () => {
    h.state.single.branding_settings = { display_name: null, phone: '0100' };
    const map = await resolveSectionData(CTX, [section('business_info')]);
    const data = map['s-business_info'];
    if (data?.type !== 'business_info') throw new Error('expected business_info');
    expect(data.name).toBe('مطعم لافيشي');
  });

  it('carries no address, and reads no branch to find one', async () => {
    const map = await resolveSectionData(CTX, [section('business_info')]);
    const data = map['s-business_info'];
    if (data?.type !== 'business_info') throw new Error('expected business_info');
    expect(data).not.toHaveProperty('address');
    // The decision, enforced: there is no organization-level address, and this
    // section does not quietly borrow a branch's.
    expect(touched('branches')).toHaveLength(0);
  });

  it('is scoped to the context organization', async () => {
    await resolveSectionData(CTX, [section('business_info')]);
    expect(touched('branding_settings')[0]!.filters.organization_id).toBe('org-a');
  });
});

describe('hours resolution', () => {
  it('resolves the authoritative seven-day structure unchanged', async () => {
    const map = await resolveSectionData(CTX, [section('hours')]);
    const data = map['s-hours'];
    if (data?.type !== 'hours') throw new Error('expected hours');

    expect(data.days).toHaveLength(7);
    expect(data.days[0]).toEqual({ index: 0, closed: false, opens: '09:00', closes: '23:00' });
    // Past-midnight closing is preserved as stored, not normalised away.
    expect(data.days[4]).toEqual({ index: 4, closed: false, opens: '09:00', closes: '01:00' });
    expect(data.days[6]).toEqual({ index: 6, closed: true, opens: null, closes: null });
  });

  it('reads the organization-level setting, not a branch override', async () => {
    await resolveSectionData(CTX, [section('hours')]);
    expect(touched('settings')[0]!.filters).toEqual({
      organization_id: 'org-a',
      branch_id: null,
      key: 'restaurant.opening_hours',
    });
  });

  it('handles absent hours safely', async () => {
    h.state.single.settings = null;
    const map = await resolveSectionData(CTX, [section('hours')]);
    expect(map['s-hours']).toEqual({ type: 'hours', days: [] });
  });

  it('treats a partial week as no schedule rather than half a one', async () => {
    h.state.single.settings = { value: [{ closed: true }, { closed: true }] };
    const map = await resolveSectionData(CTX, [section('hours')]);
    expect(map['s-hours']).toEqual({ type: 'hours', days: [] });
  });

  it('computes no "currently open" flag', async () => {
    const map = await resolveSectionData(CTX, [section('hours')]);
    const data = map['s-hours'];
    if (data?.type !== 'hours') throw new Error('expected hours');
    expect(data).not.toHaveProperty('isOpenNow');
    expect(data).not.toHaveProperty('openNow');
    for (const day of data.days) expect(day).not.toHaveProperty('isOpenNow');
  });
});

describe('branches resolution', () => {
  it('resolves active branches with their own addresses', async () => {
    const map = await resolveSectionData(CTX, [section('branches')]);
    const data = map['s-branches'];
    if (data?.type !== 'branches') throw new Error('expected branches');

    expect(data.branches).toEqual([
      { id: 'b1', name: 'الفرع الرئيسي', slug: 'main', address: 'شارع ٩', phone: '0100' },
      { id: 'b2', name: 'فرع المعادي', slug: 'maadi', address: 'المعادي', phone: null },
    ]);
  });

  it('applies the authoritative active/not-deleted predicate, org-scoped', async () => {
    await resolveSectionData(CTX, [section('branches')]);
    expect(touched('branches')[0]!.filters).toEqual({
      organization_id: 'org-a',
      is_active: true,
      deleted_at: null,
    });
  });
});

describe('the resolver as a whole', () => {
  it('issues no query for a page with no data-bound section', async () => {
    await resolveSectionData(CTX, [section('hero'), section('about'), section('footer')]);
    expect(h.calls).toHaveLength(0);
  });

  it('skips hidden data-bound sections', async () => {
    const hidden = { ...section('menu'), isVisible: false };
    const map = await resolveSectionData(CTX, [hidden]);
    expect(map).toEqual({});
    expect(h.calls).toHaveLength(0);
  });

  it('keys results per section, so two menus resolve independently', async () => {
    const map = await resolveSectionData(CTX, [
      section('menu', {}, 'menu-all'),
      section('menu', { categoryIds: [CAT_SWEETS] }, 'menu-sweets'),
    ]);
    const all = map['menu-all'];
    const sweets = map['menu-sweets'];
    if (all?.type !== 'menu' || sweets?.type !== 'menu') throw new Error('expected two menus');
    expect(all.categories).toHaveLength(2);
    expect(sweets.categories.map((c) => c.id)).toEqual([CAT_SWEETS]);
  });

  it('touches only the authoritative tables, and no Site Engine table', async () => {
    await resolveSectionData(CTX, [
      section('menu'),
      section('business_info'),
      section('hours'),
      section('branches'),
    ]);
    const tables = new Set(h.calls.map((c) => c.table));
    expect(tables).toEqual(
      new Set([
        'restaurant_categories',
        'restaurant_products',
        'restaurant_variants',
        'branding_settings',
        'settings',
        'branches',
      ]),
    );
    // No site_* table is read to produce business data, and none is written.
    for (const t of tables) expect(t.startsWith('site_')).toBe(false);
  });

  it('scopes EVERY query to the context organization', async () => {
    // The single assertion that covers cross-tenant isolation for all four
    // sections at once: no query may leave without an organization filter.
    await resolveSectionData(CTX, [
      section('menu'),
      section('business_info'),
      section('hours'),
      section('branches'),
    ]);
    for (const call of h.calls) {
      expect(call.filters.organization_id, `${call.table} was not organization-scoped`).toBe(
        'org-a',
      );
    }
  });
});

describe('the renderer boundary, structurally', () => {
  // Asserted against the source rather than described in a comment: a future
  // edit that reaches for a query builder inside the renderer fails here.
  const read = (f: string) => readFileSync(join(process.cwd(), 'src/modules/sites', f), 'utf8');

  it('renderer.tsx imports nothing that can reach a database', () => {
    const src = read('renderer.tsx');
    const imports = [...src.matchAll(/^import[^;]*?from '([^']+)';/gm)].map((m) => m[1]!);

    for (const spec of imports) {
      expect(spec, `renderer imports ${spec}`).not.toMatch(/supabase/i);
      expect(spec, `renderer imports ${spec}`).not.toMatch(/server-only/);
      expect(spec, `renderer imports ${spec}`).not.toMatch(/\/resolve$/);
      expect(spec, `renderer imports ${spec}`).not.toMatch(/tenancy/);
      expect(spec, `renderer imports ${spec}`).not.toMatch(/\/service$/);
    }
    // And no query builder reached for inline.
    expect(src).not.toMatch(/createSupabaseServerClient|\.from\(['"]/);
  });

  it('the resolved render model imports nothing at all', () => {
    // ./resolved is the boundary type module. Having no imports is what makes
    // the renderer's purity structural rather than a matter of discipline.
    expect(read('resolved.ts')).not.toMatch(/^import /m);
  });

  it('the resolver is server-only, so it cannot be pulled into a bundle', () => {
    expect(read('resolve.ts')).toMatch(/^import 'server-only';/m);
  });
});
