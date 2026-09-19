import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- doubles -------------------------------------------------------------
// The env module parses process.env at import time and would demand real
// Supabase credentials, so it is replaced wholesale.
vi.mock('@/lib/env', () => ({
  clientEnv: {
    NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key-that-is-long-enough',
    NEXT_PUBLIC_APP_URL: 'https://localbasic.vercel.app',
    NEXT_PUBLIC_APP_NAME: 'LocalBasic',
  },
  serverEnv: () => ({}),
}));

const ip = vi.fn(() => '203.0.113.7');
vi.mock('@/lib/action', () => ({ getClientIp: () => ip() }));

class RedirectError extends Error {
  constructor(public to: string) {
    super(`redirect:${to}`);
  }
}
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new RedirectError(to);
  },
}));

type AuthError = { message: string } | null;
type AuthError2 = { message: string; status?: number } | null;
type AuthResult = { data: unknown; error: AuthError2 };
type UserResult = { data: { user: { id: string; email: string } | null }; error: AuthError };

const resetPasswordForEmail = vi.fn(
  async (_email: string, _options: { redirectTo: string }): Promise<AuthResult> => ({
    data: {},
    error: null,
  }),
);
const updateUser = vi.fn(
  async (_attrs: { password: string }): Promise<AuthResult> => ({ data: {}, error: null }),
);
const getUser = vi.fn(
  async (): Promise<UserResult> => ({ data: { user: { id: 'u1', email: 'a@b.com' } }, error: null }),
);

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () => ({
    auth: { resetPasswordForEmail, updateUser, getUser },
  }),
}));

import { requestPasswordResetAction, updatePasswordAction } from './actions';

function form(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}

/** The actions redirect rather than return; capture where they went. */
async function destinationOf(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (e) {
    if (e instanceof RedirectError) return e.to;
    throw e;
  }
  throw new Error('expected a redirect');
}

/** Each test needs its own address and IP: the limiter is process-wide. */
let n = 0;
function freshEmail() {
  n += 1;
  return `user${n}-${Date.now()}@example.com`;
}

beforeEach(() => {
  vi.clearAllMocks();
  ip.mockImplementation(() => `198.51.100.${(n % 250) + 1}`);
  resetPasswordForEmail.mockResolvedValue({ data: {}, error: null });
  updateUser.mockResolvedValue({ data: {}, error: null });
  getUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'a@b.com' } }, error: null });
});

describe('requestPasswordResetAction', () => {
  it('calls Supabase with the production callback and reports success', async () => {
    const email = freshEmail();
    const to = await destinationOf(requestPasswordResetAction(form({ email })));

    expect(to).toBe('/forgot-password?status=sent');
    expect(resetPasswordForEmail).toHaveBeenCalledTimes(1);

    const [sentTo, options] = resetPasswordForEmail.mock.calls[0]!;
    expect(sentTo).toBe(email);
    expect(options.redirectTo).toBe('https://localbasic.vercel.app/callback/recovery');
    expect(new URL(options.redirectTo).search).toBe('');
    expect(options.redirectTo).not.toContain('localhost');
  });

  it('rejects a malformed address without contacting Supabase', async () => {
    const to = await destinationOf(requestPasswordResetAction(form({ email: 'nope' })));
    expect(to).toBe('/forgot-password?status=invalid');
    expect(resetPasswordForEmail).not.toHaveBeenCalled();
  });

  // Never swallowed: the previous version discarded the result entirely, so a
  // refusal from Supabase looked exactly like a delivered email.
  it('surfaces a Supabase failure instead of claiming success', async () => {
    resetPasswordForEmail.mockResolvedValueOnce({
      data: null,
      error: { message: 'redirect_to not allowed', status: 400 },
    });
    const to = await destinationOf(requestPasswordResetAction(form({ email: freshEmail() })));
    expect(to).toBe('/forgot-password?status=failed');
  });

  it('stops mail-bombing one address', async () => {
    const email = freshEmail();
    ip.mockImplementation(() => '203.0.113.99');

    const destinations: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      destinations.push(await destinationOf(requestPasswordResetAction(form({ email }))));
    }
    expect(destinations).toContain('/forgot-password?status=rate_limited');
    expect(resetPasswordForEmail.mock.calls.length).toBeLessThan(7);
  });
});

describe('updatePasswordAction', () => {
  it('sets the password and lands in the workspace', async () => {
    const to = await destinationOf(
      updatePasswordAction(form({ password: 'correct horse battery', confirm: 'correct horse battery' })),
    );
    expect(to).toBe('/workspace');
    expect(updateUser).toHaveBeenCalledWith({ password: 'correct horse battery' });
  });

  it('refuses a mismatched confirmation', async () => {
    const to = await destinationOf(
      updatePasswordAction(form({ password: 'correct horse battery', confirm: 'other' })),
    );
    expect(to).toBe('/reset-password?status=invalid');
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('refuses a short password', async () => {
    const to = await destinationOf(updatePasswordAction(form({ password: 'short', confirm: 'short' })));
    expect(to).toBe('/reset-password?status=invalid');
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('reports an expired or already-used link', async () => {
    getUser.mockResolvedValueOnce({ data: { user: null }, error: null });
    const to = await destinationOf(
      updatePasswordAction(form({ password: 'correct horse battery', confirm: 'correct horse battery' })),
    );
    expect(to).toBe('/reset-password?status=expired');
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('surfaces a Supabase rejection', async () => {
    updateUser.mockResolvedValueOnce({ data: null, error: { message: 'same as old' } });
    const to = await destinationOf(
      updatePasswordAction(form({ password: 'correct horse battery', confirm: 'correct horse battery' })),
    );
    expect(to).toBe('/reset-password?status=failed');
  });
});
