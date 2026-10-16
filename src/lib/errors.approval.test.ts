import { describe, expect, it } from 'vitest';
import { parseApprovalHint, staffDbError, toAppError } from './errors';

describe('LB403 carries the gate that refused (0108)', () => {
  it('parses action and amount', () => {
    expect(parseApprovalHint('discount.daily_limit:500')).toEqual({ action: 'discount.daily_limit', amount: 500 });
    expect(parseApprovalHint('order.cancel:')).toEqual({ action: 'order.cancel', amount: null });
  });
  it('ignores anything else', () => {
    expect(parseApprovalHint(undefined)).toBeUndefined();
    expect(parseApprovalHint('drop table; --')).toBeUndefined();
    expect(parseApprovalHint('order.discount:12a')).toBeUndefined();
  });
  it('rides on the approval_required error from both mappers', () => {
    const db = { code: 'LB403', message: 'هذا الإجراء يحتاج موافقة المدير', hint: 'refund.daily_limit:1000' };
    expect(staffDbError(db, 't').approval).toEqual({ action: 'refund.daily_limit', amount: 1000 });
    const e = toAppError(db, 't');
    expect(e.code).toBe('approval_required');
    expect(e.approval).toEqual({ action: 'refund.daily_limit', amount: 1000 });
  });
});
