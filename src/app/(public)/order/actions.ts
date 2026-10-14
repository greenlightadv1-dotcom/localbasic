'use server';

import { getClientIp } from '@/lib/action';
import { revalidatePath } from 'next/cache';
import { placeOnlineOrder, quoteCart, cancelOrder, editOrder } from '@/modules/restaurant/online/service';
import { AppError } from '@/lib/errors';
import { checkVerificationStatus } from '@/modules/restaurant/guest-verification/service';

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
 * Checkout for a guest: a phone number and this browser's device id are the
 * only identity involved — no account, no password, no SMS OTP. The order is
 * always created; whether it starts at 'new' or 'pending_verification' is
 * the server's call (restaurant_place_online_order, from device trust), not
 * this action's — the caller reads that back via getOrderVerificationInfoAction
 * right after and decides whether to show the WhatsApp step or go straight
 * to tracking.
 */
export async function checkoutAction(formData: FormData) {
  let input: ReturnType<typeof checkoutInputFromForm>;
  try {
    input = checkoutInputFromForm(formData);
  } catch {
    return { ok: false as const, error: 'السلة غير صالحة.' };
  }

  try {
    const placed = await placeOnlineOrder(input);
    return { ok: true as const, data: placed };
  } catch (error) {
    return { ok: false as const, error: error instanceof AppError ? error.message : 'تعذّر إتمام الطلب.' };
  }
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

/**
 * What to show right after checkout: still 'pending_verification' (the
 * WhatsApp sheet) or already 'new' (go straight to tracking) — read by the
 * order's own status token, nothing else.
 */
export async function getOrderVerificationInfoAction(token: string) {
  return checkVerificationStatus(token, getClientIp());
}
