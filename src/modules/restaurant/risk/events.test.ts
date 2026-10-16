import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RISK_EVENTS, RISK_EVENT_POINTS, RISK_FLAG_THRESHOLD } from './events';

/** The screens explain scores with these numbers; they must be the database's own (0108). */
const sql = readFileSync(join(process.cwd(), 'supabase/migrations/0108_cashier_fraud_prevention.sql'), 'utf8');

describe('risk weights mirror the migration', () => {
  it.each(RISK_EVENTS)('%s', (event) => {
    const m = new RegExp(`when '${event}' then (\\d+)`).exec(sql);
    expect(m, `weight for ${event} in app.risk_event_points`).not.toBeNull();
    expect(Number(m![1])).toBe(RISK_EVENT_POINTS[event]);
  });
  it('flag threshold', () => {
    expect(sql).toMatch(new RegExp(`risk_flag_threshold\\(\\)\\s+returns int[^$]*\\$\\$ select ${RISK_FLAG_THRESHOLD} \\$\\$`));
  });
});
