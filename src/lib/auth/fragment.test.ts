import { describe, expect, it } from 'vitest';
import { landingPathForType, parseAuthFragment } from './fragment';

describe('parseAuthFragment', () => {
  it('reads the tokens a recovery link leaves in the fragment', () => {
    const result = parseAuthFragment(
      '#access_token=header.payload.sig&expires_in=3600&refresh_token=r3fr35h' +
        '&token_type=bearer&type=recovery',
    );
    expect(result).toEqual({
      kind: 'session',
      accessToken: 'header.payload.sig',
      refreshToken: 'r3fr35h',
      type: 'recovery',
    });
  });

  it('reads a magic-link fragment too, keeping its type', () => {
    const result = parseAuthFragment('#access_token=a&refresh_token=b&type=magiclink');
    expect(result).toEqual({
      kind: 'session',
      accessToken: 'a',
      refreshToken: 'b',
      type: 'magiclink',
    });
  });

  it('surfaces an expired link rather than looking like nothing happened', () => {
    const result = parseAuthFragment(
      '#error=access_denied&error_code=otp_expired' +
        '&error_description=Email+link+is+invalid+or+has+expired',
    );
    expect(result).toEqual({ kind: 'error', code: 'otp_expired' });
  });

  it('falls back to the generic error when no error_code is given', () => {
    expect(parseAuthFragment('#error=access_denied')).toEqual({
      kind: 'error',
      code: 'access_denied',
    });
  });

  it('ignores fragments that are not Supabase auth', () => {
    expect(parseAuthFragment('')).toEqual({ kind: 'none' });
    expect(parseAuthFragment('#')).toEqual({ kind: 'none' });
    expect(parseAuthFragment('#section-pricing')).toEqual({ kind: 'none' });
    expect(parseAuthFragment(null)).toEqual({ kind: 'none' });
    expect(parseAuthFragment(undefined)).toEqual({ kind: 'none' });
  });

  it('refuses a half-present session rather than guessing', () => {
    expect(parseAuthFragment('#access_token=a&type=recovery')).toEqual({ kind: 'none' });
    expect(parseAuthFragment('#refresh_token=b&type=recovery')).toEqual({ kind: 'none' });
  });
});

describe('landingPathForType', () => {
  it('sends a recovery link to the password form, never to the workspace', () => {
    expect(landingPathForType('recovery')).toBe('/reset-password');
  });

  it('sends every other link to the workspace', () => {
    expect(landingPathForType('magiclink')).toBe('/workspace');
    expect(landingPathForType('signup')).toBe('/workspace');
    expect(landingPathForType('')).toBe('/workspace');
  });
});
