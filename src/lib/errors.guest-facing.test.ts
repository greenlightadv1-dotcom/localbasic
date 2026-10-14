import { describe, expect, it, vi } from 'vitest';
import { AppError, DB_RATE_LIMITED, guestFacingDbError, toAppError } from './errors';

describe('database rate limits', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});

  it('maps the LB429 code to rate_limited everywhere', () => {
    expect(toAppError({ code: DB_RATE_LIMITED, message: 'x' }, 't').code).toBe('rate_limited');
    expect(guestFacingDbError({ code: DB_RATE_LIMITED, message: 'x' }, 't').code).toBe('rate_limited');
  });

  it('keeps the database\'s Arabic reason, never English detail', () => {
    const reason = 'لديك طلبات بانتظار التأكيد. أكّد رقمك عبر واتساب أولًا.';
    expect(guestFacingDbError({ code: DB_RATE_LIMITED, message: reason }, 't').message).toBe(reason);
    expect(toAppError({ code: DB_RATE_LIMITED, message: 'bucket rl_order_phone' }, 't').message).not.toContain('bucket');
  });

  it('leaves other errors as internal', () => {
    const e = toAppError({ code: 'XX000', message: 'boom' }, 't');
    expect(e).toBeInstanceOf(AppError);
    expect(e.code).toBe('internal');
  });
});

describe('guestFacingDbError', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});

  it('passes through messages a function raised on purpose', () => {
    expect(guestFacingDbError({ code: '23514', message: 'order below the minimum' }, 't').message).toBe('order below the minimum');
    expect(guestFacingDbError({ code: '22023', message: 'الاسم مطلوب' }, 't').message).toBe('الاسم مطلوب');
  });

  it.each([
    { code: '23514', message: 'new row for relation "restaurant_orders" violates check constraint "x"' },
    { code: '23505', message: 'duplicate key value violates unique constraint "orders_pkey"' },
    { code: '22P02', message: 'invalid input syntax for type uuid: "abc"' },
    { code: '42883', message: 'function public.foo(text) does not exist' },
    { code: undefined, message: 'anything at all' },
  ])('hides Postgres-generated detail: $message', (error) => {
    const e = guestFacingDbError(error, 't');
    expect(e.code).toBe('validation');
    expect(e.message).not.toMatch(/relation|constraint|uuid|function|anything/);
  });
});
