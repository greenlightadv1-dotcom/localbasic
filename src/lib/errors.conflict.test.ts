import { describe, expect, it, vi } from 'vitest';
import { staffDbError } from './errors';

describe('staffDbError LB409', () => {
  it('turns a slot conflict into a conflict error with the database reason', () => {
    const e = staffDbError({ code: 'LB409', message: 'الطبيب لديه موعد آخر في هذا الوقت' }, 'test');
    expect(e.code).toBe('conflict');
    expect(e.message).toBe('الطبيب لديه موعد آخر في هذا الوقت');
  });

  it('never leaks a technical message', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const e = staffDbError({ code: 'LB409', message: 'duplicate key value violates constraint' }, 'test');
    expect(e.code).toBe('conflict');
    expect(e.message).toBe('هذا الموعد محجوز بالفعل.');
  });
});
