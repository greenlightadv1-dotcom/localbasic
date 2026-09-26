'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { placeOnlineOrder, quoteCart, cancelOrder, editOrder } from '@/modules/restaurant/online/service';
import { addFavorite, removeFavorite } from '@/modules/restaurant/account/service';
import { otpSendInput, otpVerifyInput } from '@/modules/restaurant/online/schemas';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import { getClientIp } from '@/lib/action';
import { AppError } from '@/lib/errors';

export type CheckoutState = { error?: string } | undefined;

/** Parses the cart + contact fields every checkout submission carries. */
function checkoutInputFromForm(formData: FormData) {
  const orgSlug = String(formData.get('orgSlug') ?? '');
  const branchSlug = String(formData.get('branchSlug') ?? '');
  const fulfillment = String(formData.get('fulfillment') ?? 'pickup');
  const savedAddressId = String(formData.get('savedAddressId') ?? '');

  const items = JSON.parse(String(formData.get('items') ?? '[]'));

  return {
    orgSlug,
    branchSlug,
    items,
    fulfillment,
    customerName: String(formData.get('customerName') ?? ''),
    customerPhone: String(formData.get('customerPhone') ?? ''),
    note: String(formData.get('note') ?? ''),
    idempotencyKey: String(formData.get('idempotencyKey') ?? ''),
    // D3: an id only. The address that reaches the order is read from the
    // database under the signed-in customer's own row; a guest sends none
    // and this stays undefined, leaving the D1 path exactly as it was.
    ...(savedAddressId ? { savedAddressId } : {}),
    address:
      fulfillment === 'delivery' && !savedAddressId
        ? {
            address: String(formData.get('address') ?? ''),
            city: String(formData.get('city') ?? ''),
            area: String(formData.get('area') ?? ''),
            landmark: String(formData.get('landmark') ?? ''),
          }
        : undefined,
  };
}

/**
 * Checkout for an already-authenticated customer.
 *
 * Reached only from the signed-in path in the storefront — a guest goes
 * through sendCheckoutOtpAction / placeVerifiedOrderAction (D4) instead, since
 * an unauthenticated request has no verified email to attach an order to.
 */
export async function checkoutAction(
  _prev: CheckoutState,
  formData: FormData,
): Promise<CheckoutState> {
  let input: ReturnType<typeof checkoutInputFromForm>;
  try {
    input = checkoutInputFromForm(formData);
  } catch {
    return { error: 'السلة غير صالحة.' };
  }

  let placed: Awaited<ReturnType<typeof placeOnlineOrder>>;
  try {
    placed = await placeOnlineOrder(input);
  } catch (error) {
    return { error: error instanceof AppError ? error.message : 'تعذّر إتمام الطلب.' };
  }

  // The token is the guest's only handle on this order, so the tracking page is
  // where they land. redirect() throws NEXT_REDIRECT and must stay outside the
  // try above, which would otherwise report a failure for a placed order.
  redirect(`/order/track/${placed.token}`);
}

export type OtpState = { error?: string; ok?: boolean } | undefined;

/**
 * Send a 6-digit email OTP to a guest checking out (D4).
 *
 * `shouldCreateUser: true` means a first-time email gets a Supabase Auth user
 * created for it right here — exactly like customerSignUpAction, just without
 * a password, since the code itself is the proof of ownership. No SMS
 * provider, no per-message cost: Supabase sends this through its own email
 * delivery, same channel `customerSignUpAction`'s confirmation mail already
 * uses.
 */
export async function sendCheckoutOtpAction(
  _prev: OtpState,
  formData: FormData,
): Promise<OtpState> {
  const parsed = otpSendInput.safeParse({ email: formData.get('customerEmail') });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'بريد إلكتروني غير صحيح' };
  }

  const ip = getClientIp();
  for (const key of [`checkout-otp-send:ip:${ip}`, `checkout-otp-send:email:${parsed.data.email.toLowerCase()}`]) {
    if (!checkRateLimit(key, RATE_LIMITS.checkoutOtpSend).ok) {
      return { error: 'محاولات كثيرة. برجاء المحاولة بعد قليل.' };
    }
  }

  const supabase = createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithOtp({
    email: parsed.data.email,
    options: { shouldCreateUser: true },
  });
  if (error) return { error: 'تعذّر إرسال رمز التحقق. حاول مرة أخرى.' };

  return { ok: true };
}

