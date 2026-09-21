import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A report that reads only the first page of a busy day under-reports revenue
 * and never says so. PostgREST caps an unranged .select() at db-max-rows, and
 * these totals are summed in JavaScript, so truncation is silent by
 * construction.
 *
 * The fake below behaves like a capped server: it honours .range() but never
 * returns more than `serverCap` rows at once, and reports the true total in
 * `count` the way PostgREST does in Content-Range. A service that stops at the
 * first page fails these tests; one that pages to the reported total passes
 * whatever the cap is.
 */

const h = vi.hoisted(() => ({
  rows: {} as Record<string, Record<string, unknown>[]>,
  filters: [] as { table: string; op: string; args: unknown[] }[],
  serverCap: 3,
  requests: [] as { table: string; from: number; to: number }[],
}));

vi.mock('react', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('react')),
  cache: <T>(fn: T) => fn,
}));

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () => ({
    from: (table: string) => {
      // Every filter this builder is given, applied to the fake table in the
      // same way PostgREST would, so isolation can be asserted end to end.
      const preds: ((row: Record<string, unknown>) => boolean)[] = [];
      let range: { from: number; to: number } = { from: 0, to: Infinity };

      const record = (op: string, args: unknown[]) => h.filters.push({ table, op, args });

      const b: Record<string, unknown> = {
        select: (_c: string, _o?: unknown) => b,
        eq: (col: string, value: unknown) => {
          record('eq', [col, value]);
          preds.push((r) => r[col] === value);
          return b;
        },
        in: (col: string, values: unknown[]) => {
          record('in', [col, values]);
          preds.push((r) => values.includes(r[col]));
          return b;
        },
        is: (col: string, value: unknown) => {
          preds.push((r) => (r[col] ?? null) === value);
          return b;
        },
        gte: (col: string, value: string) => {
          record('gte', [col, value]);
          preds.push((r) => String(r[col]) >= value);
          return b;
        },
        lt: (col: string, value: string) => {
          record('lt', [col, value]);
          preds.push((r) => String(r[col]) < value);
          return b;
        },
        order: () => b,
        limit: () => b,
        range: (fromIndex: number, toIndex: number) => {
          range = { from: fromIndex, to: toIndex };
          return b;
        },
        then: (resolve: (r: unknown) => unknown) => {
          const all = (h.rows[table] ?? []).filter((r) => preds.every((p) => p(r)));
          const width = Math.min(range.to - range.from + 1, h.serverCap);
          h.requests.push({ table, from: range.from, to: range.to });
          return resolve({
            data: all.slice(range.from, range.from + width),
            error: null,
            count: all.length,
          });
        },
      };
      return b;
    },
  }),
}));

import { getRestaurantReport, resolveRange } from './service';
import type { TenantContext } from '@/modules/core/tenancy/context';

const ctx = {
  organizationId: 'org-1',
  branchId: 'br-1',
  timezone: 'Africa/Cairo',
  permissions: new Set(['payment.read', 'treasury.read']),
} as unknown as TenantContext;

vi.mock('@/modules/core/tenancy/context', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '@/modules/core/tenancy/context',
  );
  return {
    ...actual,
    can: (c: { permissions?: Set<string> }, key: string) => c.permissions?.has(key) ?? false,
  };
});

const range = {
  start: new Date('2026-09-19T21:00:00.000Z'),
  end: new Date('2026-09-20T21:00:00.000Z'),
};

/** `n` completed payments of 100 piastres each, inside the range. */
function payments(n: number, opts?: { organizationId?: string; branchId?: string }) {
  return Array.from({ length: n }, (_, i) => ({
    id: `p-${String(i).padStart(5, '0')}`,
    organization_id: opts?.organizationId ?? 'org-1',
    branch_id: opts?.branchId ?? 'br-1',
    status: 'completed',
    amount_cents: 100,
    method: 'cash',
    created_by: 'u-1',
    invoice_id: `inv-${i}`,
    created_at: '2026-09-20T10:00:00.000Z',
  }));
}

