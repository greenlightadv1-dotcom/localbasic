'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import { getClientIp } from '@/lib/action';
import { AppError } from '@/lib/errors';
import {
  addFavorite, claimGuestOrder, deleteAddress, removeFavorite,
  saveAddress, saveProfile, saveSettings,
} from '@/modules/restaurant/account/service';

export type AccountState = { error?: string; ok?: string } | undefined;

const slug = z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,62}$/i);

function slugOf(formData: FormData): string {
  const parsed = slug.safeParse(formData.get('orgSlug'));
  if (!parsed.success) throw new AppError('not_found');
  return parsed.data.toLowerCase();
}

/**
 * Customer authentication.
 *
 * Deliberately separate from the staff actions in (auth)/actions.ts, which
 * send a new account to /onboarding — the flow that creates a workspace.
 * A customer must never land there: signing up to order dinner does not make
 * anyone the owner of an organization, and these actions return the customer
 * to the restaurant they were already looking at.
 *
 * Nothing here grants membership. Supabase Auth issues the session; the
 * organization-scoped customer row is created by the database on first use,
 * and there is no code path from either to organization_members.
 *
 * PHONE IS THE IDENTITY (0077), not email. auth.users.phone is unique
 * platform-wide the same way auth.users.email already was — Supabase Auth
 * enforces it, this file does not have to. Email and a starting address stay
 * collectible at sign-up, but only as optional contact details saved onto
 * the profile/address book once the phone is verified — never as a second
 * way to sign in.
 */

/**
 * E.164-ish: a leading +, then 8–15 digits total. Loose on purpose — the SMS
 * provider is what actually judges deliverability; this only keeps obviously
 * malformed input from reaching Supabase Auth at all. Spaces and dashes are
 * stripped first, so "+20 100 123 4567" and "+201001234567" both pass.
 */
const phoneNumber = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s-]/g, ''))
  .refine((v) => /^\+[1-9]\d{7,14}$/.test(v), 'رقم الهاتف يجب أن يبدأ بـ + ورمز الدولة، مثل ‎+20');

const password = z.string().min(8, 'كلمة المرور 8 أحرف على الأقل');

const signInFields = z.object({ phone: phoneNumber, password });

const signUpFields = signInFields.extend({
  name: z.string().trim().min(2, 'الاسم مطلوب').max(120),
  email: z
    .string()
    .trim()
    .max(200)
    .refine((v) => v === '' || z.string().email().safeParse(v).success, 'بريد إلكتروني غير صحيح')
    .optional(),
  address: z.string().trim().max(500).optional(),
});

const otpFields = z.object({
  phone: phoneNumber,
  code: z.string().trim().regex(/^\d{6}$/, 'رمز التحقق يتكوّن من 6 أرقام'),
});

/** Same message for every failure, so the form is not a user-enumeration oracle. */
const GENERIC_CREDENTIALS_ERROR = 'بيانات الدخول غير صحيحة.';

/**
 * Supabase refuses phone sign-up/OTP outright when no SMS provider is wired
 * up in the project's Auth settings — a dashboard step, not something this
 * code can complete on its own. Recognised by message text rather than a
 * dedicated error code, because GoTrue does not give this failure one.
 */
function isPhoneProviderUnavailable(message: string): boolean {
  return /sms|phone.*provider|unsupported phone|signups not allowed/i.test(message);
}
const PHONE_PROVIDER_ERROR =
  'إرسال رمز التحقق عبر الرسائل النصية غير مُفعّل على الخادم بعد. على مالك المنصة ضبط مزوّد SMS من Supabase (Authentication → Phone) أولًا.';

/**
 * Where to go once authenticated.
 *
 * `next` — validated as a same-origin path — wins over everything else: it
 * is how a checkout gate sends the customer back to the exact order they
 * were placing. `claim` is an order-status token the customer already
 * holds, attached here rather than remembered anywhere; a failed claim never
 * blocks the sign-in.
 */
async function finishAuth(orgSlug: string | null, claim: string | null, next: string | null): Promise<never> {
  if (next) redirect(next);

  let destination = orgSlug ? `/r/${orgSlug}/account` : '/';
  if (claim) {
    const claimed = await claimGuestOrder({ token: claim });
    if (claimed) destination = `/r/${claimed.orgSlug}/account/orders?claimed=1`;
  }

  // Outside any try/catch: redirect() signals by throwing NEXT_REDIRECT.
  redirect(destination);
}

export async function customerSignInAction(
  _prev: AccountState,
  formData: FormData,
): Promise<AccountState> {
  const parsed = signInFields.safeParse({
    phone: formData.get('phone'),
    password: formData.get('password'),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? GENERIC_CREDENTIALS_ERROR };
  }

  const ip = getClientIp();
  for (const key of [`signin:ip:${ip}`, `signin:phone:${parsed.data.phone}`]) {
    if (!checkRateLimit(key, RATE_LIMITS.signIn).ok) {
      return { error: 'محاولات كثيرة. برجاء المحاولة بعد قليل.' };
    }
  }

  const supabase = createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) return { error: GENERIC_CREDENTIALS_ERROR };

  return finishAuth(optionalSlug(formData), optionalClaim(formData), optionalNext(formData));
}

