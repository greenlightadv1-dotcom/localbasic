'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import { getClientIp } from '@/lib/action';

export type AuthFormState = { error?: string } | undefined;

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
