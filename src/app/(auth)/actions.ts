'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import { getClientIp } from '@/lib/action';
import { appOrigin, isLoopbackOrigin, recoveryRedirectUrl } from '@/lib/auth/redirects';

export type AuthFormState = { error?: string; notice?: string } | undefined;

const credentials = z.object({
  email: z.string().email('بريد إلكتروني غير صحيح'),
  password: z.string().min(8, 'كلمة المرور 8 أحرف على الأقل'),
});

const signUpInput = credentials.extend({
  fullName: z.string().min(2, 'الاسم مطلوب').max(120),
});

/**
 * Sign-in failures always return the same message whether the email is unknown
 * or the password is wrong. Distinguishing them would turn the form into a
 * user-enumeration oracle.
 */
const GENERIC_CREDENTIALS_ERROR = 'بيانات الدخول غير صحيحة.';

export async function signInAction(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const parsed = credentials.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  });
  if (!parsed.success) return { error: GENERIC_CREDENTIALS_ERROR };

  // Limited by IP and by identifier, so neither a password-spray across many
  // accounts nor a brute force against one gets many attempts.
  const ip = getClientIp();
  for (const key of [`signin:ip:${ip}`, `signin:email:${parsed.data.email.toLowerCase()}`]) {
    if (!checkRateLimit(key, RATE_LIMITS.signIn).ok) {
      return { error: 'محاولات كثيرة. برجاء المحاولة بعد قليل.' };
    }
  }

  const supabase = createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) return { error: GENERIC_CREDENTIALS_ERROR };

  redirect('/workspace');
}

export async function signUpAction(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const parsed = signUpInput.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
    fullName: formData.get('fullName'),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'تحقق من البيانات المدخلة.' };
  }

  if (!checkRateLimit(`signup:ip:${getClientIp()}`, RATE_LIMITS.signUp).ok) {
    return { error: 'محاولات كثيرة. برجاء المحاولة بعد قليل.' };
  }

  const supabase = createSupabaseServerClient();
  const { error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: { data: { full_name: parsed.data.fullName } },
  });

  // Signing up with an address that already exists must not confirm that fact.
  if (error) return { error: 'تعذّر إنشاء الحساب. تحقق من البيانات أو سجّل الدخول.' };

  redirect('/onboarding');
}

export async function signOutAction() {
  const supabase = createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect('/sign-in');
}

// ---------------------------------------------------------------------------
// Password recovery.
//
// Uses Supabase's own recovery flow end to end: resetPasswordForEmail() mints
// the token and mails it, /callback exchanges the code for a session exactly as
// it does for a sign-up confirmation, and updateUser() sets the new password
// against that session. No second auth system, no service-role key, and
// nothing writes auth.users directly.
// ---------------------------------------------------------------------------

const emailOnly = z.object({ email: z.string().email() });

const newPassword = z
  .object({
    password: z.string().min(8).max(72),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm);

/**
 * A short id that ties the lines of one submission together in the server log.
 * Not a secret and not derived from anything about the person.
 */
function correlationId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** Server-log breadcrumb. Never carries an address, token, cookie or key. */
function trace(id: string, step: string, detail?: string) {
  console.log(`[RECOVERY_DEBUG] ${id} ${step}${detail ? ` ${detail}` : ''}`);
}

/**
 * Request a recovery link.
 *
 * A plain Server Action taking FormData, invoked by `<form action={...}>` in a
 * Server Component. No useFormState, no useFormStatus, no client component:
 * the form posts natively, so it works with JavaScript disabled, blocked by a
 * content security policy, or simply not yet hydrated. The previous version
 * depended on hydration, and when the policy blocked the page's scripts the
 * button silently did nothing at all — no request, no error, no email.
 *
 * The outcome is carried back in the query string rather than component state,
 * which keeps the whole path server-side and makes the page dynamic.
 */
export async function requestPasswordResetAction(formData: FormData): Promise<void> {
  const id = correlationId();
  trace(id, 'submit_received');

  const parsed = emailOnly.safeParse({ email: formData.get('email') });
  if (!parsed.success) {
    trace(id, 'validation_failed');
    redirect('/forgot-password?status=invalid');
  }
  trace(id, 'validation_passed');

  const email = parsed.data.email.toLowerCase();

  // Two buckets: one per address so a single account cannot be mail-bombed,
  // one per IP so a script cannot walk a list of addresses.
  for (const key of [`reset:ip:${getClientIp()}`, `reset:email:${email}`]) {
    if (!checkRateLimit(key, RATE_LIMITS.passwordReset).ok) {
      trace(id, 'rate_limited');
      redirect('/forgot-password?status=rate_limited');
    }
  }

  const origin = appOrigin();
  trace(id, 'origin_resolved', origin);

  // Refuse to mail a link nobody can open, rather than burning a single-use
  // token on a machine only the developer can reach.
  if (process.env.NODE_ENV === 'production' && isLoopbackOrigin(origin)) {
    trace(id, 'origin_unusable');
    redirect('/forgot-password?status=unconfigured');
  }

  const redirectTo = recoveryRedirectUrl(origin);
  trace(id, 'calling_supabase', redirectTo);

  const supabase = createSupabaseServerClient();
  const { error } = await supabase.auth.resetPasswordForEmail(parsed.data.email, { redirectTo });

  // Never swallowed. The message is logged, the address is not.
  if (error) {
    trace(id, 'supabase_result error', `${error.status ?? ''} ${error.message}`.trim());
    redirect('/forgot-password?status=failed');
  }

  trace(id, 'supabase_result ok');
  redirect('/forgot-password?status=sent');
}

/**
 * Set the new password against the session the recovery link produced.
 *
 * Also a plain FormData action, for the same reason: this page is the last step
 * of a flow whose whole purpose is to let someone back in, so it must not
 * depend on client JavaScript running.
 */
export async function updatePasswordAction(formData: FormData): Promise<void> {
  const parsed = newPassword.safeParse({
    password: formData.get('password'),
    confirm: formData.get('confirm'),
  });
  if (!parsed.success) {
    redirect('/reset-password?status=invalid');
  }

  const supabase = createSupabaseServerClient();

  // The recovery link is what produced this session. No session means the link
  // was invalid, already used, or expired.
  const { data, error: userError } = await supabase.auth.getUser();
  if (userError || !data?.user) {
    redirect('/reset-password?status=expired');
  }

  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
  if (error) {
    console.log(`[RECOVERY_DEBUG] update_password_failed ${error.message}`);
    redirect('/reset-password?status=failed');
  }

  redirect('/workspace');
}
