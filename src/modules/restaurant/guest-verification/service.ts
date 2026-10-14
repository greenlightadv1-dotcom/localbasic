import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { AppError, toAppError } from '@/lib/errors';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import type { TenantContext } from '@/modules/core/tenancy/context';
import { requirePermission } from '@/modules/core/tenancy/context';

/**
 * The cashier's own step: "I checked our WhatsApp and this is really them."
 * Flips both the order and the device/phone pair, so every later order from
 * this same device is recognised automatically (requirement: bypass on a
 * recognised device). Also the manual fallback for the automated webhook
 * below, if the gateway never calls it (down, misrouted message, etc).
 */
export async function verifyGuestOrder(ctx: TenantContext, orderId: string): Promise<void> {
  requirePermission(ctx, 'restaurant.order.update');
  const supabase = createSupabaseServerClient();
  const { error } = await supabase.rpc('restaurant_guest_verify_order', {
    p_org: ctx.organizationId, p_order: orderId,
  });
  if (error) throw toAppError(error, 'verifyGuestOrder');
}

export type OrderVerificationInfo = {
  status: string;
  code: string | null;
  whatsapp: string | null;
  expiresAt: string | null;
};

/**
 * What the checkout page shows while an order sits at 'pending_verification':
 * the same code and WhatsApp number the order was created with, read back by
 * its own tracking token — no device id or phone needed, since the token
 * already is the capability.
 */
export async function getOrderVerificationInfo(token: string): Promise<OrderVerificationInfo> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .rpc('restaurant_order_verification_info', { p_token: token })
    .single();
  // An unknown, expired or revoked token: the guest's saved pending order is
  // gone, which the page must be able to tell apart from a passing error.
  if (error?.code === '23514' && /order not found/.test(error.message ?? '')) throw new AppError('not_found');
  if (error) throw toAppError(error, 'getOrderVerificationInfo');
  const row = data as unknown as {
    out_status: string; out_code: string | null; out_whatsapp: string | null; out_expires_at: string | null;
  };
  return {
    status: row.out_status,
    code: row.out_code,
    whatsapp: row.out_whatsapp,
    expiresAt: row.out_expires_at,
  };
}

/**
 * The webhook's own call (0086): given what the gateway reported — the
 * branch code embedded in the message, the code itself, and the sender's
 * phone — finds the matching pending order, flips it to 'new', and trusts
 * the device. Never throws on "no match": that is simply out_matched=false,
 * the ordinary outcome for a stray or unrelated WhatsApp message.
 */
export async function verifyFromWhatsAppWebhook(
  branchCode: string,
  code: string,
  phone: string,
): Promise<{ matched: boolean; orderNumber: string | null }> {
  // Service role only (0099): the shared-secret check in the webhook route is
  // what authorises this call, so it must not be reachable with the anon key.
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .rpc('restaurant_whatsapp_verify_webhook', {
      p_branch_code: branchCode, p_code: code, p_phone: phone,
    })
    .single();
  if (error) throw toAppError(error, 'verifyFromWhatsAppWebhook');
  const row = data as unknown as { out_matched: boolean; out_order_number: string | null };
  return { matched: row.out_matched, orderNumber: row.out_order_number };
}

export type VerificationCheck =
  | { ok: true; data: OrderVerificationInfo }
  | { ok: false; code: 'not_found' | 'rate_limited' | 'failed'; error: string };

/** Status tokens are opaque URL-safe strings; anything else is refused unread. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{16,200}$/;

/**
 * The one public read behind "has my WhatsApp message arrived yet?", used
 * right after checkout, by the manual "تحقق الآن" button, when the guest
 * returns to the tab, and by the gentle poll while the sheet is open.
 *
 * Rate limited per token (the poll runs every few seconds; 40/min leaves room
 * for focus and manual checks but stops a script hammering one order) and per
 * IP (looser, since a whole restaurant's guests can share one address). It
 * reveals only what the token holder already saw at checkout: the status,
 * the code they were shown, the store's WhatsApp number and the code's expiry
 * — never the phone, the name or the device.
 */
export async function checkVerificationStatus(token: unknown, ip: string): Promise<VerificationCheck> {
  if (typeof token !== 'string' || !TOKEN_SHAPE.test(token)) {
    return { ok: false, code: 'not_found', error: 'الطلب غير موجود.' };
  }
  if (!checkRateLimit(`verify-status:${token}`, RATE_LIMITS.verificationStatus).ok ||
      !checkRateLimit(`verify-status-ip:${ip}`, RATE_LIMITS.verificationStatusIp).ok) {
    return { ok: false, code: 'rate_limited', error: 'محاولات كثيرة. انتظر قليلًا.' };
  }
  try {
    return { ok: true, data: await getOrderVerificationInfo(token) };
  } catch (error) {
    const e = toAppError(error, 'checkVerificationStatus');
    if (e.code === 'not_found') return { ok: false, code: 'not_found', error: 'الطلب غير موجود.' };
    if (e.code === 'rate_limited') return { ok: false, code: 'rate_limited', error: e.message };
    return { ok: false, code: 'failed', error: 'تعذّر التحقق من حالة الطلب.' };
  }
}
