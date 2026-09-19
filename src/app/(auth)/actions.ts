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

const emailOnly = z.object({ email: z.string().email('بريد إلكتروني غير صحيح') });

const newPassword = z
  .object({
    password: z.string().min(8, 'كلمة المرور 8 أحرف على الأقل').max(72, 'كلمة المرور طويلة جدًا'),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, {
    message: 'كلمتا المرور غير متطابقتين',
    path: ['confirm'],
  });

/**
 * The answer is the same whether or not the address has an account.
 *
 * A "no such user" here would turn the form into a membership oracle for every
 * email someone cares to try — the same reason sign-in has one generic error.
 */
const RESET_SENT_NOTICE =
  'لو كان هذا البريد مسجّلًا، هنبعتلك رابط لإعادة تعيين كلمة المرور. راجع بريدك.';

export async function requestPasswordResetAction(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const parsed = emailOnly.safeParse({ email: formData.get('email') });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'بريد إلكتروني غير صحيح' };

  const email = parsed.data.email.toLowerCase();

  // Two buckets: one per address so a single account cannot be mail-bombed,
  // one per IP so a script cannot walk a list of addresses.
  for (const key of [`reset:ip:${getClientIp()}`, `reset:email:${email}`]) {
    if (!checkRateLimit(key, RATE_LIMITS.passwordReset).ok) {
      return { error: 'محاولات كثيرة. برجاء المحاولة بعد قليل.' };
    }
  }

  // Refuse to mail a link nobody can open. Without this an unset
  // NEXT_PUBLIC_APP_URL in production sends a working, single-use token
  // pointing at http://localhost:3000 and burns it on a dead page.
  const origin = appOrigin();
  if (process.env.NODE_ENV === 'production' && isLoopbackOrigin(origin)) {
    return { error: 'إعداد الموقع غير مكتمل. تواصل مع الدعم.' };
  }

  const supabase = createSupabaseServerClient();
  await supabase.auth.resetPasswordForEmail(parsed.data.email, {
    redirectTo: recoveryRedirectUrl('/reset-password', origin),
  });

  // The result is discarded on purpose — see RESET_SENT_NOTICE.
  return { notice: RESET_SENT_NOTICE };
}

export async function updatePasswordAction(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const parsed = newPassword.safeParse({
    password: formData.get('password'),
    confirm: formData.get('confirm'),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'تحقق من البيانات المدخلة.' };
  }

  const supabase = createSupabaseServerClient();

  // The recovery link is what produced this session. No session means the link
  // was invalid, already used, or expired.
  const { data, error: userError } = await supabase.auth.getUser();
  if (userError || !data?.user) {
    return { error: 'رابط الاستعادة غير صالح أو منتهي الصلاحية. اطلب رابطًا جديدًا.' };
  }

  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
  if (error) return { error: 'تعذّر تحديث كلمة المرور. جرّب رابطًا جديدًا.' };

  redirect('/workspace');
}
