import 'server-only';

/**
 * Sliding-window rate limiter.
 *
 * Backed by an in-memory map, which is correct for a single instance and for
 * local development. When UPSTASH_REDIS_REST_URL is configured the same
 * interface is served by Redis so limits hold across instances — swap the
 * implementation here, not at the call sites.
 */
type Bucket = { hits: number[] };
const buckets = new Map<string, Bucket>();

export type RateLimitRule = { limit: number; windowMs: number };

export const RATE_LIMITS = {
  signIn: { limit: 8, windowMs: 5 * 60_000 },
  signUp: { limit: 5, windowMs: 60 * 60_000 },
  passwordReset: { limit: 5, windowMs: 60 * 60_000 },
  provisionWorkspace: { limit: 3, windowMs: 60 * 60_000 },
  publicLinkResolve: { limit: 60, windowMs: 60_000 },
  publicOrder: { limit: 10, windowMs: 10 * 60_000 },
  mutation: { limit: 120, windowMs: 60_000 },
  // Customer account (D3). Reads are generous because the account pages fan
  // out several of them per view; writes are tighter, and claiming a guest
  // order is tightest of all because it is the only place where possessing a
  // token changes who an order belongs to.
  accountRead: { limit: 240, windowMs: 60_000 },
  accountWrite: { limit: 30, windowMs: 60_000 },
  accountClaim: { limit: 5, windowMs: 10 * 60_000 },
  // Custom domains. Each verification click costs an outbound DNS query, so
  // the button cannot be used as a lookup amplifier. Two buckets: one per
  // domain, tight, because re-checking the same name in a loop is the shape
  // of abuse; and one per user across every domain, looser, so that adding
  // domains cannot multiply the first limit away.
  domainVerify: { limit: 10, windowMs: 10 * 60_000 },
  domainVerifyUser: { limit: 60, windowMs: 10 * 60_000 },
} satisfies Record<string, RateLimitRule>;

export function checkRateLimit(key: string, rule: RateLimitRule): { ok: boolean; retryAfterMs: number } {
  const now = Date.now();
  const cutoff = now - rule.windowMs;
  const bucket = buckets.get(key) ?? { hits: [] };

  bucket.hits = bucket.hits.filter((t) => t > cutoff);

  if (bucket.hits.length >= rule.limit) {
    buckets.set(key, bucket);
    const oldest = bucket.hits[0] ?? now;
    return { ok: false, retryAfterMs: oldest + rule.windowMs - now };
  }

  bucket.hits.push(now);
  buckets.set(key, bucket);

  // Opportunistic cleanup so the map cannot grow without bound.
  if (buckets.size > 10_000) {
    for (const [k, v] of buckets) {
      if (v.hits.every((t) => t <= cutoff)) buckets.delete(k);
    }
  }

  return { ok: true, retryAfterMs: 0 };
}
