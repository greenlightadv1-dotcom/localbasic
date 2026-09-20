import { describe, expect, it } from 'vitest';
import {
  calendarDateInZone,
  isValidTimeZone,
  startOfDayInZone,
  startOfDayInZoneOffset,
  startOfMonthInZone,
} from './time';

/**
 * These assert absolute instants, not "it did not throw".
 *
 * Every expectation below is the UTC instant at which local midnight actually
 * occurs, worked out from the zone's real offset on that date — including the
 * days when the offset changes.
 */
describe('startOfDayInZone', () => {
  // Cairo is UTC+2 in winter, UTC+3 under daylight saving.
  it('resolves Cairo local midnight to the right UTC instant', () => {
    // 15 January 2026: UTC+2, so midnight local is 22:00 the day before.
    expect(startOfDayInZone(new Date('2026-01-15T09:00:00Z'), 'Africa/Cairo').toISOString())
      .toBe('2026-01-14T22:00:00.000Z');

    // 15 July 2026: UTC+3, so midnight local is 21:00 the day before.
    expect(startOfDayInZone(new Date('2026-07-15T09:00:00Z'), 'Africa/Cairo').toISOString())
      .toBe('2026-07-14T21:00:00.000Z');
  });

  it('is the identity for UTC', () => {
    expect(startOfDayInZone(new Date('2026-09-20T13:45:12Z'), 'UTC').toISOString())
      .toBe('2026-09-20T00:00:00.000Z');
  });

  it('resolves New York local midnight', () => {
    // EST, UTC-5.
    expect(startOfDayInZone(new Date('2026-01-15T18:00:00Z'), 'America/New_York').toISOString())
      .toBe('2026-01-15T05:00:00.000Z');
    // EDT, UTC-4.
    expect(startOfDayInZone(new Date('2026-07-15T18:00:00Z'), 'America/New_York').toISOString())
      .toBe('2026-07-15T04:00:00.000Z');
  });

  it('resolves Berlin local midnight', () => {
    // CET, UTC+1.
    expect(startOfDayInZone(new Date('2026-01-15T09:00:00Z'), 'Europe/Berlin').toISOString())
      .toBe('2026-01-14T23:00:00.000Z');
    // CEST, UTC+2.
    expect(startOfDayInZone(new Date('2026-07-15T09:00:00Z'), 'Europe/Berlin').toISOString())
      .toBe('2026-07-14T22:00:00.000Z');
  });

  // An instant a few minutes into the local day must resolve to that day's
  // midnight, not the previous one. This is the case UTC arithmetic gets wrong:
  // 00:30 in Cairo is still 22:30 UTC on the day before.
  it('keeps the local day for an instant just after local midnight', () => {
    const justAfterCairoMidnight = new Date('2026-01-14T22:30:00Z'); // 00:30 Cairo, 15 Jan
    expect(calendarDateInZone(justAfterCairoMidnight, 'Africa/Cairo')).toBe('2026-01-15');
    expect(startOfDayInZone(justAfterCairoMidnight, 'Africa/Cairo').toISOString())
      .toBe('2026-01-14T22:00:00.000Z');
  });
});

