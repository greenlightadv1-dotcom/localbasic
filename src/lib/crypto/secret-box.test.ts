import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const KEY = 'k'.repeat(40);

describe('secret-box', () => {
  it('round-trips and never leaks the plaintext', async () => {
    const { sealSecret, openSecret } = await import('./secret-box');
    const sealed = sealSecret('sk_live_ABC123', KEY);
    expect(sealed.startsWith('v1:')).toBe(true);
    expect(sealed).not.toContain('sk_live');
    expect(openSecret(sealed, KEY)).toBe('sk_live_ABC123');
  });

  it('uses a fresh IV each time', async () => {
    const { sealSecret } = await import('./secret-box');
    expect(sealSecret('same', KEY)).not.toBe(sealSecret('same', KEY));
  });

  it('rejects a wrong key and tampered data', async () => {
    const { sealSecret, openSecret } = await import('./secret-box');
    const sealed = sealSecret('x', KEY);
    expect(() => openSecret(sealed, 'z'.repeat(40))).toThrow();
    const tampered = sealed.slice(0, -2) + (sealed.endsWith('A') ? 'B=' : 'A=');
    expect(() => openSecret(tampered, KEY)).toThrow();
  });

  it('fails closed without a usable key', async () => {
    const { sealSecret, SecretBoxUnavailableError } = await import('./secret-box');
    expect(() => sealSecret('x', undefined)).toThrow(SecretBoxUnavailableError);
    expect(() => sealSecret('x', 'short')).toThrow(SecretBoxUnavailableError);
  });
});
