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
type AuthResult = { data: unknown; error: AuthError };
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

// --- forgot-password request --------------------------------------------
describe('requestPasswordResetAction', () => {
  it('asks Supabase for a recovery email pointing at the production callback', async () => {
    const email = freshEmail();
    const state = await requestPasswordResetAction(undefined, form({ email }));

    expect(state?.notice).toBeTruthy();
    expect(state?.error).toBeUndefined();
    expect(resetPasswordForEmail).toHaveBeenCalledTimes(1);

    const call = resetPasswordForEmail.mock.calls[0]!;
    const [sentTo, options] = call;
    expect(sentTo).toBe(email);
    expect(options.redirectTo).toBe('https://localbasic.vercel.app/callback/recovery');
    // No query string: Supabase allow-lists the whole URL, and a failed match
    // falls back to the Site URL without reporting anything.
    expect(new URL(options.redirectTo).search).toBe('');
    // The whole point of the exercise: never a developer machine.
    expect(options.redirectTo).not.toContain('localhost');
  });

  it('rejects a malformed address without contacting Supabase', async () => {
    const state = await requestPasswordResetAction(undefined, form({ email: 'not-an-email' }));
    expect(state?.error).toBeTruthy();
    expect(resetPasswordForEmail).not.toHaveBeenCalled();
  });

  it('answers identically for an unknown address, so it cannot enumerate users', async () => {
    const known = await requestPasswordResetAction(undefined, form({ email: freshEmail() }));

    resetPasswordForEmail.mockResolvedValueOnce({
      data: null,
      error: { message: 'User not found' },
    });
    const unknown = await requestPasswordResetAction(undefined, form({ email: freshEmail() }));

    expect(unknown).toEqual(known);
  });

  it('stops mail-bombing one address', async () => {
    const email = freshEmail();
    ip.mockImplementation(() => '203.0.113.99');

    const results = [];
    for (let i = 0; i < 7; i += 1) {
      results.push(await requestPasswordResetAction(undefined, form({ email })));
    }

    expect(results.some((r) => r?.error)).toBe(true);
    expect(resetPasswordForEmail.mock.calls.length).toBeLessThan(7);
  });
});

// --- password update ------------------------------------------------------
describe('updatePasswordAction', () => {
  it('sets the password against the recovery session and lands in the workspace', async () => {
    const promise = updatePasswordAction(
      undefined,
      form({ password: 'correct horse battery', confirm: 'correct horse battery' }),
    );
    await expect(promise).rejects.toBeInstanceOf(RedirectError);
    await promise.catch((e: RedirectError) => expect(e.to).toBe('/workspace'));

    expect(updateUser).toHaveBeenCalledWith({ password: 'correct horse battery' });
  });

  it('refuses a mismatched confirmation', async () => {
    const state = await updatePasswordAction(
      undefined,
      form({ password: 'correct horse battery', confirm: 'something else' }),
    );
    expect(state?.error).toBe('كلمتا المرور غير متطابقتين');
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('refuses a short password', async () => {
    const state = await updatePasswordAction(undefined, form({ password: 'short', confirm: 'short' }));
    expect(state?.error).toBeTruthy();
    expect(updateUser).not.toHaveBeenCalled();
  });

  // --- invalid / expired recovery link -----------------------------------
  it('reports an expired or already-used link instead of writing a password', async () => {
    getUser.mockResolvedValueOnce({ data: { user: null }, error: null });

    const state = await updatePasswordAction(
      undefined,
      form({ password: 'correct horse battery', confirm: 'correct horse battery' }),
    );

    expect(state?.error).toContain('غير صالح');
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('surfaces a Supabase rejection rather than claiming success', async () => {
    updateUser.mockResolvedValueOnce({ data: null, error: { message: 'same as old password' } });

    const state = await updatePasswordAction(
      undefined,
      form({ password: 'correct horse battery', confirm: 'correct horse battery' }),
    );

    expect(state?.error).toBeTruthy();
  });
});