export type SignUpState = { error?: string; otpRequired?: boolean } | undefined;

export async function customerSignUpAction(
  _prev: SignUpState,
  formData: FormData,
): Promise<SignUpState> {
  const parsed = signUpFields.safeParse({
    phone: formData.get('phone'),
    password: formData.get('password'),
    name: formData.get('name'),
    email: formData.get('email'),
    address: formData.get('address'),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'تحقق من البيانات المدخلة.' };
  }

  const confirm = String(formData.get('confirmPassword') ?? '');
  if (confirm !== parsed.data.password) return { error: 'كلمتا المرور غير متطابقتين.' };

  const ip = getClientIp();
  for (const key of [`signup:ip:${ip}`, `signup:phone:${parsed.data.phone}`]) {
    if (!checkRateLimit(key, RATE_LIMITS.signUp).ok) {
      return { error: 'محاولات كثيرة. برجاء المحاولة بعد قليل.' };
    }
  }

  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.auth.signUp({
    phone: parsed.data.phone,
    password: parsed.data.password,
    options: { data: { full_name: parsed.data.name } },
  });

  if (error) {
    const already = /already.*registered|already.*exists/i.test(error.message);
    if (already) return { error: 'رقم الهاتف مسجّل بحساب بالفعل. سجّل الدخول بدلًا من ذلك.' };
    if (isPhoneProviderUnavailable(error.message)) return { error: PHONE_PROVIDER_ERROR };
    return { error: 'تعذّر إنشاء الحساب. تحقّق من البيانات أو حاول مرة أخرى.' };
  }

  // A session already (phone confirmation switched off for this project):
  // skip the OTP step entirely, apply the same extras the OTP path applies,
  // and finish the same way sign-in does.
  if (data.session) {
    await applySignUpExtras(formData);
    return finishAuth(optionalSlug(formData), optionalClaim(formData), optionalNext(formData));
  }

  return { otpRequired: true };
}

export async function customerVerifyOtpAction(
  _prev: AccountState,
  formData: FormData,
): Promise<AccountState> {
  const parsed = otpFields.safeParse({
    phone: formData.get('phone'),
    code: formData.get('code'),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'رمز التحقق غير صحيح' };
  }

  const ip = getClientIp();
  for (const key of [`otp-verify:ip:${ip}`, `otp-verify:phone:${parsed.data.phone}`]) {
    if (!checkRateLimit(key, RATE_LIMITS.signIn).ok) {
      return { error: 'محاولات كثيرة. برجاء المحاولة بعد قليل.' };
    }
  }

  const supabase = createSupabaseServerClient();
  const { error } = await supabase.auth.verifyOtp({
    phone: parsed.data.phone,
    token: parsed.data.code,
    type: 'sms',
  });
  if (error) return { error: 'رمز التحقق غير صحيح أو منتهي الصلاحية.' };

  await applySignUpExtras(formData);
  return finishAuth(optionalSlug(formData), optionalClaim(formData), optionalNext(formData));
}

/**
 * Resend the SMS code — same call sign-up itself triggers, exposed
 * separately so a customer who did not receive it (or let it expire) is not
 * forced back to the phone/password step to ask for another.
 */
export async function resendCustomerOtpAction(
  _prev: AccountState,
  formData: FormData,
): Promise<AccountState> {
  const parsed = z.object({ phone: phoneNumber }).safeParse({ phone: formData.get('phone') });
  if (!parsed.success) return { error: 'رقم الهاتف غير صحيح' };

  if (!checkRateLimit(`otp-resend:${parsed.data.phone}`, RATE_LIMITS.signUp).ok) {
    return { error: 'انتظر قليلًا قبل طلب رمز جديد.' };
  }

  const supabase = createSupabaseServerClient();
  const { error } = await supabase.auth.resend({ type: 'sms', phone: parsed.data.phone });
  if (error) {
    return { error: isPhoneProviderUnavailable(error.message) ? PHONE_PROVIDER_ERROR : 'تعذّر إعادة إرسال الرمز.' };
  }
  return { ok: 'تم إرسال رمز جديد.' };
}

/**
 * Applies whatever the sign-up form collected beyond phone+password, once
 * the caller already has a session (either right after signUp(), when phone
 * confirmation is off, or after verifyOtp() succeeds). Best-effort: the
 * account exists and is signed in either way, and a customer can always fill
 * these in later from their account page.
 */
async function applySignUpExtras(formData: FormData): Promise<void> {
  const orgSlug = optionalSlug(formData);
  const name = String(formData.get('name') ?? '').trim();
  if (!orgSlug || !name) return;

  const email = String(formData.get('email') ?? '').trim();
  const address = String(formData.get('address') ?? '').trim();

  try {
    await saveProfile({ orgSlug, name, email: email || undefined });
  } catch {
    // Not fatal — see the doc comment above.
  }
  if (address.length >= 5) {
    try {
      await saveAddress({ orgSlug, label: 'المنزل', address, isDefault: true });
    } catch {
      // Same as above.
    }
  }
}

