import 'server-only';

/**
 * Sliding-window rate limiter.
 *
 * IN-MEMORY ONLY. There is no shared backend behind this, today.
 *
 * The map lives in one process, so a limit holds for exactly as long as that
 * process does and only for the requests it happens to receive. On a single
 * long-lived server that is a real limit. On Vercel it is much weaker than it
 * looks: each serverless instance keeps its own map, instances scale out under
 * load — which is precisely when an attacker is applying it — and a cold start
 * begins with an empty one. Treat these numbers as a brake on casual abuse
 * from one client, not as a guarantee.
 *
 * UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are read by the env
 * schema and RESERVED for a shared implementation. Nothing reads them yet:
 * setting them changes nothing. A previous version of this comment said Redis
 * took over when they were configured, which was never true — the note is
 * corrected rather than the behaviour, because wiring a new backend is not a
 * change to make quietly.
 *
 * Where a limit genuinely has to hold across instances, that backend has to
 * exist first. Swap the implementation here, not at the call sites.
 *
 * Partly compensating today, and worth knowing before relying on either:
 *   * `signIn`, `signUp` and `passwordReset` sit in front of Supabase Auth,
 *     which applies its own server-side limits per project;
 *   * `publicOrder` and `storeCheckout` have no such backstop — the database
 *     constraints stop bad orders, not repeated ones.
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
  // Retail storefront checkout. Looser than `publicOrder` on purpose: a retail
  // shop's customers arrive from mobile carriers and office networks, where
  // many genuine buyers share one address, and a restaurant's 10-per-10-minutes
  // would refuse real orders. Still a real cap — a script cannot sit on the
  // endpoint — and stock is protected by the ledger regardless.
  storeCheckout: { limit: 30, windowMs: 10 * 60_000 },
  // Minting a signed Storage upload ticket / deleting an old file — no file
  // bytes cross this limit, only the small per-call round trip, so it can
  // afford to be generous (a product-image screen can fire many in one
  // session) while still capping a runaway client.
  mediaUpload: { limit: 60, windowMs: 10 * 60_000 },
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
