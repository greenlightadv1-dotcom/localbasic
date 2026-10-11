/**
 * The device side of "recognised vs. new device".
 *
 * Zero-cost by design: a random id persisted in this browser's localStorage,
 * not a fingerprinting library. It proves nothing about the hardware — a
 * cleared store or a different browser is simply a new device — but that is
 * the intended cost of making verification required again, and it needs no
 * paid API to work at all.
 */
const KEY = 'lb-device-id';

export function getDeviceId(): string {
  try {
    const existing = localStorage.getItem(KEY);
    if (existing) return existing;
    const id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
    return id;
  } catch {
    // Private browsing or a blocked store: a fresh id every time, which just
    // means this visit is never "recognised" — the same outcome a first-time
    // guest already gets.
    return crypto.randomUUID();
  }
}
