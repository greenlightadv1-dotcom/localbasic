'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import { getClientIp } from '@/lib/action';
import { identifierToEmail } from '@/lib/auth/username';
import { mustChangePassword } from '@/lib/auth/password-gate';
import { clearMustChangePassword } from '@/modules/core/members/credentials';

export type AuthFormState = { error?: string; notice?: string } | undefined;

const credentials = z.object({
  // A username (staff, restaurant owners) or, for platform admins and accounts
  // that predate usernames, an email. See lib/auth/username.
  identifier: z.string().trim().min(3).max(200),
  password: z.string().min(6).max(72),
});

/**
 * Sign-in failures always return the same message whether the account is
 * unknown or the password is wrong. Distinguishing them would turn the form
 * into a user-enumeration oracle.
 */
const GENERIC_CREDENTIALS_ERROR = 'بيانات الدخول غير صحيحة.';

export async function signInAction(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const parsed = credentials.safeParse({
    identifier: formData.get('identifier'),
    password: formData.get('password'),
  });
  if (!parsed.success) return { error: GENERIC_CREDENTIALS_ERROR };

  const email = identifierToEmail(parsed.data.identifier);

  // Limited by IP and by identifier, so neither a password-spray across many
  // accounts nor a brute force against one gets many attempts.
  const ip = getClientIp();
  for (const key of [`signin:ip:${ip}`, `signin:email:${email}`]) {
    if (!checkRateLimit(key, RATE_LIMITS.signIn).ok) {
      return { error: 'محاولات كثيرة. برجاء المحاولة بعد قليل.' };
    }
  }

  const supabase = createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password: parsed.data.password });
  if (error) return { error: GENERIC_CREDENTIALS_ERROR };

  // /workspace sends an account holding a temporary password to
  // /change-password before anything else.
  redirect('/workspace');
}

export async function signOutAction() {
  const supabase = createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect('/sign-in');
}

// ---------------------------------------------------------------------------
// Mandatory password change.
//
// There is no self-service password reset or recovery any more. Staff passwords
// are assigned by their admin; restaurant-owner passwords by the platform, who
// hand over a TEMPORARY one (profiles.must_change_password = true, migration
// 0088). This is the only path by which a user changes their own password, and
// it is open only while that flag is set — so a staff member, whose flag is
// never set, cannot use it.
// ---------------------------------------------------------------------------

const newPassword = z
  .object({
    password: z.string().min(8).max(72),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm);

export async function changePasswordAction(formData: FormData): Promise<void> {
  const parsed = newPassword.safeParse({
    password: formData.get('password'),
    confirm: formData.get('confirm'),
  });
  if (!parsed.success) redirect('/change-password?status=invalid');

  const supabase = createSupabaseServerClient();
  const { data, error: userError } = await supabase.auth.getUser();
  if (userError || !data?.user) redirect('/sign-in');

  if (!(await mustChangePassword())) {
    // Nothing asked this account to choose a new password. Staff land here.
    redirect('/workspace');
  }

  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
  if (error) {
    console.log(`[PASSWORD_CHANGE] update_failed ${error.message}`);
    redirect('/change-password?status=failed');
  }

  try {
    await clearMustChangePassword(data.user.id);
  } catch {
    // The password changed but the flag could not be cleared; send them back
    // rather than let them into the app with the gate still set.
    redirect('/change-password?status=failed');
  }

  redirect('/workspace');
}
