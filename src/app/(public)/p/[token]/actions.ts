'use server';

import { definePublicAction, getClientIp } from '@/lib/action';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import { AppError } from '@/lib/errors';
import { publicOrderSchema } from '@/modules/restaurant/orders/schemas';
import { placePublicOrder } from '@/modules/restaurant/public/service';
import { getOrderVerificationInfo } from '@/modules/restaurant/guest-verification/service';

/**
 * Guest order placement.
 *
 * Rate limited twice over: by client IP, and by the token itself, so one table
 * cannot be used to flood the kitchen even from many addresses. The database
 * function applies a third limit on open orders per table.
 */
export const placeGuestOrderAction = definePublicAction({
  schema: publicOrderSchema,
  rateLimit: RATE_LIMITS.publicOrder,
  handler: async ({ input }) => {
    const ip = getClientIp();
    if (!checkRateLimit(`guest-order:${input.token}`, RATE_LIMITS.publicOrder).ok) {
      throw new AppError('rate_limited', 'طلبات كثيرة من هذه الطاولة. انتظر قليلًا.');
    }
    if (!checkRateLimit(`guest-order-ip:${ip}`, RATE_LIMITS.publicOrder).ok) {
      throw new AppError('rate_limited', 'محاولات كثيرة. انتظر قليلًا.');
    }

    return placePublicOrder({
      token: input.token,
      items: input.items,
      guestName: input.guestName,
      guestPhone: input.guestPhone,
      note: input.note,
      deviceId: input.deviceId,
      latitude: input.latitude,
      longitude: input.longitude,
    });
  },
});

/**
 * What to show right after placing a guest order: still 'pending_verification'
 * (the WhatsApp sheet) or already 'new' (go straight to tracking).
 */
export async function getOrderVerificationInfoAction(statusToken: string) {
  try {
    return { ok: true as const, data: await getOrderVerificationInfo(statusToken) };
  } catch (error) {
    return { ok: false as const, error: error instanceof AppError ? error.message : 'تعذّر التحقق من حالة الطلب.' };
  }
}