function orders(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `o-${String(i).padStart(5, '0')}`,
    organization_id: 'org-1',
    branch_id: 'br-1',
    status: 'served',
    total_cents: 100,
    discount_cents: 5,
    invoice_id: `inv-${i}`,
    placed_at: '2026-09-20T10:00:00.000Z',
  }));
}

beforeEach(() => {
  h.rows = {};
  h.filters = [];
  h.requests = [];
  h.serverCap = 3;
});

describe('getRestaurantReport completeness', () => {
  it('sums every payment in a large result set, not just the first page', async () => {
    h.rows.payments = payments(250);
    h.rows.restaurant_orders = [];
    h.rows.profiles = [{ id: 'u-1', full_name: 'أمين' }];

    const report = await getRestaurantReport(ctx, range);

    // 250 × 100. A single capped page would have reported 300.
    expect(report.revenueCents).toBe(25_000);
    expect(report.paidOrders).toBe(250);
  });

  it('counts each row exactly once across page boundaries', async () => {
    h.rows.payments = payments(250);
    h.rows.restaurant_orders = [];
    h.rows.profiles = [{ id: 'u-1', full_name: 'أمين' }];

    const report = await getRestaurantReport(ctx, range);
    const byMethod = report.byPaymentMethod.reduce((s, m) => s + m.amountCents, 0);
    // Double-counted pages would make these disagree with the total.
    expect(byMethod).toBe(report.revenueCents);
    expect(report.byCashier.reduce((s, c) => s + c.count, 0)).toBe(250);
  });

  it('pages order lines through a chunked .in() without duplicating them', async () => {
    h.rows.restaurant_orders = orders(300);
    h.rows.payments = [];
    h.rows.restaurant_order_items = h.rows.restaurant_orders.map((o, i) => ({
      id: `i-${String(i).padStart(5, '0')}`,
      order_id: o.id,
      product_name: 'لاتيه',
      quantity: 1,
      line_total_cents: 100,
    }));

    const report = await getRestaurantReport(ctx, range);
    // One product, one line per order, counted once each.
    expect(report.topProducts).toHaveLength(1);
    expect(report.topProducts[0]?.quantity).toBe(300);
    expect(report.topProducts[0]?.amountCents).toBe(30_000);
  });

  it('returns zeroes for an empty range rather than failing', async () => {
    h.rows.payments = [];
    h.rows.restaurant_orders = [];
    h.rows.treasury_transactions = [];

    const report = await getRestaurantReport(ctx, range);
    expect(report.revenueCents).toBe(0);
    expect(report.paidOrders).toBe(0);
    expect(report.openOrders).toBe(0);
    expect(report.topProducts).toEqual([]);
    expect(report.averageOrderCents).toBe(0);
  });

  it('asks for the range boundaries as half-open absolute instants', async () => {
    h.rows.payments = [];
    h.rows.restaurant_orders = [];

    await getRestaurantReport(ctx, range);

    const gte = h.filters.filter((f) => f.op === 'gte');
    const lt = h.filters.filter((f) => f.op === 'lt');
    expect(gte.length).toBeGreaterThan(0);
    for (const f of gte) expect(f.args[1]).toBe('2026-09-19T21:00:00.000Z');
    for (const f of lt) expect(f.args[1]).toBe('2026-09-20T21:00:00.000Z');
  });

  it('excludes rows outside the window even when the table holds them', async () => {
    h.rows.restaurant_orders = [];
    h.rows.payments = [
      ...payments(5),
      // 20:59:59 UTC is 23:59 in Cairo on the 20th — inside.
      { ...payments(1)[0], id: 'p-edge-in', created_at: '2026-09-20T20:59:59.999Z' },
      // 21:00:00 UTC is midnight on the 21st — outside, exclusive end.
      { ...payments(1)[0], id: 'p-edge-out', created_at: '2026-09-20T21:00:00.000Z' },
      // Before the window opens.
      { ...payments(1)[0], id: 'p-early', created_at: '2026-09-19T20:59:59.999Z' },
    ];
    h.rows.profiles = [{ id: 'u-1', full_name: 'أمين' }];

    const report = await getRestaurantReport(ctx, range);
    expect(report.revenueCents).toBe(600);
  });

  it('never aggregates another tenant or branch, however many pages it reads', async () => {
    h.rows.restaurant_orders = [];
    h.rows.payments = [
      ...payments(150),
      ...payments(150, { organizationId: 'org-2' }),
      ...payments(150, { branchId: 'br-2' }),
    ];
    h.rows.profiles = [{ id: 'u-1', full_name: 'أمين' }];

    const report = await getRestaurantReport(ctx, range);
    expect(report.revenueCents).toBe(15_000);

    // And the filters are on the query, not applied after the fact.
    const payFilters = h.filters.filter((f) => f.table === 'payments' && f.op === 'eq');
    expect(payFilters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ args: ['organization_id', 'org-1'] }),
        expect.objectContaining({ args: ['branch_id', 'br-1'] }),
      ]),
    );
  });

  it('keeps paging when the server hands back fewer rows than requested', async () => {
    // The cap is a deployment setting this repository cannot see. A page
    // shorter than the one asked for must not be read as end-of-data.
    h.serverCap = 1;
    h.rows.payments = payments(40);
    h.rows.restaurant_orders = [];
    h.rows.profiles = [{ id: 'u-1', full_name: 'أمين' }];

    const report = await getRestaurantReport(ctx, range);
    expect(report.revenueCents).toBe(4_000);
    expect(h.requests.filter((r) => r.table === 'payments').length).toBe(40);
  });

  // The server cap is the exact place an off-by-one hides: a total that lands
  // on the boundary, and one that lands a single row past it.
  it.each([
    ['exactly at the server cap', 100, 100],
    ['one row above the server cap', 101, 100],
    ['twice the cap plus one', 201, 100],
  ])('sums a result %s', async (_label, total, cap) => {
    h.serverCap = cap;
    h.rows.payments = payments(total);
    h.rows.restaurant_orders = [];
    h.rows.profiles = [{ id: 'u-1', full_name: 'أمين' }];

    const report = await getRestaurantReport(ctx, range);
    expect(report.revenueCents).toBe(total * 100);
    expect(report.paidOrders).toBe(total);
  });

  it('reports the same total however the pages fall', async () => {
    h.rows.restaurant_orders = [];
    h.rows.profiles = [{ id: 'u-1', full_name: 'أمين' }];
    const totals: number[] = [];
    for (const cap of [1, 3, 17, 500]) {
      h.serverCap = cap;
      h.rows.payments = payments(120);
      totals.push((await getRestaurantReport(ctx, range)).revenueCents);
    }
    expect(new Set(totals)).toEqual(new Set([12_000]));
  });

  it('skips the sections the caller has no permission for', async () => {
    h.rows.payments = payments(10);
    h.rows.restaurant_orders = [];
    h.rows.treasury_transactions = [
      {
        id: 't-1',
        organization_id: 'org-1',
        branch_id: 'br-1',
        direction: 'out',
        amount_cents: 500,
        category: null,
        occurred_at: '2026-09-20T10:00:00.000Z',
      },
    ];

    const blind = { ...ctx, permissions: new Set<string>() } as unknown as TenantContext;
    const report = await getRestaurantReport(blind, range);
    expect(report.revenueCents).toBe(0);
    expect(report.expensesCents).toBe(0);
    expect(h.filters.some((f) => f.table === 'payments')).toBe(false);
  });

  it('uses the organization timezone for the window it then scans', async () => {
    h.rows.payments = [];
    h.rows.restaurant_orders = [];

    // Not a timezone test — that lives in range.test.ts — but a check that the
    // corrected boundaries are the ones the queries actually receive.
    const cairo = resolveRange('today', undefined, undefined, 'Africa/Cairo');
    await getRestaurantReport(ctx, cairo);
    const gte = h.filters.find((f) => f.op === 'gte');
    expect(gte?.args[1]).toBe(cairo.start.toISOString());
  });
});
