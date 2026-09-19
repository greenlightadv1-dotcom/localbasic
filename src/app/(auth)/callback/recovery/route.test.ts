import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/env', () => ({
  clientEnv: {
    NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key-that-is-long-enough',
    NEXT_PUBLIC_APP_URL: 'https://localbasic.vercel.app',
    NEXT_PUBLIC_APP_NAME: 'LocalBasic',
  },
  serverEnv: () => ({}),
}));

const exchangeCodeForSession = vi.fn(
  async (_code: string): Promise<{ error: { message: string } | null }> => ({ error: null }),
);
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () => ({ auth: { exchangeCodeForSession } }),
}));

import { GET } from './route';

const ORIGIN = 'https://localbasic.vercel.app';

async function visit(query: string): Promise<string> {
  const response = await GET(new NextRequest(`${ORIGIN}/callback/recovery${query}`));
  return response.headers.get('location') ?? '';
}

beforeEach(() => {
  vi.clearAllMocks();
  exchangeCodeForSession.mockResolvedValue({ error: null });
});

describe('GET /callback/recovery', () => {
  it('exchanges the code and lands on the password form', async () => {
    expect(await visit('?code=abc123')).toBe(`${ORIGIN}/reset-password`);
    expect(exchangeCodeForSession).toHaveBeenCalledWith('abc123');
  });

  // A recovery session must never reach the workspace: the holder of this link
  // is precisely the person who cannot sign in yet.
  it('ignores any attempt to redirect it elsewhere', async () => {
    expect(await visit('?code=abc123&next=%2Fworkspace')).toBe(`${ORIGIN}/reset-password`);
    expect(await visit('?code=abc123&next=https%3A%2F%2Fevil.example')).toBe(
      `${ORIGIN}/reset-password`,
    );
    expect(await visit('?code=abc123&next=%2F%2Fevil.example')).toBe(`${ORIGIN}/reset-password`);
  });

  it('reports an expired or already-used link', async () => {
    expect(await visit('?error=access_denied&error_code=otp_expired')).toBe(
      `${ORIGIN}/sign-in?error=link_invalid`,
    );
    expect(exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it('reports a missing code the same way', async () => {
    expect(await visit('')).toBe(`${ORIGIN}/sign-in?error=link_invalid`);
  });

  it('reports a rejected exchange rather than showing the form', async () => {
    exchangeCodeForSession.mockResolvedValueOnce({ error: { message: 'invalid' } });
    expect(await visit('?code=stale')).toBe(`${ORIGIN}/sign-in?error=link_invalid`);
  });
});
