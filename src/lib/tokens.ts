import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

/**
 * Opaque public-link token: 32 CSPRNG bytes, base64url.
 *
 * Not a UUID — UUIDs are guessable in bulk and leak creation ordering, and a
 * printed QR code is a token an attacker can study at leisure.
 */
export function generatePublicToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Invitation tokens are stored hashed; the raw value only ever goes by email. */
export function generateInviteToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function safeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** URL-safe slug from a business name, Arabic included. */
export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[ـً-ٟ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}
