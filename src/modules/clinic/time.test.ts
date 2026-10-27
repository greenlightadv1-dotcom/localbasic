import { describe, expect, it } from 'vitest';
import { addDays, fromLocal, hmToMinutes, isLocalDate, minutesToHm, toLocal, weekStart, weekdayOf } from './time';

describe('clinic time', () => {
  it('round-trips local wall-clock time through the organization zone', () => {
    // Cairo is UTC+2 in winter and UTC+3 in summer (DST since 2023).
    const winter = fromLocal('2026-01-15', 10 * 60, 'Africa/Cairo');
    expect(winter.toISOString()).toBe('2026-01-15T08:00:00.000Z');
    const summer = fromLocal('2026-07-15', 10 * 60, 'Africa/Cairo');
    expect(summer.toISOString()).toBe('2026-07-15T07:00:00.000Z');
    expect(toLocal(summer, 'Africa/Cairo')).toEqual({ date: '2026-07-15', minutes: 600 });
  });

  it('handles a local midnight that is the previous UTC day', () => {
    const t = fromLocal('2026-03-01', 0, 'Africa/Cairo');
    expect(toLocal(t, 'Africa/Cairo').date).toBe('2026-03-01');
    expect(toLocal(t, 'UTC').date).toBe('2026-02-28');
  });

  it('does calendar arithmetic on local dates', () => {
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(weekdayOf('2026-10-31')).toBe(6); // Saturday
    expect(weekStart('2026-11-05')).toBe('2026-10-31'); // Thursday → that Saturday
    expect(weekStart('2026-10-31')).toBe('2026-10-31');
    expect(isLocalDate('2026-02-30')).toBe(false);
    expect(isLocalDate('2026-02-28')).toBe(true);
  });

  it('converts HH:MM', () => {
    expect(hmToMinutes('09:30')).toBe(570);
    expect(minutesToHm(570)).toBe('09:30');
  });
});
