import { z } from 'zod';

/**
 * Username login.
 *
 * Supabase Auth identifies an account by email, so a username is mapped to a
 * deterministic internal address that is never shown, mailed or typed by a
 * person. `auth.users.email` is unique platform-wide, which makes the username
 * unique platform-wide for free: a second account with the same username fails
 * at creation exactly like a duplicate email would.
 */
export const LOGIN_EMAIL_DOMAIN = 'login.localbasic.internal';

export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,31}$/;

export const usernameField = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    USERNAME_PATTERN,
    'اسم المستخدم 3–32 حرفًا: حروف إنجليزية صغيرة وأرقام و . _ - فقط',
  );

export function usernameToEmail(username: string): string {
  return `${username.trim().toLowerCase()}@${LOGIN_EMAIL_DOMAIN}`;
}

/**
 * What the sign-in form submits. An identifier containing "@" is a real email
 * (platform admins and accounts that predate usernames) and is used as typed;
 * anything else is a username.
 */
export function identifierToEmail(identifier: string): string {
  const v = identifier.trim().toLowerCase();
  return v.includes('@') ? v : usernameToEmail(v);
}
