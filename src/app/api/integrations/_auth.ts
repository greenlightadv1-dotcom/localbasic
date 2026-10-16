import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { checkRateLimit } from '@/lib/rate-limit';

/**
 * Bearer-key extraction shared by the intake routes. The key is never
 * looked up here: the database finds the integration by the key's hash and
 * answers 28000 for anything unknown or switched off.
 */
export function bearerKey(req: NextRequest): string | null {
  const h = req.headers.get('authorization') ?? '';
  const m = /^Bearer\s+(lbk_[A-Za-z0-9_-]{16,})$/.exec(h.trim());
  return m?.[1] ?? null;
}

/** Per-key throttle; a misbehaving aggregator cannot flood the kitchen. */
export function throttled(key: string, limit: number): NextResponse | null {
  const { ok, retryAfterMs } = checkRateLimit(`intake:${key.slice(0, 16)}`, { limit, windowMs: 60_000 });
  if (ok) return null;
  return NextResponse.json({ error: 'rate limited' }, { status: 429, headers: { 'retry-after': String(Math.ceil(retryAfterMs / 1000)) } });
}

export const unauthorized = () => NextResponse.json({ error: 'invalid key' }, { status: 401, headers: { 'www-authenticate': 'Bearer' } });
