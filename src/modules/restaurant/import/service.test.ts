import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@/lib/errors';

const h = vi.hoisted(() => {
  const state = {
    permissions: new Set<string>(['restaurant.menu.read', 'restaurant.menu.manage']),
    products: [] as Record<string, unknown>[],
    categories: [] as Record<string, unknown>[],
    insertResult: null as Record<string, unknown>[] | null,
  };
  const calls: {
    table: string;
    op: string;
    filters: Record<string, unknown>;
    payload?: unknown;
  }[] = [];
  return { state, calls };
});

vi.mock('@/modules/core/tenancy/context', () => ({
  can: (_c: unknown, p: string) => h.state.permissions.has(p),
  requirePermission: (_c: unknown, p: string) => {
    if (!h.state.permissions.has(p)) throw new AppError('forbidden');
  },
}));

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () => ({
    from: (table: string) => {
      const call = { table, op: 'select', filters: {} as Record<string, unknown> };
      h.calls.push(call);
      const rows = table === 'restaurant_products' ? h.state.products : h.state.categories;
      const b: Record<string, unknown> = {
        select: () => b,
        order: () => b,
        eq: (c: string, v: unknown) => ((call.filters[c] = v), b),
        is: (c: string, v: unknown) => ((call.filters[c] = v), b),
        insert: (payload: unknown) => {
          call.op = 'insert';
          (call as { payload?: unknown }).payload = payload;
          return b;
        },
        then: (resolve: (r: unknown) => unknown) =>
          resolve({
            data: call.op === 'insert' ? (h.state.insertResult ?? []) : rows,
            error: null,
          }),
      };
      return b;
    },
  }),
}));

import { commitImport, previewImport } from './service';

const CTX = { organizationId: 'org-a', userId: 'user-1' } as never;

const TABLE = {
  headers: ['الاسم', 'السعر', 'التصنيف'],
  rows: [
    ['لاتيه', '65', 'مشروبات'],
    ['تشيز كيك', '120', 'حلويات'],
  ],
};
const MAPPING = { name: 0, price: 1, category: 2 };

/** Every write the fake client recorded. */
const writes = () => h.calls.filter((c) => c.op === 'insert');

beforeEach(() => {
  h.calls.length = 0;
  h.state.permissions = new Set(['restaurant.menu.read', 'restaurant.menu.manage']);
  h.state.products = [];
  h.state.categories = [];
  h.state.insertResult = null;
});

describe('authorization and tenant isolation', () => {
  it('preview refuses a caller who cannot read the menu', async () => {
    h.state.permissions = new Set([]);
    await expect(previewImport(CTX, TABLE, MAPPING)).rejects.toBeInstanceOf(AppError);
    expect(h.calls).toHaveLength(0);
  });

  it('commit refuses a caller who can only read the menu', async () => {
    h.state.permissions = new Set(['restaurant.menu.read']);
    const preview = { rows: [], counts: { create: 0, skipped: 0, errors: 0 }, newCategories: [], missingRequired: [] };
    await expect(
      commitImport(CTX, preview, { createCategories: false }),
    ).rejects.toBeInstanceOf(AppError);
    expect(writes()).toHaveLength(0);
  });

  it('scopes every read to the context organization', async () => {
    await previewImport(CTX, TABLE, MAPPING);
    for (const call of h.calls) {
      expect(call.filters.organization_id, `${call.table} was not scoped`).toBe('org-a');
    }
  });

  it('stamps every written row with the context organization', async () => {
    h.state.insertResult = [{ id: 'p1', name: 'لاتيه' }];
    const preview = await previewImport(CTX, TABLE, MAPPING);
    await commitImport(CTX, preview, { createCategories: true });

    for (const write of writes()) {
      const rows = write.payload as Record<string, unknown>[];
      for (const row of rows) {
        expect(row.organization_id, `${write.table} row was not org-stamped`).toBe('org-a');
      }
    }
  });
});

describe('preview writes nothing', () => {
  it('issues no insert at all', async () => {
    const preview = await previewImport(CTX, TABLE, MAPPING);
    expect(preview.counts.create).toBe(2);
    expect(writes()).toHaveLength(0);
  });

  it('reports the required fields it is missing instead of guessing', async () => {
    const preview = await previewImport(CTX, TABLE, { name: 0 });
    expect(preview.missingRequired).toEqual(['price']);
    expect(preview.rows).toEqual([]);
    expect(writes()).toHaveLength(0);
  });

  it('numbers rows as the admin sees them, counting the header', async () => {
    const preview = await previewImport(CTX, TABLE, MAPPING);
    expect(preview.rows.map((r) => r.rowNumber)).toEqual([2, 3]);
  });
});

