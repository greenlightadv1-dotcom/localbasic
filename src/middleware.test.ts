import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
}));

import { middleware } from './middleware';

const ORIGIN = 'https://localbasic.vercel.app';

async function landOn(pathAndQuery: string): Promise<{ status: number; location: string }> {
  const response = await middleware(
    new NextRequest(`${ORIGIN}${pathAndQuery}`, {
      headers: { host: 'localbasic.vercel.app' },
    }),
  );
  return { status: response.status, location: response.headers.get('location') ?? '' };
}

describe('auth links that land on the site root', () => {
  // The regression: Supabase redirects its own links to the Site URL, which is
  // the root. A ?code= there used to render the marketing page and spend the
  // link silently.
  it('forwards a code on the root to the callback', async () => {
    const { status, location } = await landOn('/?code=abc123');
    expect(status).toBe(307);
    expect(location).toBe(`${ORIGIN}/callback?code=abc123`);
  });

  it('keeps the rest of the query, so type=recovery survives', async () => {
    const { location } = await landOn('/?code=abc123&type=recovery');
    expect(location).toBe(`${ORIGIN}/callback?code=abc123&type=recovery`);
  });

  it('turns an expired-link error into a message instead of the home page', async () => {
    const { location } = await landOn(
      '/?error=access_denied&error_code=otp_expired&error_description=x',
    );
    expect(location).toBe(`${ORIGIN}/sign-in?error=link_invalid`);
  });

  it('leaves an ordinary home-page visit alone', async () => {
    const { location } = await landOn('/');
    expect(location).toBe('');
  });

  it('leaves unrelated query strings alone', async () => {
    const { location } = await landOn('/?utm_source=whatsapp');
    expect(location).toBe('');
  });

  it('does not hijack a code on any other path', async () => {
    const { location } = await landOn('/sign-in?code=abc123');
    expect(location).toBe('');
  });
});
