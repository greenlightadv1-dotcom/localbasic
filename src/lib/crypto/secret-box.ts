import 'server-only';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM envelope for credentials stored in the database.
 *
 * The key comes from PAYMENT_CREDENTIALS_KEY (any string of 32+ characters;
 * it is hashed to 32 bytes) and lives only in the application environment, so
 * a database dump alone reveals nothing. With the variable unset, sealing
 * throws: credentials are never stored in the clear as a fallback.
 *
 * Format: "v1:" + base64(iv[12] | tag[16] | ciphertext).
 */
const VERSION = 'v1';

export class SecretBoxUnavailableError extends Error {
  constructor() {
    super('PAYMENT_CREDENTIALS_KEY is not configured');
    this.name = 'SecretBoxUnavailableError';
  }
}

function keyFrom(secret: string | undefined): Buffer {
  const value = secret?.trim();
  if (!value || value.length < 32) throw new SecretBoxUnavailableError();
  return createHash('sha256').update(value).digest();
}

export function sealSecret(plaintext: string, secret = process.env.PAYMENT_CREDENTIALS_KEY): string {
  const key = keyFrom(secret);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `${VERSION}:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')}`;
}

export function openSecret(sealed: string, secret = process.env.PAYMENT_CREDENTIALS_KEY): string {
  const key = keyFrom(secret);
  const [version, payload] = sealed.split(':');
  if (version !== VERSION || !payload) throw new Error('unrecognised secret format');
  const raw = Buffer.from(payload, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}
