import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  calls: [] as { fn: string; args: Record<string, unknown> }[],
  data: null as unknown,
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      h.calls.push({ fn, args });
      return { data: h.data, error: null };
    },
  }),
}));

beforeEach(() => {
  h.calls.length = 0;
  h.data = null;
});

describe('getCustomerProfile', () => {
  it('returns nothing for an unrecognised device', async () => {
    h.data = { verified: false };
    const { getCustomerProfile } = await import('./service');
    expect(await getCustomerProfile({ kind: 'slug', orgSlug: 'x' }, 'device-12345', '0101')).toEqual({ verified: false });
  });

  it('picks the slug or the table-token function', async () => {
    h.data = { verified: false };
    const { getCustomerProfile } = await import('./service');
    await getCustomerProfile({ kind: 'slug', orgSlug: 'avechi' }, 'device-12345', '01012345678');
    await getCustomerProfile({ kind: 'token', token: 'tok-abcdefgh' }, 'device-12345', '01012345678');
    expect(h.calls.map((c) => c.fn)).toEqual(['customer_profile', 'customer_profile_by_token']);
    expect(h.calls[0]!.args).toMatchObject({ p_org_slug: 'avechi', p_device_id: 'device-12345' });
  });

  it('maps a verified profile and drops lines whose variant no longer exists', async () => {
    h.data = {
      verified: true, name: 'منى', phone: '01012345678', currency: 'EGP',
      addresses: [{ recipient_name: 'منى', phone: '010', city: 'القاهرة', area: null, address: '12 شارع', landmark: null }],
      orders: [{
        number: '000031', status: 'preparing', type: 'delivery', total_cents: 4500, placed_at: '2026-10-13T10:00:00Z', token: 'tok',
        items: [
          { variant_id: 'v1', product_name: 'لاتيه', variant_name: 'default', quantity: '2.000', note: null, modifier_ids: ['m1'] },
          { variant_id: null, product_name: 'صنف محذوف', variant_name: 'default', quantity: 1, note: null, modifier_ids: [] },
        ],
      }],
      loyalty: { enabled: true, earned: 40, spent: 30, balance: 10, reward_points: 30, reward_value_cents: 2000, cents_per_point: 1000 },
      coupons: [{ code: 'LB-ABCDEF', value_cents: 2000, expires_at: '2026-12-01T00:00:00Z' }],
    };
    const { getCustomerProfile } = await import('./service');
    const p = await getCustomerProfile({ kind: 'slug', orgSlug: 'x' }, 'device-12345', '01012345678');
    expect(p.verified).toBe(true);
    if (!p.verified) return;
    expect(p.orders[0]!.items).toEqual([
      { variantId: 'v1', productName: 'لاتيه', variantName: 'default', quantity: 2, note: null, modifierIds: ['m1'] },
    ]);
    expect(p.loyalty).toMatchObject({ enabled: true, balance: 10, rewardPoints: 30, rewardValueCents: 2000 });
    expect(p.coupons[0]).toEqual({ code: 'LB-ABCDEF', valueCents: 2000, expiresAt: '2026-12-01T00:00:00Z' });
    expect(p.addresses[0]).toMatchObject({ address: '12 شارع', city: 'القاهرة' });
  });
});
