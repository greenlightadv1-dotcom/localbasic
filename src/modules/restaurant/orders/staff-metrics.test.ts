import { describe, expect, it } from 'vitest';
import {
  buildStageRows, computeDurations, formatDuration, monthStartFrom, parsePerformance, shiftMonth,
  type TrailEntry,
} from './staff-metrics';

const T = (min: number) => new Date(Date.UTC(2026, 9, 13, 12, min, 0)).toISOString();

const ORDER = {
  channel: 'waiter',
  placed_at: T(0), confirmed_at: T(1), ready_at: T(11), served_at: T(13), completed_at: T(20),
  cancelled_at: null,
};

const trail = (...entries: [string, string | null, number][]): TrailEntry[] =>
  entries.map(([stage, actorName, min]) => ({ stage, actorId: actorName, actorName, at: T(min) }));

describe('buildStageRows', () => {
  it('names the receiver, the kitchen and the cashier', () => {
    const rows = buildStageRows(ORDER, trail(
      ['created', 'Captain Ali', 0], ['confirmed', 'Cashier Sara', 1],
      ['preparing', 'Chef Omar', 2], ['ready', 'Chef Omar', 11],
      ['served', 'Captain Ali', 13], ['paid', 'Cashier Sara', 19], ['completed', 'Cashier Sara', 20],
    ));
    const by = Object.fromEntries(rows.map((r) => [r.key, r.actorName]));
    expect(by).toEqual({
      receiver: 'Captain Ali', confirmed: 'Cashier Sara', preparing: 'Chef Omar',
      ready: 'Chef Omar', served: 'Captain Ali', cashier: 'Cashier Sara',
    });
    expect(rows[0]!.label).toContain('الكابتن');
  });

  it('takes the cashier from the payment, falling back to completion', () => {
    const rows = buildStageRows(ORDER, trail(['completed', 'Cashier Sara', 20]));
    expect(rows.find((r) => r.key === 'cashier')!.actorName).toBe('Cashier Sara');
  });

  it('explains an unnamed receiver on a guest order instead of leaving a blank', () => {
    const rows = buildStageRows({ channel: 'qr' }, trail(['created', null, 0]));
    expect(rows[0]).toMatchObject({ actorName: null, note: 'العميل (من رمز QR)' });
  });

  it('leaves later stages empty on an order still in progress', () => {
    const rows = buildStageRows(ORDER, trail(['created', 'Captain Ali', 0]));
    expect(rows.filter((r) => r.at).map((r) => r.key)).toEqual(['receiver']);
  });
});

describe('computeDurations', () => {
  it('splits creation → kitchen → settlement', () => {
    const d = computeDurations(ORDER, trail(['preparing', 'Chef Omar', 2]), new Date(T(30)));
    expect(d.waitSeconds).toBe(2 * 60);
    expect(d.prepSeconds).toBe(9 * 60);
    expect(d.handoverSeconds).toBe(9 * 60);
    expect(d.totalSeconds).toBe(20 * 60);
    expect(d.openSeconds).toBeNull();
  });

  it('falls back to the confirmation when there was no separate preparing step', () => {
    const d = computeDurations(ORDER, [], new Date(T(30)));
    expect(d.waitSeconds).toBe(60);
    expect(d.prepSeconds).toBe(10 * 60);
  });

  it('reports elapsed time, not a total, for an open order', () => {
    const open = { ...ORDER, ready_at: null, served_at: null, completed_at: null };
    const d = computeDurations(open, [], new Date(T(7)));
    expect(d.totalSeconds).toBeNull();
    expect(d.openSeconds).toBe(7 * 60);
  });

  it('gives a cancelled order neither a total nor an open timer', () => {
    const d = computeDurations({ ...ORDER, completed_at: null, served_at: null, cancelled_at: T(5) }, [], new Date(T(30)));
    expect(d.totalSeconds).toBeNull();
    expect(d.openSeconds).toBeNull();
  });

  it('never yields a negative duration from clock skew', () => {
    const d = computeDurations({ ...ORDER, ready_at: T(-5) }, [], new Date(T(30)));
    expect(d.prepSeconds).toBeNull();
  });
});

describe('formatDuration', () => {
  it('formats seconds, minutes and hours in Arabic digits', () => {
    expect(formatDuration(45)).toBe('٤٥ ث');
    expect(formatDuration(125)).toBe('٢ د ٥ ث');
    expect(formatDuration(3725)).toBe('١ س ٢ د');
    expect(formatDuration(null)).toBe('—');
  });
});

describe('monthly performance helpers', () => {
  it('parses the RPC payload, including bigint-as-string figures', () => {
    const p = parsePerformance({
      month_start: 'a', month_end: 'b', timezone: 'Africa/Cairo',
      totals: { handled: 13, created: 2, collected_cents: '77000', avg_prep_seconds: 540, prep_outliers: 1 },
      days: [{ day: '2026-10-13', handled: 13, paid: 8 }],
    });
    expect(p.totals.collected_cents).toBe(77000);
    expect(p.totals.avg_prep_seconds).toBe(540);
    expect(p.days[0]).toMatchObject({ day: '2026-10-13', handled: 13, paid: 8, served: 0 });
  });

  it('tolerates an empty payload', () => {
    const p = parsePerformance(null);
    expect(p.totals.handled).toBe(0);
    expect(p.totals.avg_prep_seconds).toBeNull();
    expect(p.days).toEqual([]);
  });

  it('reads the month from the URL, defaulting to the current one', () => {
    expect(monthStartFrom('2026-03')).toBe('2026-03-01');
    expect(monthStartFrom('garbage', new Date(Date.UTC(2026, 9, 13)))).toBe('2026-10-01');
    expect(monthStartFrom(undefined, new Date(Date.UTC(2026, 0, 2)))).toBe('2026-01-01');
    expect(monthStartFrom('2026-13', new Date(Date.UTC(2026, 9, 13)))).toBe('2026-10-01');
  });

  it('steps between months across year boundaries', () => {
    expect(shiftMonth('2026-01-01', -1)).toBe('2025-12');
    expect(shiftMonth('2026-12-01', 1)).toBe('2027-01');
  });
});
