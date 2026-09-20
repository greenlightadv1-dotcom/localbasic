import { describe, expect, it, vi } from 'vitest';

// The service imports the Supabase client at module level, which validates the
// client environment. resolveRange() itself touches neither.
// `cache()` exists only in React's react-server build. Same stand-in as
// src/modules/core/tenancy/context.test.ts and the kitchen tests.
vi.mock('react', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('react')),
  cache: <T>(fn: T) => fn,
}));

vi.mock('@/lib/env', () => ({
  clientEnv: {
    NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key-that-is-long-enough',
    NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
    NEXT_PUBLIC_APP_NAME: 'LocalBasic',
  },
  serverEnv: () => ({}),
}));

import { resolveRange } from './service';

/**
 * resolveRange() takes two strings straight from the query string, so both can
 * be nonsense. An Invalid Date used to survive into getRestaurantReport(),
 * where toISOString() threw RangeError and broke the page — a malformed link
 * was enough to do it.
 */
const valid = (d: Date) => !Number.isNaN(d.getTime());

describe('resolveRange', () => {
  it('resolves the preset ranges to a usable window', () => {
    for (const key of ['today', 'yesterday', 'week', 'month'] as const) {
      const { start, end } = resolveRange(key);
      expect(valid(start), key).toBe(true);
      expect(valid(end), key).toBe(true);
      expect(start.getTime(), key).toBeLessThan(end.getTime());
    }
  });

  it('honours a well-formed custom range', () => {
    const { start, end } = resolveRange('custom', '2026-03-01', '2026-03-31');
    expect(start.toISOString().slice(0, 10)).toBe('2026-03-01');
    // The end is exclusive: the day after the last day requested.
    expect(end.toISOString().slice(0, 10)).toBe('2026-04-01');
  });

  // The defect. Each of these produced an Invalid Date.
  it('never returns an invalid date for malformed input', () => {
    const bad = ['abc', '', '   ', 'null', '2026-13-45', "' OR 1=1--", '99999999999999999999'];
    for (const from of bad) {
      for (const to of bad) {
        const { start, end } = resolveRange('custom', from, to);
        expect(valid(start), `from=${from} to=${to}`).toBe(true);
        expect(valid(end), `from=${from} to=${to}`).toBe(true);
        // The real regression: this is what the report does with the range.
        expect(() => start.toISOString()).not.toThrow();
        expect(() => end.toISOString()).not.toThrow();
      }
    }
  });

  // Applying only the half that parsed would invent a range nobody asked for:
  // a bad `from` with a good `to` would report from today back to some date
  // months earlier. The default window stands instead.
  it('ignores a half-malformed custom range rather than inventing one', () => {
    const today = resolveRange('today');
    for (const [from, to] of [
      ['abc', '2026-03-31'],
      ['2026-03-01', 'abc'],
    ] as const) {
      const { start, end } = resolveRange('custom', from, to);
      expect(valid(start)).toBe(true);
      expect(valid(end)).toBe(true);
      expect(start.toISOString()).toBe(today.start.toISOString());
      expect(end.toISOString()).toBe(today.end.toISOString());
    }
  });

  // A backwards range returns nothing, which reads as "no sales" rather than
  // "you typed the dates the wrong way round".
  it('swaps a backwards range instead of returning an empty window', () => {
    const { start, end } = resolveRange('custom', '2026-03-31', '2026-03-01');
    expect(start.getTime()).toBeLessThan(end.getTime());
  });
});
