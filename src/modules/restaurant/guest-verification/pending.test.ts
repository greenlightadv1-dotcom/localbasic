import { describe, expect, it } from 'vitest';
import {
  clearPending, decide, isExpired, loadPending, MAX_PENDING_AGE_MS, nextPollDelay,
  POLL_MS, savePending, SLOW_POLL_MS, type StorageLike,
} from './pending';

function memory(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

const TOKEN = 'AbC123_-xyzXYZ0987654321abcdEFGH';

describe('pending verification storage', () => {
  it('survives a reload: what was saved is restored for the same checkout only', () => {
    const s = memory();
    savePending(s, 'alpha/main', TOKEN, 1_000);
    expect(loadPending(s, 'alpha/main', 2_000)).toBe(TOKEN);
    expect(loadPending(s, 'beta/main', 2_000)).toBeNull();
  });

  it('keeps only the token and a timestamp — no phone, name or code', () => {
    const s = memory();
    savePending(s, 'alpha/main', TOKEN, 1_000);
    expect(JSON.parse([...s.data.values()][0]!)).toEqual({ token: TOKEN, savedAt: 1_000 });
  });

  it('forgets a record that is too old, malformed, or not a real token', () => {
    const s = memory();
    savePending(s, 'a', TOKEN, 0);
    expect(loadPending(s, 'a', MAX_PENDING_AGE_MS + 1)).toBeNull();
    expect(s.data.size).toBe(0);

    s.setItem('lb-pending-verify:b', '{not json');
    expect(loadPending(s, 'b')).toBeNull();
    s.setItem('lb-pending-verify:c', JSON.stringify({ token: '<script>', savedAt: Date.now() }));
    expect(loadPending(s, 'c')).toBeNull();
    s.setItem('lb-pending-verify:d', JSON.stringify({ token: TOKEN, savedAt: Date.now() + 60_000 }));
    expect(loadPending(s, 'd')).toBeNull(); // a timestamp in the future is not trusted
    expect(s.data.size).toBe(0);
  });

  it('refuses to save something that is not a token, and tolerates blocked storage', () => {
    const s = memory();
    savePending(s, 'a', 'short', 0);
    expect(s.data.size).toBe(0);
    const blocked: StorageLike = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => { throw new Error('blocked'); },
    };
    expect(() => savePending(blocked, 'a', TOKEN)).not.toThrow();
    expect(loadPending(blocked, 'a')).toBeNull();
    expect(() => clearPending(blocked, 'a')).not.toThrow();
    expect(loadPending(null, 'a')).toBeNull();
  });
});

describe('decide', () => {
  const info = (status: string, code: string | null = 'MAIN-123456') =>
    ({ ok: true as const, data: { status, code, whatsapp: null, expiresAt: null } });

  it('keeps the sheet while the order waits for WhatsApp', () => {
    expect(decide(info('pending_verification'))).toEqual({ kind: 'pending', code: 'MAIN-123456', expiresAt: null });
  });

  it.each(['new', 'confirmed', 'preparing', 'ready', 'completed', 'cancelled'])(
    'hands over to the status banner once the order is %s',
    (status) => expect(decide(info(status))).toEqual({ kind: 'confirmed' }),
  );

  it('forgets an order the server no longer knows, but keeps it on a passing failure', () => {
    expect(decide({ ok: false, code: 'not_found', error: 'x' })).toEqual({ kind: 'gone' });
    expect(decide({ ok: false, code: 'rate_limited', error: 'slow down' })).toEqual({ kind: 'retry', error: 'slow down' });
    expect(decide({ ok: false, code: 'failed', error: 'oops' })).toEqual({ kind: 'retry', error: 'oops' });
    expect(decide(info('pending_verification', null)).kind).toBe('retry');
  });
});

describe('polling cadence', () => {
  it('polls quickly while the code is valid, slowly after it expires', () => {
    const now = Date.parse('2026-10-14T12:00:00Z');
    expect(nextPollDelay(null, now)).toBe(POLL_MS);
    expect(nextPollDelay('2026-10-14T12:05:00Z', now)).toBe(POLL_MS);
    expect(nextPollDelay('2026-10-14T11:59:00Z', now)).toBe(SLOW_POLL_MS);
    expect(isExpired('not a date', now)).toBe(false);
  });
});