export async function customerSignOutAction(formData: FormData) {
  const supabase = createSupabaseServerClient();
  await supabase.auth.signOut();
  const orgSlug = optionalSlug(formData);
  redirect(orgSlug ? `/r/${orgSlug}` : '/');
}

function optionalSlug(formData: FormData): string | null {
  const parsed = slug.safeParse(formData.get('orgSlug'));
  return parsed.success ? parsed.data.toLowerCase() : null;
}

function optionalClaim(formData: FormData): string | null {
  const raw = String(formData.get('claim') ?? '');
  return /^[A-Za-z0-9_-]{22,64}$/.test(raw) ? raw : null;
}

/** A same-origin path only — never an absolute URL or a protocol-relative one. */
function optionalNext(formData: FormData): string | null {
  const raw = String(formData.get('next') ?? '');
  return /^\/(?!\/)\S*$/.test(raw) ? raw : null;
}

/**
 * Account mutations.
 *
 * The slug is read from the form, but it is not a security input: it names a
 * PUBLIC restaurant page, and the database still derives the customer row from
 * the session. Sending another restaurant's slug means acting on the account
 * the caller has at THAT restaurant — which is theirs too — and never reaches
 * anyone else's data.
 *
 * `revalidatePath` discards the value a Server Action returns, so success is
 * carried in the URL and failure is returned before any revalidation.
 */
export async function saveProfileAction(
  _prev: AccountState,
  formData: FormData,
): Promise<AccountState> {
  const orgSlug = slugOf(formData);
  try {
    await saveProfile({
      orgSlug,
      name: String(formData.get('name') ?? ''),
      phone: String(formData.get('phone') ?? ''),
      email: String(formData.get('email') ?? ''),
    });
  } catch (error) {
    return { error: error instanceof AppError ? error.message : 'تعذّر حفظ البيانات.' };
  }
  revalidatePath(`/r/${orgSlug}/account`);
  redirect(`/r/${orgSlug}/account?saved=1`);
}

export async function saveSettingsAction(
  _prev: AccountState,
  formData: FormData,
): Promise<AccountState> {
  const orgSlug = slugOf(formData);
  try {
    await saveSettings({
      orgSlug,
      marketing: formData.get('marketing') === 'on',
      orderUpdates: formData.get('orderUpdates') === 'on',
    });
  } catch (error) {
    return { error: error instanceof AppError ? error.message : 'تعذّر حفظ التفضيلات.' };
  }
  revalidatePath(`/r/${orgSlug}/account/settings`);
  redirect(`/r/${orgSlug}/account/settings?saved=1`);
}

export async function saveAddressAction(
  _prev: AccountState,
  formData: FormData,
): Promise<AccountState> {
  const orgSlug = slugOf(formData);
  const id = String(formData.get('id') ?? '');
  try {
    await saveAddress({
      orgSlug,
      ...(id ? { id } : {}),
      label: String(formData.get('label') ?? ''),
      address: String(formData.get('address') ?? ''),
      recipientName: String(formData.get('recipientName') ?? ''),
      phone: String(formData.get('phone') ?? ''),
      city: String(formData.get('city') ?? ''),
      area: String(formData.get('area') ?? ''),
      landmark: String(formData.get('landmark') ?? ''),
      isDefault: formData.get('isDefault') === 'on',
    });
  } catch (error) {
    return { error: error instanceof AppError ? error.message : 'تعذّر حفظ العنوان.' };
  }
  revalidatePath(`/r/${orgSlug}/account/addresses`);
  redirect(`/r/${orgSlug}/account/addresses?saved=1`);
}

export async function deleteAddressAction(formData: FormData) {
  const orgSlug = slugOf(formData);
  // A no-op when the id is not the caller's: the database filters by the
  // customer row, so there is nothing to report either way.
  await deleteAddress({ orgSlug, id: String(formData.get('id') ?? '') }).catch(() => {});
  revalidatePath(`/r/${orgSlug}/account/addresses`);
  redirect(`/r/${orgSlug}/account/addresses?deleted=1`);
}

export async function toggleFavoriteAction(formData: FormData) {
  const orgSlug = slugOf(formData);
  const productId = String(formData.get('productId') ?? '');
  const on = formData.get('on') === '1';
  const from = String(formData.get('from') ?? '');

  try {
    if (on) await addFavorite({ orgSlug, productId });
    else await removeFavorite({ orgSlug, productId });
  } catch {
    // A product that is not this restaurant's, or no longer on the menu, is
    // simply not favourited. Nothing about it is worth reporting to the page.
  }

  const target = from === 'menu' ? `/r/${orgSlug}` : `/r/${orgSlug}/account/favorites`;
  revalidatePath(target);
  redirect(target);
}
