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
  // `/` and `/forgot-password` are statically prerendered, so their script
  // tags are baked at build time. A per-request nonce can never match them,
  // and 'strict-dynamic' makes browsers ignore 'self' — which blocked every
  // Next.js script on exactly those pages while the markup still rendered.
  it('carries no nonce, which a prerendered page could never match', async () => {
    const csp = (await run('/')).headers.get('content-security-policy') ?? '';
    expect(csp).not.toContain('nonce-');
    expect(csp).not.toContain('strict-dynamic');
  });

  it('allows the scripts Next.js actually emits', async () => {
    const csp = (await run('/')).headers.get('content-security-policy') ?? '';
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
  });

  it('keeps the rest of the policy tight', async () => {
    const csp = (await run('/')).headers.get('content-security-policy') ?? '';
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('is identical across requests, so a CDN copy stays valid', async () => {
    const a = (await run('/')).headers.get('content-security-policy');
    const b = (await run('/')).headers.get('content-security-policy');
    expect(a).toBe(b);
  });
});