describe('duplicates are skipped, never merged', () => {
  it('skips a row whose name already exists, case-insensitively', async () => {
    h.state.products = [{ id: 'old', name: '  لاتيه ' }];
    const preview = await previewImport(CTX, TABLE, MAPPING);

    const latte = preview.rows.find((r) => r.values?.name === 'لاتيه')!;
    expect(latte.outcome).toBe('skip-duplicate');
    expect(preview.counts.create).toBe(1);
    expect(preview.counts.skipped).toBe(1);
  });

  it('never updates an existing product', async () => {
    h.state.products = [{ id: 'old', name: 'لاتيه' }];
    h.state.insertResult = [{ id: 'p2', name: 'تشيز كيك' }];
    const preview = await previewImport(CTX, TABLE, MAPPING);
    await commitImport(CTX, preview, { createCategories: true });

    // No update call of any kind was made, and the only inserted product is
    // the one that did not already exist.
    expect(h.calls.some((c) => c.op === 'update')).toBe(false);
    const productInsert = writes().find((w) => w.table === 'restaurant_products')!;
    const rows = productInsert.payload as Record<string, unknown>[];
    expect(rows.map((r) => r.name)).toEqual(['تشيز كيك']);
  });

  it('keeps only the first of a name repeated inside the file', async () => {
    const dup = { headers: TABLE.headers, rows: [...TABLE.rows, ['لاتيه', '70', 'مشروبات']] };
    const preview = await previewImport(CTX, dup, MAPPING);

    expect(preview.counts.create).toBe(2);
    expect(preview.rows[2]!.outcome).toBe('skip-duplicate-in-file');
  });
});

describe('categories', () => {
  it('reuses an existing category rather than creating a second', async () => {
    h.state.categories = [{ id: 'cat-1', name: 'مشروبات' }];
    h.state.insertResult = [{ id: 'p1', name: 'لاتيه' }];

    const preview = await previewImport(CTX, TABLE, MAPPING);
    expect(preview.newCategories).toEqual(['حلويات']);

    await commitImport(CTX, preview, { createCategories: false });
    // Opted out, so no category was created.
    expect(writes().some((w) => w.table === 'restaurant_categories')).toBe(false);
  });

  it('creates missing categories only when asked', async () => {
    h.state.insertResult = [{ id: 'c1', name: 'مشروبات' }];
    const preview = await previewImport(CTX, TABLE, MAPPING);
    await commitImport(CTX, preview, { createCategories: true });

    const categoryInsert = writes().find((w) => w.table === 'restaurant_categories');
    expect(categoryInsert).toBeDefined();
    expect((categoryInsert!.payload as unknown[]).length).toBe(2);
  });
});

describe('what is written', () => {
  it('writes the price as a variant, not on the product', async () => {
    h.state.insertResult = [
      { id: 'p1', name: 'لاتيه' },
      { id: 'p2', name: 'تشيز كيك' },
    ];
    const preview = await previewImport(CTX, TABLE, MAPPING);
    await commitImport(CTX, preview, { createCategories: false });

    const products = writes().find((w) => w.table === 'restaurant_products')!
      .payload as Record<string, unknown>[];
    for (const p of products) expect(p).not.toHaveProperty('price_cents');

    const variants = writes().find((w) => w.table === 'restaurant_variants')!
      .payload as Record<string, unknown>[];
    expect(variants.map((v) => v.price_cents)).toEqual([6500, 12000]);
    expect(variants.map((v) => v.product_id)).toEqual(['p1', 'p2']);
  });

  it('touches no site_engine or order table', async () => {
    h.state.insertResult = [{ id: 'p1', name: 'لاتيه' }];
    const preview = await previewImport(CTX, TABLE, MAPPING);
    await commitImport(CTX, preview, { createCategories: true });

    // The import writes the catalog. It must not reach site content, and it
    // must not touch anything order-shaped.
    for (const call of h.calls) {
      expect(call.table.startsWith('site_')).toBe(false);
      expect(call.table).not.toMatch(/order|invoice|payment/);
    }
  });

  it('reports what the database returned, not what was attempted', async () => {
    // A partial insert: two rows attempted, one came back.
    h.state.insertResult = [{ id: 'p1', name: 'لاتيه' }];
    const preview = await previewImport(CTX, TABLE, MAPPING);
    const result = await commitImport(CTX, preview, { createCategories: false });
    expect(result.created).toBe(1);
  });

  it('writes nothing when there is nothing to create', async () => {
    h.state.products = [{ id: 'a', name: 'لاتيه' }, { id: 'b', name: 'تشيز كيك' }];
    const preview = await previewImport(CTX, TABLE, MAPPING);
    const result = await commitImport(CTX, preview, { createCategories: true });

    expect(result.created).toBe(0);
    expect(result.skipped).toBe(2);
    expect(writes()).toHaveLength(0);
  });
});
