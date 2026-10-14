/**
 * Remembering an order that is waiting for WhatsApp verification, so a
 * refresh, a closed tab, or the browser reloading the page when the guest
 * comes back from WhatsApp does not lose it.
 *
 * Only the order's status TOKEN is kept on the device, with the time it was
 * saved — never the phone, the name or the code. The token is the same
 * capability the guest's own tracking link already carries, and everything
 * else (status, code, expiry) is read back from the server on restore, so a
 * stale or edited record can never show something the server did not say.
 *
 * Pure functions over a Storage-like object, so they are unit-tested without
 * a browser; the hook in use-pending-verification.ts wires them to React.
 */

export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export type VerificationInfo = {
  status: string;
  code: string | null;
  whatsapp: string | null;
  expiresAt: string | null;
};

export type VerificationCheck =
  | { ok: true; data: VerificationInfo }
  | { ok: false; code: 'not_found' | 'rate_limited' | 'failed' | string; error: string };

const PREFIX = 'lb-pending-verify:';
/** A pending order older than this is not worth restoring. */
export const MAX_PENDING_AGE_MS = 3 * 60 * 60 * 1000;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{16,200}$/;

const keyFor = (scopeKey: string) => `${PREFIX}${scopeKey}`;

export function savePending(storage: StorageLike | null, scopeKey: string, token: string, now = Date.now()): void {
  if (!storage || !TOKEN_SHAPE.test(token)) return;
  try {
    storage.setItem(keyFor(scopeKey), JSON.stringify({ token, savedAt: now }));
  } catch {
    // Full or blocked storage: this page view still works, it just will not
    // survive a reload — the same as before this existed.
  }
}

export function loadPending(storage: StorageLike | null, scopeKey: string, now = Date.now()): string | null {
  if (!storage) return null;
  let raw: string | null = null;
  try {
    raw = storage.getItem(keyFor(scopeKey));
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { token?: unknown; savedAt?: unknown };
    const fresh = typeof parsed.savedAt === 'number' && now - parsed.savedAt >= 0 && now - parsed.savedAt < MAX_PENDING_AGE_MS;
    if (typeof parsed.token === 'string' && TOKEN_SHAPE.test(parsed.token) && fresh) return parsed.token;
  } catch {
    // Not ours, or edited by hand: drop it below.
  }
  clearPending(storage, scopeKey);
  return null;
}

export function clearPending(storage: StorageLike | null, scopeKey: string): void {
  try {
    storage?.removeItem(keyFor(scopeKey));
  } catch {
    // Nothing to do: a blocked store has nothing saved either.
  }
}

/** What the page should do with one answer from the server. */
export type Decision =
  | { kind: 'pending'; code: string; expiresAt: string | null }
  | { kind: 'confirmed' }   // past verification (or cancelled): hand over to the status banner
  | { kind: 'gone' }        // the order no longer exists for this token: forget it
  | { kind: 'retry'; error: string }; // a passing failure: keep everything, try again later

export function decide(result: VerificationCheck): Decision {
  if (!result.ok) {
    return result.code === 'not_found' ? { kind: 'gone' } : { kind: 'retry', error: result.error };
  }
  if (result.data.status !== 'pending_verification') return { kind: 'confirmed' };
  // Still waiting. Without a code there is nothing to show the guest.
  return result.data.code
    ? { kind: 'pending', code: result.data.code, expiresAt: result.data.expiresAt }
    : { kind: 'retry', error: 'تعذّر قراءة رمز التحقق.' };
}

/** Poll every few seconds while the code can still be used, then slowly (the cashier may still confirm by hand). */
export const POLL_MS = 5_000;
export const SLOW_POLL_MS = 30_000;

export function isExpired(expiresAt: string | null, now = Date.now()): boolean {
  if (!expiresAt) return false;
  const t = Date.parse(expiresAt);
  return Number.isFinite(t) && t <= now;
}

/** How long to wait after the last check before the next automatic one. */
export function nextPollDelay(expiresAt: string | null, now = Date.now()): number {
  return isExpired(expiresAt, now) ? SLOW_POLL_MS : POLL_MS;
}
