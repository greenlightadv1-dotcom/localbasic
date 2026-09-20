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

/** What a zone's clock reads at an instant, as YYYY-MM-DD HH:mm. */
function wall(instant: Date, timeZone: string): string {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(instant)) if (part.type !== 'literal') p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day} ${p.hour === '24' ? '00' : p.hour}:${p.minute}`;
}

const ZONES = ['Africa/Cairo', 'UTC', 'America/New_York', 'Europe/Berlin'];

describe('resolveRange in the organization timezone', () => {
  // The defect: "today" used to run 00:00 UTC to 00:00 UTC, which for Cairo is
  // 02:00/03:00 local. These assert the local clock reads midnight exactly.
  it.each(ZONES)('today is local midnight to local midnight in %s', (zone) => {
    const { start, end } = resolveRange('today', undefined, undefined, zone);
    expect(wall(start, zone).slice(-5), `${zone} start`).toBe('00:00');
    expect(wall(end, zone).slice(-5), `${zone} end`).toBe('00:00');
    // Exactly one calendar day apart: 23, 24 or 25 hours depending on DST.
    const hours = (end.getTime() - start.getTime()) / 3_600_000;
    expect([23, 24, 25], `${zone} span ${hours}h`).toContain(hours);
  });

  it.each(ZONES)('yesterday ends exactly where today begins in %s', (zone) => {
    const today = resolveRange('today', undefined, undefined, zone);
    const yesterday = resolveRange('yesterday', undefined, undefined, zone);
    expect(yesterday.end.toISOString()).toBe(today.start.toISOString());
    expect(wall(yesterday.start, zone).slice(-5)).toBe('00:00');
  });

  it.each(ZONES)('this week covers seven calendar days ending tonight in %s', (zone) => {
    const today = resolveRange('today', undefined, undefined, zone);
    const week = resolveRange('week', undefined, undefined, zone);
    expect(week.end.toISOString()).toBe(today.end.toISOString());
    expect(wall(week.start, zone).slice(-5)).toBe('00:00');
    const days = (week.end.getTime() - week.start.getTime()) / 3_600_000 / 24;
    // Seven days, give or take the hour a DST change adds or removes.
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
  });

  it.each(ZONES)('this month starts on the 1st at local midnight in %s', (zone) => {
    const { start } = resolveRange('month', undefined, undefined, zone);
    expect(wall(start, zone).slice(8, 10), `${zone} day-of-month`).toBe('01');
    expect(wall(start, zone).slice(-5), `${zone} time`).toBe('00:00');
  });

  // The concrete case from the audit. Cairo is UTC+3 in September, so local
  // midnight is 21:00 UTC the previous day — NOT 00:00 UTC.
  it('puts Cairo local midnight at the right UTC instant', () => {
    const { start, end } = resolveRange('custom', '2026-09-20', '2026-09-20', 'Africa/Cairo');
    expect(start.toISOString()).toBe('2026-09-19T21:00:00.000Z');
    expect(end.toISOString()).toBe('2026-09-20T21:00:00.000Z');
  });

  it('puts New York local midnight at the right UTC instant', () => {
    // 15 January 2026 is EST, UTC-5.
    const { start, end } = resolveRange('custom', '2026-01-15', '2026-01-15', 'America/New_York');
    expect(start.toISOString()).toBe('2026-01-15T05:00:00.000Z');
    expect(end.toISOString()).toBe('2026-01-16T05:00:00.000Z');
  });

  // Berlin springs forward on 29 March 2026: that local day is 23 hours long.
  it('handles a custom range across a DST transition', () => {
    const { start, end } = resolveRange('custom', '2026-03-29', '2026-03-29', 'Europe/Berlin');
    expect(start.toISOString()).toBe('2026-03-28T23:00:00.000Z');
    expect(end.toISOString()).toBe('2026-03-29T22:00:00.000Z');
    expect((end.getTime() - start.getTime()) / 3_600_000).toBe(23);
  });

  it('defaults to UTC when no zone is given, preserving the old signature', () => {
    const { start } = resolveRange('today');
    expect(wall(start, 'UTC').slice(-5)).toBe('00:00');
  });

  it('falls back to UTC for a zone this runtime cannot name', () => {
    const { start, end } = resolveRange('today', undefined, undefined, 'Mars/Olympus');
    expect(valid(start)).toBe(true);
    expect(wall(start, 'UTC').slice(-5)).toBe('00:00');
    expect(wall(end, 'UTC').slice(-5)).toBe('00:00');
  });
});

describe('resolveRange input handling', () => {
  it('honours a well-formed custom range', () => {
    const { start, end } = resolveRange('custom', '2026-03-01', '2026-03-31', 'UTC');
    expect(start.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    // Exclusive end: the day after the last day requested.
    expect(end.toISOString()).toBe('2026-04-01T00:00:00.000Z');
  });

  it('never returns an invalid date for malformed input', () => {
    const bad = ['abc', '', '   ', 'null', '2026-13-45', "' OR 1=1--", '99999999999999999999'];
    for (const from of bad) {
      for (const to of bad) {
        const { start, end } = resolveRange('custom', from, to, 'Africa/Cairo');
        expect(valid(start), `from=${from} to=${to}`).toBe(true);
        expect(valid(end), `from=${from} to=${to}`).toBe(true);
        expect(() => start.toISOString()).not.toThrow();
        expect(() => end.toISOString()).not.toThrow();
      }
    }
  });

  it('ignores a half-malformed custom range rather than inventing one', () => {
    const today = resolveRange('today', undefined, undefined, 'Africa/Cairo');
    for (const [from, to] of [['abc', '2026-03-31'], ['2026-03-01', 'abc']] as const) {
      const { start, end } = resolveRange('custom', from, to, 'Africa/Cairo');
      expect(start.toISOString()).toBe(today.start.toISOString());
      expect(end.toISOString()).toBe(today.end.toISOString());
    }
  });

  // Found by these tests: new Date('2026-01-15') is UTC midnight, which in any
  // zone behind UTC still belongs to the 14th. A date typed into a report means
  // that calendar date where the business is.
  it.each([
    ['America/New_York', '2026-01-15T05:00:00.000Z', '2026-01-16T05:00:00.000Z'],
    ['Africa/Cairo', '2026-01-14T22:00:00.000Z', '2026-01-15T22:00:00.000Z'],
    ['UTC', '2026-01-15T00:00:00.000Z', '2026-01-16T00:00:00.000Z'],
  ])('reads a bare date as a calendar date in %s', (zone, expectedStart, expectedEnd) => {
    const { start, end } = resolveRange('custom', '2026-01-15', '2026-01-15', zone);
    expect(start.toISOString()).toBe(expectedStart);
    expect(end.toISOString()).toBe(expectedEnd);
  });

  it('refuses a date that does not exist rather than rolling it forward', () => {
    const today = resolveRange('today', undefined, undefined, 'UTC');
    const { start } = resolveRange('custom', '2026-02-30', undefined, 'UTC');
    expect(start.toISOString()).toBe(today.start.toISOString());
  });

  it('swaps a backwards range instead of returning an empty window', () => {
    const { start, end } = resolveRange('custom', '2026-03-31', '2026-03-01', 'UTC');
    expect(start.getTime()).toBeLessThan(end.getTime());
    expect(start.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-04-01T00:00:00.000Z');
  });
});
