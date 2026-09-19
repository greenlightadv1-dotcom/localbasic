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
  const response = await GET(new NextRequest(`${ORIGIN}/callback${query}`));
  return response.headers.get('location') ?? '';
}

beforeEach(() => {
  vi.clearAllMocks();
  exchangeCodeForSession.mockResolvedValue({ error: null });
});

describe('GET /callback', () => {
  it('exchanges the code and honours a same-origin next', async () => {
    expect(await visit('?code=abc&next=%2Freset-password')).toBe(`${ORIGIN}/reset-password`);
    expect(exchangeCodeForSession).toHaveBeenCalledWith('abc');
  });

  it('defaults to the workspace when no next is given', async () => {
    expect(await visit('?code=abc')).toBe(`${ORIGIN}/workspace`);
  });

  // The regression this whole investigation was about.
  it('sends a recovery link to the password form even with no next', async () => {
    expect(await visit('?code=abc&type=recovery')).toBe(`${ORIGIN}/reset-password`);
  });

  it('sends a recovery link to the password form even when next says otherwise', async () => {
    expect(await visit('?code=abc&type=recovery&next=%2Fworkspace')).toBe(
      `${ORIGIN}/reset-password`,
    );
  });

  it('refuses to bounce off-origin, whatever next claims', async () => {
    expect(await visit('?code=abc&next=https%3A%2F%2Fevil.example')).toBe(`${ORIGIN}/workspace`);
    expect(await visit('?code=abc&next=%2F%2Fevil.example')).toBe(`${ORIGIN}/workspace`);
  });

  it('reports an expired link instead of a bare sign-in page', async () => {
    expect(await visit('?error=access_denied&error_code=otp_expired')).toBe(
      `${ORIGIN}/sign-in?error=link_invalid`,
    );
    expect(exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it('reports a missing code the same way', async () => {
    expect(await visit('')).toBe(`${ORIGIN}/sign-in?error=link_invalid`);
  });

  it('reports a rejected exchange rather than pretending it worked', async () => {
    exchangeCodeForSession.mockResolvedValueOnce({ error: { message: 'invalid code' } });
    expect(await visit('?code=stale&type=recovery')).toBe(`${ORIGIN}/sign-in?error=link_invalid`);
  });
});