describe('DST transitions', () => {
  // Berlin springs forward on 29 March 2026 at 02:00 local (01:00 UTC).
  it('handles the spring-forward day in Berlin', () => {
    const duringTransitionDay = new Date('2026-03-29T12:00:00Z');
    // Midnight that day is still CET (UTC+1), i.e. 23:00 the previous day.
    expect(startOfDayInZone(duringTransitionDay, 'Europe/Berlin').toISOString())
      .toBe('2026-03-28T23:00:00.000Z');
    // The NEXT day begins under CEST (UTC+2), i.e. 22:00.
    expect(startOfDayInZoneOffset(duringTransitionDay, 'Europe/Berlin', 1).toISOString())
      .toBe('2026-03-29T22:00:00.000Z');
  });

  // The short day is 23 hours long, not 24. Stepping by calendar day must not
  // drift, which is what adding 86_400_000 milliseconds would do.
  it('treats the short DST day as one calendar day, not 24 hours', () => {
    const day = startOfDayInZone(new Date('2026-03-29T12:00:00Z'), 'Europe/Berlin');
    const next = startOfDayInZoneOffset(new Date('2026-03-29T12:00:00Z'), 'Europe/Berlin', 1);
    expect(next.getTime() - day.getTime()).toBe(23 * 60 * 60 * 1000);
  });

  // Berlin falls back on 25 October 2026: that local day is 25 hours long.
  it('treats the long DST day as one calendar day', () => {
    const day = startOfDayInZone(new Date('2026-10-25T12:00:00Z'), 'Europe/Berlin');
    const next = startOfDayInZoneOffset(new Date('2026-10-25T12:00:00Z'), 'Europe/Berlin', 1);
    expect(next.getTime() - day.getTime()).toBe(25 * 60 * 60 * 1000);
  });

  // Cairo's DST change happens AT midnight: on 24 April 2026 the clock jumps
  // 00:00 -> 01:00, so local midnight never occurs. A single-pass conversion
  // answers 21:00Z, an hour before the day actually begins. This is the case
  // the refinement pass exists for, and it is the product's home timezone.
  it('handles a transition that happens at midnight (Africa/Cairo)', () => {
    const onTransitionDay = new Date('2026-04-24T09:00:00Z');
    expect(startOfDayInZone(onTransitionDay, 'Africa/Cairo').toISOString())
      .toBe('2026-04-23T22:00:00.000Z');

    // The day before is a normal UTC+2 day starting at 22:00Z.
    expect(startOfDayInZoneOffset(onTransitionDay, 'Africa/Cairo', -1).toISOString())
      .toBe('2026-04-22T22:00:00.000Z');

    // Which makes the transition day 23 hours long.
    const day = startOfDayInZone(onTransitionDay, 'Africa/Cairo');
    const next = startOfDayInZoneOffset(onTransitionDay, 'Africa/Cairo', 1);
    expect(next.getTime() - day.getTime()).toBe(23 * 60 * 60 * 1000);
  });

  // New York falls back on 1 November 2026.
  it('handles the fall-back day in New York', () => {
    const day = startOfDayInZone(new Date('2026-11-01T12:00:00Z'), 'America/New_York');
    expect(day.toISOString()).toBe('2026-11-01T04:00:00.000Z'); // still EDT at midnight
    const next = startOfDayInZoneOffset(new Date('2026-11-01T12:00:00Z'), 'America/New_York', 1);
    expect(next.getTime() - day.getTime()).toBe(25 * 60 * 60 * 1000);
  });
});

describe('calendar stepping', () => {
  it('crosses month and year boundaries', () => {
    const jan1 = new Date('2026-01-01T09:00:00Z');
    expect(calendarDateInZone(startOfDayInZoneOffset(jan1, 'UTC', -1), 'UTC')).toBe('2025-12-31');
    const jan31 = new Date('2026-01-31T09:00:00Z');
    expect(calendarDateInZone(startOfDayInZoneOffset(jan31, 'UTC', 1), 'UTC')).toBe('2026-02-01');
  });

  it('finds the first of the month in the zone', () => {
    expect(startOfMonthInZone(new Date('2026-07-15T09:00:00Z'), 'Africa/Cairo').toISOString())
      .toBe('2026-06-30T21:00:00.000Z'); // 1 July 00:00 Cairo, UTC+3
    expect(startOfMonthInZone(new Date('2026-01-15T09:00:00Z'), 'Europe/Berlin').toISOString())
      .toBe('2025-12-31T23:00:00.000Z'); // 1 Jan 00:00 Berlin, UTC+1
  });
});

describe('isValidTimeZone', () => {
  it('accepts real zones and rejects nonsense', () => {
    for (const z of ['UTC', 'Africa/Cairo', 'America/New_York', 'Europe/Berlin']) {
      expect(isValidTimeZone(z), z).toBe(true);
    }
    for (const z of ['Mars/Olympus', '', 'Not/AZone', 'Africa/Cairo; drop table']) {
      expect(isValidTimeZone(z), z).toBe(false);
    }
  });
});