/**
 * Verify the OTP and place the order in one step (D4).
 *
 * verifyOtp signs the caller in through the same cookie-backed server client
 * placeOnlineOrder reads a moment later, so by the time it calls
 * restaurant_place_online_order, auth.uid() already resolves — the order is
 * linked to a real, email-verified customer account exactly the way an
 * already-signed-in checkout is, never left as an anonymous guest row.
 */
export async function placeVerifiedOrderAction(
  _prev: CheckoutState,
  formData: FormData,
): Promise<CheckoutState> {
  const parsedOtp = otpVerifyInput.safeParse({
    email: formData.get('customerEmail'),
    code: formData.get('otpCode'),
  });
  if (!parsedOtp.success) {
    return { error: parsedOtp.error.issues[0]?.message ?? 'رمز التحقق غير صحيح' };
  }

  const ip = getClientIp();
  for (const key of [`checkout-otp-verify:ip:${ip}`, `checkout-otp-verify:email:${parsedOtp.data.email.toLowerCase()}`]) {
    if (!checkRateLimit(key, RATE_LIMITS.checkoutOtpVerify).ok) {
      return { error: 'محاولات كثيرة. برجاء المحاولة بعد قليل.' };
    }
  }

  let input: ReturnType<typeof checkoutInputFromForm>;
  try {
    input = checkoutInputFromForm(formData);
  } catch {
    return { error: 'السلة غير صالحة.' };
  }

  const supabase = createSupabaseServerClient();
  const { error: otpError } = await supabase.auth.verifyOtp({
    email: parsedOtp.data.email,
    token: parsedOtp.data.code,
    type: 'email',
  });
  if (otpError) return { error: 'رمز التحقق غير صحيح أو منتهي الصلاحية.' };

  let placed: Awaited<ReturnType<typeof placeOnlineOrder>>;
  try {
    placed = await placeOnlineOrder(input);
  } catch (error) {
    return { error: error instanceof AppError ? error.message : 'تعذّر إتمام الطلب.' };
  }

  redirect(`/order/track/${placed.token}`);
}

export type TrackState = { error?: string; ok?: string } | undefined;

export async function cancelOrderAction(
  _prev: TrackState,
  formData: FormData,
): Promise<TrackState> {
  const token = String(formData.get('token') ?? '');
  try {
    await cancelOrder({ token, reason: String(formData.get('reason') ?? '') });
  } catch (error) {
    return { error: error instanceof AppError ? error.message : 'تعذّر إلغاء الطلب.' };
  }
  revalidatePath(`/order/track/${token}`);
  return { ok: 'تم إلغاء الطلب.' };
}

export async function editOrderAction(
  _prev: TrackState,
  formData: FormData,
): Promise<TrackState> {
  const token = String(formData.get('token') ?? '');
  let items: unknown;
  try {
    items = JSON.parse(String(formData.get('items') ?? '[]'));
  } catch {
    return { error: 'السلة غير صالحة.' };
  }
  try {
    await editOrder({ token, items });
  } catch (error) {
    return { error: error instanceof AppError ? error.message : 'تعذّر تعديل الطلب.' };
  }
  revalidatePath(`/order/track/${token}`);
  return { ok: 'تم تعديل الطلب.' };
}

/**
 * Toggle a favorite from the ordering screen itself, not the account area.
 *
 * Deliberately does not redirect: the storefront is a client component with
 * live cart state, and a full navigation here would throw that cart away.
 * A signed-out guest is never routed here — the heart button only renders
 * for a signed-in customer — but a stale or foreign productId still just
 * silently does nothing, the same as the account-area version.
 */
export async function toggleFavoriteAction(input: {
  orgSlug: string;
  productId: string;
  on: boolean;
}): Promise<{ ok: boolean }> {
  try {
    if (input.on) await addFavorite({ orgSlug: input.orgSlug, productId: input.productId });
    else await removeFavorite({ orgSlug: input.orgSlug, productId: input.productId });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

/** Re-price a cart from the menu. Used by the cart UI; never trusted from it. */
export async function quoteCartAction(input: {
  orgSlug: string;
  branchSlug: string;
  items: unknown;
  fulfillment: string;
}) {
  try {
    return { quote: await quoteCart(input) };
  } catch (error) {
    return { error: error instanceof AppError ? error.message : 'تعذّر تسعير السلة.' };
  }
}
