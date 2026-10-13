import { beforeEach, describe, expect, it, vi } from 'vitest';

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

type AuthResult = { data: unknown; error: { message: string } | null };

const signInWithPassword = vi.fn(
  async (_c: { email: string; password: string }): Promise<AuthResult> => ({ data: {}, error: null }),
);
const updateUser = vi.fn(
  async (_attrs: { password: string }): Promise<AuthResult> => ({ data: {}, error: null }),
);
const getUser = vi.fn(async () => ({ data: { user: { id: 'u1' } as { id: string } | null }, error: null }));

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () => ({ auth: { signInWithPassword, updateUser, getUser } }),
}));

const gate = { mustChange: true };
vi.mock('@/lib/auth/password-gate', () => ({ mustChangePassword: async () => gate.mustChange }));

const clearMustChangePassword = vi.fn(async (_id: string) => {});
vi.mock('@/modules/core/members/credentials', () => ({
  clearMustChangePassword: (id: string) => clearMustChangePassword(id),
}));

import { changePasswordAction, signInAction } from './actions';

function form(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}

async function destinationOf(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (e) {
    if (e instanceof RedirectError) return e.to;
    throw e;
  }
  throw new Error('expected a redirect');
}

/** Each test needs its own identifier and IP: the limiter is process-wide. */
let n = 0;
function fresh() {
  n += 1;
  return `user${n}-${Date.now()}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  ip.mockImplementation(() => `198.51.100.${(n % 250) + 1}`);
  signInWithPassword.mockResolvedValue({ data: {}, error: null });
  updateUser.mockResolvedValue({ data: {}, error: null });
  getUser.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null });
  gate.mustChange = true;
});

describe('signInAction', () => {
  it('signs a username in under its derived internal address', async () => {
    const username = fresh();
    const to = await destinationOf(signInAction(undefined, form({ identifier: username, password: 'secret1' })));
    expect(to).toBe('/workspace');
    expect(signInWithPassword).toHaveBeenCalledWith({
      email: `${username.toLowerCase()}@login.localbasic.internal`,
      password: 'secret1',
    });
  });

  it('still lets a real email (platform admins, older accounts) sign in as typed', async () => {
    await destinationOf(signInAction(undefined, form({ identifier: 'Admin@Example.com', password: 'secret12' })));
    expect(signInWithPassword).toHaveBeenCalledWith({ email: 'admin@example.com', password: 'secret12' });
  });

  it('gives one generic message for a wrong password', async () => {
    signInWithPassword.mockResolvedValueOnce({ data: null, error: { message: 'Invalid login credentials' } });
    const result = await signInAction(undefined, form({ identifier: fresh(), password: 'wrongpass' }));
    expect(result).toEqual({ error: 'بيانات الدخول غير صحيحة.' });
  });

  it('rate-limits repeated attempts against one username', async () => {
    const username = fresh();
    ip.mockImplementation(() => '203.0.113.200');
    signInWithPassword.mockResolvedValue({ data: null, error: { message: 'Invalid login credentials' } });
    const results: unknown[] = [];
    for (let i = 0; i < 12; i += 1) {
      results.push(await signInAction(undefined, form({ identifier: username, password: 'wrongpass' })));
    }
    expect(results).toContainEqual({ error: 'محاولات كثيرة. برجاء المحاولة بعد قليل.' });
    expect(signInWithPassword.mock.calls.length).toBeLessThan(12);
  });
});

describe('changePasswordAction', () => {
  const GOOD = { password: 'correct horse battery', confirm: 'correct horse battery' };

  it('sets the password, clears the temporary-password flag and lands in the workspace', async () => {
    const to = await destinationOf(changePasswordAction(form(GOOD)));
    expect(to).toBe('/workspace');
    expect(updateUser).toHaveBeenCalledWith({ password: 'correct horse battery' });
    expect(clearMustChangePassword).toHaveBeenCalledWith('u1');
  });

  // The whole point of "staff cannot change their own password": their flag is
  // never set, so this action does nothing for them.
  it('does nothing for an account that was not given a temporary password', async () => {
    gate.mustChange = false;
    const to = await destinationOf(changePasswordAction(form(GOOD)));
    expect(to).toBe('/workspace');
    expect(updateUser).not.toHaveBeenCalled();
    expect(clearMustChangePassword).not.toHaveBeenCalled();
  });

  it('sends a signed-out visitor to sign-in', async () => {
    getUser.mockResolvedValueOnce({ data: { user: null }, error: null });
    expect(await destinationOf(changePasswordAction(form(GOOD)))).toBe('/sign-in');
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('refuses a mismatched confirmation or a short password', async () => {
    expect(await destinationOf(changePasswordAction(form({ password: 'correct horse battery', confirm: 'other' }))))
      .toBe('/change-password?status=invalid');
    expect(await destinationOf(changePasswordAction(form({ password: 'short', confirm: 'short' }))))
      .toBe('/change-password?status=invalid');
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('surfaces a Supabase rejection and keeps the gate set', async () => {
    updateUser.mockResolvedValueOnce({ data: null, error: { message: 'same as old' } });
    expect(await destinationOf(changePasswordAction(form(GOOD)))).toBe('/change-password?status=failed');
    expect(clearMustChangePassword).not.toHaveBeenCalled();
  });
});
