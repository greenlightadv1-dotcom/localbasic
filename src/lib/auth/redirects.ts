import { clientEnv } from '@/lib/env';

/**
 * Where the application lives, as an absolute origin with no trailing slash.
 *
 * Deliberately read from configuration and never from the request's `Host`
 * header. A password-reset link is the one place where believing an attacker-
 * supplied host would be catastrophic: it would mint a genuine, single-use
 * recovery token and mail it to the victim pointing at the attacker's domain.
 * Configuration cannot be spoofed by a request, so configuration wins.
 */
export function appOrigin(): string {
  return clientEnv.NEXT_PUBLIC_APP_URL.replace(/\/+$/, '');
}

/** Is this origin a developer machine rather than a reachable deployment? */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

/**
 * Reduce a caller-supplied `next` to a path this origin can safely redirect to.
 *
 * Anything that a browser could read as naming another origin is discarded
 * rather than repaired, because a redirect carrying a freshly minted session is
 * exactly what an open redirect is worth stealing.
 *
 * The cases that matter, none of which a bare `startsWith('/')` catches:
 *   * `//evil.com` and `/\evil.com` — both scheme-relative to a browser;
 *   * a backslash anywhere in the authority, which browsers normalise to `/`;
 *   * control characters, which are stripped before the URL is parsed, so
 *     `/\tjavascript:…` and friends become live schemes after the check.
 */
export function safeNextPath(
  next: string | null | undefined,
  fallback = '/workspace',
): string {
  if (typeof next !== 'string' || next.length === 0 || next.length > 512) return fallback;
  if (!next.startsWith('/')) return fallback;
  if (next.startsWith('//')) return fallback;
  if (next.includes('\\')) return fallback;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(next)) return fallback;
  return next;
}

/**
 * The absolute URL Supabase should send a recovery link back to.
 *
 * It points at `/callback`, which is the single place that exchanges a code for
 * a session, so recovery reuses the confirmation flow rather than introducing a
 * second one. `next` rides along as a validated relative path.
 */
export function recoveryRedirectUrl(
  next = '/reset-password',
  origin: string = appOrigin(),
): string {
  const target = safeNextPath(next, '/reset-password');
  return `${origin.replace(/\/+$/, '')}/callback?next=${encodeURIComponent(target)}`;
}
