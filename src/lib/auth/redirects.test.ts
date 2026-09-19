import { afterEach, describe, expect, it, vi } from 'vitest';

// These helpers take an explicit origin, so the only thing the env module is
// needed for is appOrigin()'s default — stub it rather than demand real keys.
// vi.mock is hoisted above ordinary declarations, so the object it hands back
// has to be created inside vi.hoisted to exist by the time the factory runs.
const { clientEnv } = vi.hoisted(() => ({
  clientEnv: {
    NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key-that-is-long-enough',
    NEXT_PUBLIC_APP_URL: 'https://localbasic.vercel.app',
    NEXT_PUBLIC_APP_NAME: 'LocalBasic',
  },
}));
vi.mock('@/lib/env', () => ({ clientEnv, serverEnv: () => ({}) }));

import {
  appOrigin,
  appOriginSource,
  isLoopbackOrigin,
  recoveryRedirectUrl,
  safeNextPath,
} from './redirects';

describe('safeNextPath', () => {
  it('keeps an ordinary same-origin path', () => {
    expect(safeNextPath('/reset-password')).toBe('/reset-password');
    expect(safeNextPath('/workspace/settings?tab=team')).toBe('/workspace/settings?tab=team');
  });

  it('falls back when nothing usable was supplied', () => {
    expect(safeNextPath(null)).toBe('/workspace');
    expect(safeNextPath(undefined)).toBe('/workspace');
    expect(safeNextPath('')).toBe('/workspace');
    expect(safeNextPath('/x', '/reset-password')).toBe('/x');
    expect(safeNextPath(null, '/reset-password')).toBe('/reset-password');
  });

  // Each of these is a real way to leave the origin while still "starting
  // with a slash" or otherwise passing a naive check.
  it.each([
    ['absolute url', 'https://evil.example'],
    ['protocol-relative', '//evil.example'],
    ['protocol-relative via backslash', '/\\evil.example'],
    ['backslash in authority', '/\\\\evil.example/path'],
    ['scheme', 'javascript:alert(1)'],
    ['no leading slash', 'workspace'],
    ['tab-smuggled scheme', '/\tjavascript:alert(1)'],
    ['newline-smuggled', '/\nhttps://evil.example'],
    ['null byte', '/work\u0000space'],
  ])('refuses %s', (_label, candidate) => {
    expect(safeNextPath(candidate)).toBe('/workspace');
  });

  it('refuses an absurdly long path rather than reflecting it', () => {
    expect(safeNextPath(`/${'a'.repeat(600)}`)).toBe('/workspace');
  });
});

describe('isLoopbackOrigin', () => {
  it('recognises developer machines', () => {
    expect(isLoopbackOrigin('http://localhost:3000')).toBe(true);
    expect(isLoopbackOrigin('http://127.0.0.1:3000')).toBe(true);
    expect(isLoopbackOrigin('http://[::1]:3000')).toBe(true);
  });

  it('does not flag a real deployment', () => {
    expect(isLoopbackOrigin('https://localbasic.vercel.app')).toBe(false);
    // A hostname that merely contains "localhost" is not loopback.
    expect(isLoopbackOrigin('https://localhost.evil.example')).toBe(false);
  });

  it('treats an unparseable origin as not-loopback rather than throwing', () => {
    expect(isLoopbackOrigin('Site URL https://localbasic.vercel.app')).toBe(false);
  });
});

describe('recoveryRedirectUrl', () => {
  const origin = 'https://localbasic.vercel.app';

  it('points at the shared callback with a validated next', () => {
    expect(recoveryRedirectUrl('/reset-password', origin)).toBe(
      'https://localbasic.vercel.app/callback?next=%2Freset-password',
    );
  });

  it('never emits an off-origin next, even when asked', () => {
    expect(recoveryRedirectUrl('https://evil.example', origin)).toBe(
      'https://localbasic.vercel.app/callback?next=%2Freset-password',
    );
    expect(recoveryRedirectUrl('//evil.example', origin)).toBe(
      'https://localbasic.vercel.app/callback?next=%2Freset-password',
    );
  });

  it('tolerates a trailing slash on the configured origin', () => {
    expect(recoveryRedirectUrl('/reset-password', `${origin}/`)).toBe(
      'https://localbasic.vercel.app/callback?next=%2Freset-password',
    );
  });
});

describe('appOrigin', () => {
  const realVercelUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL;

  afterEach(() => {
    clientEnv.NEXT_PUBLIC_APP_URL = 'https://localbasic.vercel.app';
    if (realVercelUrl === undefined) delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    else process.env.VERCEL_PROJECT_PRODUCTION_URL = realVercelUrl;
  });

  it('uses the configured application URL, not a request header', () => {
    expect(appOrigin()).toBe('https://localbasic.vercel.app');
    expect(appOriginSource()).toBe('NEXT_PUBLIC_APP_URL');
  });

  // The production failure: NEXT_PUBLIC_APP_URL is inlined at build time, so an
  // unset variable becomes localhost and recovery silently refuses to send.
  it('falls back to the platform domain when the app URL was never configured', () => {
    clientEnv.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';
    process.env.VERCEL_PROJECT_PRODUCTION_URL = 'localbasic.vercel.app';

    expect(appOrigin()).toBe('https://localbasic.vercel.app');
    expect(isLoopbackOrigin(appOrigin())).toBe(false);
    expect(appOriginSource()).toBe('VERCEL_PROJECT_PRODUCTION_URL');
  });

  it('still prefers an explicitly configured URL over the platform domain', () => {
    process.env.VERCEL_PROJECT_PRODUCTION_URL = 'ignored.vercel.app';
    expect(appOrigin()).toBe('https://localbasic.vercel.app');
  });

  it('stays on localhost in development, where that is correct', () => {
    clientEnv.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;

    expect(appOrigin()).toBe('http://localhost:3000');
    expect(appOriginSource()).toBe('fallback');
  });

  it('builds a usable recovery URL from the platform fallback', () => {
    clientEnv.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';
    process.env.VERCEL_PROJECT_PRODUCTION_URL = 'localbasic.vercel.app';

    expect(recoveryRedirectUrl('/reset-password', appOrigin())).toBe(
      'https://localbasic.vercel.app/callback?next=%2Freset-password',
    );
  });
});
