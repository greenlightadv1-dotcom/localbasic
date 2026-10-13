import { describe, expect, it } from 'vitest';
import { identifierToEmail, usernameField, usernameToEmail } from './username';

describe('username login', () => {
  it('maps a username to the internal login address, case-insensitively', () => {
    expect(usernameToEmail(' Ahmed.K ')).toBe('ahmed.k@login.localbasic.internal');
    expect(identifierToEmail('Ahmed.K')).toBe('ahmed.k@login.localbasic.internal');
  });

  it('keeps a real email as typed (platform admins, older accounts)', () => {
    expect(identifierToEmail(' Owner@Example.com ')).toBe('owner@example.com');
  });

  it('accepts and rejects usernames', () => {
    expect(usernameField.safeParse('cashier_1').success).toBe(true);
    expect(usernameField.safeParse('AB').success).toBe(false);
    expect(usernameField.safeParse('has space').success).toBe(false);
    expect(usernameField.safeParse('a@b.com').success).toBe(false);
    expect(usernameField.safeParse('محمد').success).toBe(false);
  });
});
