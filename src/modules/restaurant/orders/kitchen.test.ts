import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The kitchen must not receive financial information.
 *
 * The board renders none, but a React Server Component payload is readable in
 * the browser, so "not rendered" was never the same as "not sent". Before this,
 * every ticket arrived carrying unit prices, line totals, the order total and
 * the invoice id, because the page built tickets from getOrder().
 *
 * These tests assert the property at both ends: the queries must not ASK for a
 * price column, and the returned tickets must not CONTAIN one.
 */

const h = vi.hoisted(() => {
  const selects: { table: string; columns: string }[] = [];
  const rows: Record<string, unknown[]> = {
    restaurant_orders: [
      {
        id: 'o1',
        number: 'R-001',
        status: 'confirmed',
        table_id: 't1',
        note: 'بدون بصل',
        placed_at: '2026-09-20T10:00:00Z',
      },
    ],
    restaurant_order_items: [
      {
        id: 'i1',
        order_id: 'o1',
        product_name: 'لاتيه',
        variant_name: 'كبير',
        quantity: 2,
        note: null,
      },
    ],
    restaurant_order_item_modifiers: [{ order_item_id: 'i1', name: 'شوت إضافي' }],
    restaurant_tables: [{ id: 't1', name: 'T1' }],
  };
  return { selects, rows };
});

vi.mock('react', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('react')),
  cache: <T>(fn: T) => fn,
}));

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {
        select: (columns: string) => {
          h.selects.push({ table, columns });
          return b;
        },
        eq: () => b,
        in: () => b,
        order: () => b,
        limit: () => b,
        then: (resolve: (r: unknown) => unknown) =>
          resolve({ data: h.rows[table] ?? [], error: null }),
      };
      return b;
    },
  }),
}));

import { listKitchenTickets } from './service';
import type { TenantContext } from '@/modules/core/tenancy/context';

const ctx = {
  organizationId: 'org-1',
  branchId: 'br-1',
} as unknown as TenantContext;

/** Every key anywhere in the structure. */
function deepKeys(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const v of value) deepKeys(v, found);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      found.push(k);
      deepKeys(v, found);
    }
  }
  return found;
}

const MONEY = /cents|price|total|paid|invoice|discount|tax|amount/i;

beforeEach(() => {
  h.selects.length = 0;
});

describe('listKitchenTickets', () => {
  it('returns the ticket the board needs', async () => {
    const tickets = await listKitchenTickets(ctx);
    expect(tickets).toHaveLength(1);
    expect(tickets[0]!.summary.number).toBe('R-001');
    expect(tickets[0]!.summary.tableName).toBe('T1');
    expect(tickets[0]!.lines[0]!.productName).toBe('لاتيه');
    expect(tickets[0]!.lines[0]!.quantity).toBe(2);
    expect(tickets[0]!.lines[0]!.modifiers).toEqual([{ name: 'شوت إضافي' }]);
  });

  // The payload assertion. A ticket carrying totalCents would pass every visual
  // check and still be readable in DevTools on the kitchen tablet.
  it('carries no financial field anywhere in the payload', async () => {
    const tickets = await listKitchenTickets(ctx);
    const offending = deepKeys(tickets).filter((k) => MONEY.test(k));
    expect(offending).toEqual([]);
  });

  // Stronger: the money is never fetched, so it cannot be dropped by mistake.
  it('never asks the database for a price column', async () => {
    await listKitchenTickets(ctx);
    const offending = h.selects.filter((s) => MONEY.test(s.columns));
    expect(offending).toEqual([]);
  });

  // The N+1 this replaced issued about five queries per ticket, every twenty
  // seconds, from every tablet. This must stay flat.
  it('issues a fixed number of queries regardless of ticket count', async () => {
    await listKitchenTickets(ctx);
    const oneTicket = h.selects.length;

    h.selects.length = 0;
    h.rows.restaurant_orders = Array.from({ length: 40 }, (_, i) => ({
      id: `o${i}`,
      number: `R-${i}`,
      status: 'confirmed',
      table_id: 't1',
      note: null,
      placed_at: '2026-09-20T10:00:00Z',
    }));
    await listKitchenTickets(ctx);

    expect(h.selects.length).toBe(oneTicket);
    expect(h.selects.length).toBeLessThanOrEqual(4);
  });

  it('returns nothing without querying further when the board is empty', async () => {
    h.rows.restaurant_orders = [];
    await expect(listKitchenTickets(ctx)).resolves.toEqual([]);
    expect(h.selects).toHaveLength(1);
  });
});

// The chef and barista screens (0080) each lock to one station kind, applied
// after the same four queries above — no separate query path to drift from.
describe('listKitchenTickets station filter', () => {
  beforeEach(() => {
    h.rows.restaurant_orders = [
      {
        id: 'o1', number: 'R-001', status: 'confirmed', table_id: 't1',
        note: null, placed_at: '2026-09-20T10:00:00Z',
      },
      {
        id: 'o2', number: 'R-002', status: 'confirmed', table_id: 't1',
        note: null, placed_at: '2026-09-20T10:01:00Z',
      },
    ];
    h.rows.restaurant_order_items = [
      {
        id: 'i1', order_id: 'o1', product_name: 'لاتيه', variant_name: 'default',
        quantity: 1, note: null, station_id: null, station_kind: 'bar',
      },
      {
        id: 'i2', order_id: 'o1', product_name: 'برجر', variant_name: 'default',
        quantity: 1, note: null, station_id: null, station_kind: 'kitchen',
      },
      {
        id: 'i3', order_id: 'o2', product_name: 'شاي', variant_name: 'default',
        quantity: 1, note: null, station_id: null, station_kind: 'bar',
      },
    ];
    h.rows.restaurant_order_item_modifiers = [];
  });

  it('keeps only lines of the requested kind, and drops a ticket with none of them', async () => {
    const barTickets = await listKitchenTickets(ctx, undefined, 'bar');
    expect(barTickets.map((t) => t.summary.id).sort()).toEqual(['o1', 'o2']);
    const o1 = barTickets.find((t) => t.summary.id === 'o1')!;
    expect(o1.lines.map((l) => l.productName)).toEqual(['لاتيه']);

    // o2 has no kitchen line at all, so the whole ticket drops out — a chef
    // should never see an empty card for someone else's drink order.
    const kitchenTickets = await listKitchenTickets(ctx, undefined, 'kitchen');
    expect(kitchenTickets.map((t) => t.summary.id)).toEqual(['o1']);
    expect(kitchenTickets[0]!.lines.map((l) => l.productName)).toEqual(['برجر']);
  });

  it('keeps every line, from both stations, when no kind is requested', async () => {
    const tickets = await listKitchenTickets(ctx);
    const lineCount = tickets.reduce((n, t) => n + t.lines.length, 0);
    expect(lineCount).toBe(3);
  });
});
