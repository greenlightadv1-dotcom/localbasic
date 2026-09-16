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

export type AccountState = { error?: string } | undefined;

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
 */
const credentials = z.object({
  email: z.string().email('بريد إلكتروني غير صحيح'),
  password: z.string().min(8, 'كلمة المرور 8 أحرف على الأقل'),
});

const signUpFields = credentials.extend({
  name: z.string().trim().min(2, 'الاسم مطلوب').max(120),
});

/** Same message for every failure, so the form is not a user-enumeration oracle. */
const GENERIC_CREDENTIALS_ERROR = 'بيانات الدخول غير صحيحة.';

/**
 * Where to go once authenticated.
 *
 * `claim` is an order-status token the customer already holds. It is attached
 * here rather than being remembered anywhere, and a failed claim never blocks
 * the sign-in — they are signed in either way and simply see their account.
 */
async function finishAuth(orgSlug: string | null, claim: string | null): Promise<never> {
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
  const parsed = credentials.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  });
  if (!parsed.success) return { error: GENERIC_CREDENTIALS_ERROR };

  // The existing sign-in limits, unchanged: per IP and per identifier, so
  // neither a spray across accounts nor a brute force against one gets far.
  const ip = getClientIp();
  for (const key of [`signin:ip:${ip}`, `signin:email:${parsed.data.email.toLowerCase()}`]) {
    if (!checkRateLimit(key, RATE_LIMITS.signIn).ok) {
      return { error: 'محاولات كثيرة. برجاء المحاولة بعد قليل.' };
    }
  }

  const supabase = createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) return { error: GENERIC_CREDENTIALS_ERROR };

  return finishAuth(optionalSlug(formData), optionalClaim(formData));
}

export async function customerSignUpAction(
  _prev: AccountState,
  formData: FormData,
): Promise<AccountState> {
  const parsed = signUpFields.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
    name: formData.get('name'),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'تحقق من البيانات المدخلة.' };
  }

  const confirm = String(formData.get('confirmPassword') ?? '');
  if (confirm !== parsed.data.password) return { error: 'كلمتا المرور غير متطابقتين.' };

  if (!checkRateLimit(`signup:ip:${getClientIp()}`, RATE_LIMITS.signUp).ok) {
    return { error: 'محاولات كثيرة. برجاء المحاولة بعد قليل.' };
  }

  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: { data: { full_name: parsed.data.name } },
  });

  // An address that already exists must not be confirmed as existing.
  if (error) return { error: 'تعذّر إنشاء الحساب. تحقق من البيانات أو سجّل الدخول.' };

  // If the project requires email confirmation, Supabase returns a user with
  // no session. Saying "you are signed in" at that point would be a lie, and
  // every account page would then bounce them back here.
  if (!data.session) {
    return { error: 'تم إرسال رسالة تأكيد إلى بريدك. أكّد بريدك ثم سجّل الدخول.' };
  }

  return finishAuth(optionalSlug(formData), optionalClaim(formData));
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
