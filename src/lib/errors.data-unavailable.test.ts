import { describe, expect, it, vi } from 'vitest';
import { DataUnavailableError, toDataUnavailable } from './errors';

describe('toDataUnavailable', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});

  it.each(['42883', '42P01', 'PGRST202', 'PGRST205'])('treats %s as an unapplied migration', (code) => {
    const e = toDataUnavailable({ code }, 'test');
    expect(e).toBeInstanceOf(DataUnavailableError);
    expect(e.reason).toBe('missing_migration');
  });

  it('maps permission refusals', () => {
    expect(toDataUnavailable({ code: '42501' }, 'test').reason).toBe('denied');
  });

  it('falls back to a plain failure without leaking the raw message', () => {
    const e = toDataUnavailable({ code: 'XX000', message: 'secret SQL detail' }, 'test');
    expect(e.reason).toBe('failed');
    expect(e.message).not.toContain('secret');
  });
});
