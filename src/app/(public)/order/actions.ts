'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { placeOnlineOrder, quoteCart, cancelOrder, editOrder } from '@/modules/restaurant/online/service';
import { AppError } from '@/lib/errors';
import {
  startGuestVerification, guestDeviceTrusted,
} from '@/modules/restaurant/guest-verification/service';

export type CheckoutState = { error?: string } | undefined;

/** Parses the cart + contact fields every checkout submission carries. */
function checkoutInputFromForm(formData: FormData) {
  const orgSlug = String(formData.get('orgSlug') ?? '');
  const branchSlug = String(formData.get('branchSlug') ?? '');
  const fulfillment = String(formData.get('fulfillment') ?? 'pickup');

  const items = JSON.parse(String(formData.get('items') ?? '[]'));
  const latitude = formData.get('latitude');
  const longitude = formData.get('longitude');

  return {
    orgSlug,
    branchSlug,
    items,
    fulfillment,
    customerName: String(formData.get('customerName') ?? ''),
    customerPhone: String(formData.get('customerPhone') ?? ''),
    note: String(formData.get('note') ?? ''),
    idempotencyKey: String(formData.get('idempotencyKey') ?? ''),
    deviceId: String(formData.get('deviceId') ?? '') || undefined,
    latitude: latitude ? Number(latitude) : undefined,
    longitude: longitude ? Number(longitude) : undefined,
    address:
      fulfillment === 'delivery'
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
 * Checkout for a guest: a phone number and this browser's device id
 * (checked against WhatsApp-verified devices in the storefront before this
 * action ever fires) are the only identity involved — no account, no
 * password, no SMS OTP.
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

/** Is this device already recognised for this phone at this storefront? */
export async function checkGuestDeviceAction(input: {
  orgSlug: string;
  branchSlug: string;
  deviceId: string;
  phone: string;
}): Promise<{ trusted: boolean }> {
  const trusted = await guestDeviceTrusted(input.orgSlug, input.branchSlug, input.deviceId, input.phone);
  return { trusted };
}

/** Issues the WhatsApp verification code for a first-time device. */
export async function startGuestVerificationAction(input: {
  orgSlug: string;
  branchSlug: string;
  deviceId: string;
  phone: string;
}) {
  try {
    return {
      ok: true as const,
      data: await startGuestVerification(input.orgSlug, input.branchSlug, input.deviceId, input.phone),
    };
  } catch (error) {
    return { ok: false as const, error: error instanceof AppError ? error.message : 'تعذّر إرسال رمز التحقق.' };
  }
}
