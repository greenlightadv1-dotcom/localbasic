import { describe, expect, it } from 'vitest';
import { LocalQuery } from './query';

/**
 * The local adapter has to implement whatever the services call, or the app
 * simply throws under LOCALBASIC_LOCAL_DB=1.
 *
 * This test exists because it did. Report pagination added `.range()` to every
 * report query, `LocalQuery` had no such method, and every report page died
 * with "…order(…).range is not a function". Nothing caught it: the unit tests
 * use a fake client, and the Playwright suites that were run never load a
 * report. A missing method is a one-line assertion — so it is asserted.
 */

const BUILDER_METHODS = [
  'select',
  'insert',
  'update',
  'upsert',
  'delete',
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'like',
  'ilike',
  'in',
  'is',
  'or',
  'order',
  'limit',
  'range',
  'single',
  'maybeSingle',
  'then',
] as const;

describe('LocalQuery builder surface', () => {
  const q = () => new LocalQuery('payments', null) as unknown as Record<string, unknown>;

  it.each(BUILDER_METHODS)('implements .%s()', (method) => {
    expect(typeof q()[method]).toBe('function');
  });

  it('chains the way a report query does, ending in .range()', () => {
    const query = new LocalQuery('payments', null);
    // Exactly the shape src/modules/restaurant/reports/service.ts builds.
    expect(() =>
      query
        .select('amount_cents, method, created_by, invoice_id', { count: 'exact' })
        .eq('organization_id', 'org-1')
        .eq('branch_id', 'br-1')
        .eq('status', 'completed')
        .gte('created_at', '2026-09-19T21:00:00.000Z')
        .lt('created_at', '2026-09-20T21:00:00.000Z')
        .order('id', { ascending: true })
        .range(0, 999),
    ).not.toThrow();
  });

  it('returns the builder from .range() so the chain continues', () => {
    const query = new LocalQuery('payments', null);
    expect(query.range(0, 999)).toBe(query);
  });
});
