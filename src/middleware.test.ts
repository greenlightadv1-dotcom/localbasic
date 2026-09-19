import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
}));

import { middleware } from './middleware';

const ORIGIN = 'https://localbasic.vercel.app';

async function run(pathAndQuery: string) {
  return middleware(
    new NextRequest(`${ORIGIN}${pathAndQuery}`, {
      headers: { host: 'localbasic.vercel.app' },
    }),
  );
}

async function landOn(pathAndQuery: string): Promise<{ status: number; location: string }> {
  const response = await run(pathAndQuery);
  return { status: response.status, location: response.headers.get('location') ?? '' };
}

/** The headers middleware forwards to the render, as NextResponse encodes them. */
function forwardedRequestHeader(response: Response, name: string): string | null {
  return response.headers.get(`x-middleware-request-${name}`);
}

function nonceOf(csp: string | null): string | null {
  return csp?.match(/'nonce-([^']+)'/)?.[1] ?? null;
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

describe('content security policy', () => {
  // Without this the browser blocks every Next.js script: 'strict-dynamic'
  // makes 'self' inert, and unnonced scripts have nothing else to match. The
  // page still renders server-side, so nothing errors — it just never
  // hydrates, and no client component runs.
  it('forwards the policy on the request so Next.js can nonce its scripts', async () => {
    const response = await run('/');
    const forwarded = forwardedRequestHeader(response, 'content-security-policy');

    expect(forwarded).toBeTruthy();
    expect(forwarded).toContain("'strict-dynamic'");
    expect(nonceOf(forwarded)).toBeTruthy();
  });

  it('uses the same nonce on the request and the response', async () => {
    const response = await run('/');
    const responseNonce = nonceOf(response.headers.get('content-security-policy'));
    const requestNonce = nonceOf(forwardedRequestHeader(response, 'content-security-policy'));

    expect(responseNonce).toBeTruthy();
    expect(requestNonce).toBe(responseNonce);
  });

  it('also forwards x-nonce, for components that read it directly', async () => {
    const response = await run('/');
    const nonce = nonceOf(response.headers.get('content-security-policy'));
    expect(forwardedRequestHeader(response, 'x-nonce')).toBe(nonce);
  });

  it('gives each request its own nonce', async () => {
    const a = nonceOf((await run('/')).headers.get('content-security-policy'));
    const b = nonceOf((await run('/')).headers.get('content-security-policy'));
    expect(a).not.toBe(b);
  });
});
