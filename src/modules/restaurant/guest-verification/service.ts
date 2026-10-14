import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { toAppError } from '@/lib/errors';
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
