import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The public "has my WhatsApp message arrived?" read. */
const h = vi.hoisted(() => ({
  calls: 0,
  reply: { data: null as unknown, error: null as null | { code?: string; message?: string } },
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/supabase/admin', () => ({ createSupabaseAdminClient: () => ({}) }));
vi.mock('@/modules/core/tenancy/context', () => ({ requirePermission: () => undefined }));
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () => ({
    rpc: () => ({
      single: async () => {
        h.calls += 1;
        return h.reply;
      },
    }),
  }),
}));

const TOKEN = 'AbC123_-xyzXYZ0987654321abcdEFGH';
let n = 0;
const fresh = () => `${TOKEN.slice(0, 24)}${String(n++).padStart(8, '0')}`;

beforeEach(() => {
  h.calls = 0;
  h.reply = {
    data: { out_status: 'pending_verification', out_code: 'MAIN-123456', out_whatsapp: '201000000000', out_expires_at: null },
    error: null,
  };
});

describe('checkVerificationStatus', () => {
  it('returns only status, code, store WhatsApp and expiry', async () => {
    const { checkVerificationStatus } = await import('./service');
    const r = await checkVerificationStatus(fresh(), '1.1.1.1');
    expect(r).toEqual({ ok: true, data: { status: 'pending_verification', code: 'MAIN-123456', whatsapp: '201000000000', expiresAt: null } });
  });

  it.each([undefined, 42, '', 'short', '<script>alert(1)</script>xxxxxxxx', 'x'.repeat(201)])(
    'refuses a malformed token without touching the database: %s',
    async (bad) => {
      const { checkVerificationStatus } = await import('./service');
      const r = await checkVerificationStatus(bad, '1.1.1.2');
      expect(r).toMatchObject({ ok: false, code: 'not_found' });
      expect(h.calls).toBe(0);
    },
  );

  it('reports an unknown or expired token as not_found, other failures as failed', async () => {
    const { checkVerificationStatus } = await import('./service');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    h.reply = { data: null, error: { code: '23514', message: 'order not found' } };
    expect(await checkVerificationStatus(fresh(), '1.1.1.3')).toMatchObject({ ok: false, code: 'not_found' });
    h.reply = { data: null, error: { code: 'XX000', message: 'boom' } };
    const r = await checkVerificationStatus(fresh(), '1.1.1.3');
    expect(r).toMatchObject({ ok: false, code: 'failed' });
    expect(JSON.stringify(r)).not.toContain('boom');
  });

  it('rate limits one token, and one address across tokens', async () => {
    const { checkVerificationStatus } = await import('./service');
    const t = fresh();
    for (let i = 0; i < 40; i++) expect((await checkVerificationStatus(t, `2.2.2.${i % 9}`)).ok).toBe(true);
    expect(await checkVerificationStatus(t, '2.2.2.99')).toMatchObject({ ok: false, code: 'rate_limited' });

    for (let i = 0; i < 300; i++) await checkVerificationStatus(fresh(), '3.3.3.3');
    const before = h.calls;
    expect(await checkVerificationStatus(fresh(), '3.3.3.3')).toMatchObject({ ok: false, code: 'rate_limited' });
    expect(h.calls).toBe(before); // refused before the database
  });
});
