import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const env: Record<string, string | undefined> = {};
vi.mock('@/lib/env', () => ({
  clientEnv: {
    NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key-that-is-long-enough',
    NEXT_PUBLIC_APP_URL: 'https://localbasic.vercel.app',
    NEXT_PUBLIC_APP_NAME: 'LocalBasic',
  },
  serverEnv: () => env,
}));

const generateLink = vi.fn(
  async (_args: unknown): Promise<{
    data: { properties?: { action_link?: string } } | null;
    error: { message: string } | null;
  }> => ({ data: { properties: { action_link: 'https://link.invalid/one-time' } }, error: null }),
);
vi.mock('@/lib/supabase/admin', () => ({
  createSupabaseAdminClient: () => ({ auth: { admin: { generateLink } } }),
}));

import { POST } from './route';

const SECRET = 'a'.repeat(48);
const OWNER = 'local.basic.adv@gmail.com';

function call(secret: string | null, email: unknown) {
  return POST(
    new NextRequest('https://localbasic.vercel.app/api/admin-bootstrap', {
      method: 'POST',
      headers: secret === null ? {} : { 'x-bootstrap-secret': secret },
      body: JSON.stringify({ email }),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  env.ADMIN_BOOTSTRAP_SECRET = SECRET;
  env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key-long-enough-to-pass';
  generateLink.mockResolvedValue({
    data: { properties: { action_link: 'https://link.invalid/one-time' } },
    error: null,
  });
});

describe('POST /api/admin-bootstrap', () => {
  it('returns a single recovery link for the platform owner', async () => {
    const response = await call(SECRET, OWNER);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      action_link: 'https://link.invalid/one-time',
    });
    // No email is sent: generateLink only mints the link.
    expect(generateLink).toHaveBeenCalledTimes(1);
  });

  it('is invisible when the bootstrap secret is not configured', async () => {
    env.ADMIN_BOOTSTRAP_SECRET = undefined;
    expect((await call(SECRET, OWNER)).status).toBe(404);
    expect(generateLink).not.toHaveBeenCalled();
  });

  it('is invisible when no service-role key is configured', async () => {
    env.SUPABASE_SERVICE_ROLE_KEY = undefined;
    expect((await call(SECRET, OWNER)).status).toBe(404);
    expect(generateLink).not.toHaveBeenCalled();
  });

  it.each([
    ['a wrong secret of the same length', 'b'.repeat(48)],
    ['a wrong secret of another length', 'b'.repeat(10)],
    ['no secret at all', null],
  ])('refuses %s', async (_label, secret) => {
    expect((await call(secret, OWNER)).status).toBe(404);
    expect(generateLink).not.toHaveBeenCalled();
  });

  // The whole point: holding the secret does not make it a generic admin tool.
  it.each([
    ['another account', 'someone.else@example.com'],
    ['the Resend sender identity', 'local.basic@greenlightadvs.com'],
    ['a non-string', 42],
    ['nothing', undefined],
  ])('refuses to mint a link for %s', async (_label, email) => {
    expect((await call(SECRET, email)).status).toBe(404);
    expect(generateLink).not.toHaveBeenCalled();
  });

  it('accepts the owner address with stray case and spacing', async () => {
    expect((await call(SECRET, '  Local.Basic.Adv@Gmail.com ')).status).toBe(200);
  });

  it('does not leak why Supabase refused', async () => {
    generateLink.mockResolvedValueOnce({ data: null, error: { message: 'user banned' } });
    const response = await call(SECRET, OWNER);
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ ok: false });
  });
});
