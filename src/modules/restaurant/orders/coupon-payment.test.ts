import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A reward coupon is redeemed, paid with its value added to the discount, and
 * handed back if the payment is refused — a failed sale must never burn it.
 */
const h = vi.hoisted(() => ({
  calls: [] as { fn: string; args: Record<string, unknown> }[],
  payFails: false,
  redeemFails: false,
  promos: [] as { amount_cents: number }[],
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () => ({
    // Promotions applied to the order (0107): restaurant_order_promotions.
    from: () => ({ select: () => ({ eq: async () => ({ data: h.promos, error: null }) }) }),
    rpc: (fn: string, args: Record<string, unknown>) => {
      h.calls.push({ fn, args });
      let res: { data: unknown; error: unknown } = { data: null, error: null };
      if (fn === 'restaurant_coupon_redeem') {
        res = h.redeemFails
          ? { data: null, error: { code: '23514', message: 'هذا الكود مستخدم بالفعل' } }
          : { data: 2000, error: null };
      }
      if (fn === 'restaurant_pay_order') {
        res = h.payFails
          ? { data: null, error: { code: '23514', message: 'discount exceeds the order total' } }
          : {
              data: {
                out_invoice_id: 'inv', out_receipt_number: 'R-1', out_total_cents: 8000,
                out_paid_cents: 8000, out_due_cents: 0, out_change_cents: 0,
              },
              error: null,
            };
      }
      return Object.assign(Promise.resolve(res), { single: async () => res });
    },
  }),
}));

const ctx = { organizationId: 'org-1' } as never;
const base = { orderId: 'ord-1', method: 'cash', tenderedCents: 8000, discountCents: 500 };

beforeEach(() => {
  h.calls.length = 0;
  h.payFails = false;
  h.redeemFails = false;
  h.promos = [];
});

describe('payOrder with a reward coupon', () => {
  it('redeems first and adds its value to the discount', async () => {
    const { payOrder } = await import('./service');
    await payOrder(ctx, { ...base, couponCode: 'LB-ABCDEF' });
    expect(h.calls.map((c) => c.fn)).toEqual(['restaurant_coupon_redeem', 'restaurant_pay_order']);
    expect(h.calls[1]!.args.p_discount_cents).toBe(2500);
  });

  it('gives the coupon back when the payment is refused', async () => {
    h.payFails = true;
    const { payOrder } = await import('./service');
    await expect(payOrder(ctx, { ...base, couponCode: 'LB-ABCDEF' })).rejects.toThrow();
    expect(h.calls.map((c) => c.fn)).toEqual([
      'restaurant_coupon_redeem', 'restaurant_pay_order', 'restaurant_coupon_release',
    ]);
  });

  it('does not charge when the code is refused', async () => {
    h.redeemFails = true;
    const { payOrder } = await import('./service');
    await expect(payOrder(ctx, { ...base, couponCode: 'LB-USEDUP' })).rejects.toThrow();
    expect(h.calls.map((c) => c.fn)).toEqual(['restaurant_coupon_redeem']);
  });

  it('leaves an ordinary payment untouched', async () => {
    const { payOrder } = await import('./service');
    await payOrder(ctx, base);
    expect(h.calls.map((c) => c.fn)).toEqual(['restaurant_pay_order']);
    expect(h.calls[0]!.args.p_discount_cents).toBe(500);
  });

  it('counts promotions already applied to the order as discount', async () => {
    h.promos = [{ amount_cents: 1200 }, { amount_cents: 300 }];
    const { payOrder } = await import('./service');
    await payOrder(ctx, { ...base, couponCode: 'LB-ABCDEF' });
    expect(h.calls[1]!.args.p_discount_cents).toBe(500 + 2000 + 1500);
  });
});
