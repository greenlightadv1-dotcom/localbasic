import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Payment settings at the service boundary: what reaches the database for a
 * gateway save, and what a guest is ever told.
 */
const h = vi.hoisted(() => ({
  calls: [] as { fn: string; args: Record<string, unknown> }[],
  optionsRow: { out_cash: true, out_online_gateway: null as string | null },
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      h.calls.push({ fn, args });
      if (fn.startsWith('restaurant_payment_options')) return { data: [h.optionsRow], error: null };
      return { data: null, error: null };
    },
  }),
}));
vi.mock('@/modules/core/tenancy/context', () => ({ requirePermission: () => undefined }));

const ctx = { organizationId: 'org-1' } as never;
const KEY = 'k'.repeat(40);

const base = { cashEnabled: true, onlineEnabled: true, gateway: 'stripe', clearSecret: false };

beforeEach(() => {
  h.calls.length = 0;
  h.optionsRow = { out_cash: true, out_online_gateway: null };
  process.env.PAYMENT_CREDENTIALS_KEY = KEY;
});

describe('savePaymentSettings', () => {
  it('encrypts secrets: no key ever reaches the database readable', async () => {
    const { savePaymentSettings } = await import('./service');
    await savePaymentSettings(ctx, {
      ...base,
      values: { public_key: 'pk_live_PUBLIC', secret_key: 'sk_live_SECRET9999' },
    });
    const args = h.calls[0]!.args;
    expect(args.p_public_config).toEqual({ public_key: 'pk_live_PUBLIC' });
    expect(String(args.p_secret_ciphertext)).toMatch(/^v1:/);
    expect(JSON.stringify(args)).not.toContain('sk_live_SECRET');
    expect(args.p_secret_hint).toBe('••••9999');
  });

  it('keeps the stored secret when none is typed', async () => {
    const { savePaymentSettings } = await import('./service');
    await savePaymentSettings(ctx, { ...base, values: { public_key: 'pk_live_X' } });
    expect(h.calls[0]!.args.p_secret_ciphertext).toBeNull();
    expect(h.calls[0]!.args.p_clear_secret).toBe(false);
  });

  it('rejects a half-updated secret set', async () => {
    const { savePaymentSettings } = await import('./service');
    await expect(
      savePaymentSettings(ctx, { ...base, gateway: 'paymob', values: { secret_key: 'only-one' } }),
    ).rejects.toThrow();
    expect(h.calls).toHaveLength(0);
  });

  it('refuses to store credentials without an encryption key', async () => {
    delete process.env.PAYMENT_CREDENTIALS_KEY;
    const { savePaymentSettings } = await import('./service');
    await expect(
      savePaymentSettings(ctx, { ...base, values: { secret_key: 'sk_live_Z' } }),
    ).rejects.toThrow();
    expect(h.calls).toHaveLength(0);
  });

  it('refuses unknown gateways and turning cash off before online is live', async () => {
    const { savePaymentSettings } = await import('./service');
    await expect(savePaymentSettings(ctx, { ...base, gateway: 'evilpay', values: {} })).rejects.toThrow();
    await expect(
      savePaymentSettings(ctx, { ...base, cashEnabled: false, values: {} }),
    ).rejects.toThrow();
    expect(h.calls).toHaveLength(0);
  });
});

describe('public payment options', () => {
  it('exposes only the gateway name, never credentials', async () => {
    h.optionsRow = { out_cash: true, out_online_gateway: 'tap' };
    const { getPublicPaymentOptions } = await import('./service');
    const options = await getPublicPaymentOptions('almahara');
    expect(options).toEqual({ cash: true, online: { gateway: 'tap', label: 'Tap Payments', live: false } });
  });

  it('shows cash only when no gateway is available', async () => {
    const { getPublicPaymentOptionsByToken } = await import('./service');
    expect(await getPublicPaymentOptionsByToken('tok')).toEqual({ cash: true, online: null });
  });
});
