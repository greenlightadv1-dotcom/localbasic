'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { placeOnlineOrder, quoteCart, cancelOrder, editOrder } from '@/modules/restaurant/online/service';
import { addFavorite, removeFavorite } from '@/modules/restaurant/account/service';
import { AppError } from '@/lib/errors';

export type CheckoutState = { error?: string } | undefined;

/**
 * Guest checkout.
 *
 * The form posts a cart of ids and quantities plus contact details. It does not
 * post a price, and if it did the server would ignore it: every figure is
 * recomputed from the menu inside the database.
 */
export async function checkoutAction(
  _prev: CheckoutState,
  formData: FormData,
): Promise<CheckoutState> {
  const orgSlug = String(formData.get('orgSlug') ?? '');
  const branchSlug = String(formData.get('branchSlug') ?? '');
  const fulfillment = String(formData.get('fulfillment') ?? 'pickup');
  const savedAddressId = String(formData.get('savedAddressId') ?? '');

  let items: unknown;
  try {
    items = JSON.parse(String(formData.get('items') ?? '[]'));
  } catch {
    return { error: 'السلة غير صالحة.' };
  }

  let placed: Awaited<ReturnType<typeof placeOnlineOrder>>;
  try {
    placed = await placeOnlineOrder({
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
    });
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
