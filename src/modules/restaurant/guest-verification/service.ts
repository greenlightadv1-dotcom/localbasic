import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { AppError, toAppError } from '@/lib/errors';
import type { TenantContext } from '@/modules/core/tenancy/context';
import { requirePermission } from '@/modules/core/tenancy/context';

export type VerificationStart = { code: string; whatsapp: string | null; expiresAt: string };

/** QR/in-store: resolved through the same public_links token the menu itself uses. */
export async function startGuestVerificationByToken(
  token: string,
  deviceId: string,
  phone: string,
): Promise<VerificationStart> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .rpc('restaurant_guest_verification_start_by_token', {
      p_token: token, p_device_id: deviceId, p_phone: phone,
    })
    .single();
  if (error) throw new AppError('validation', 'تعذّر إرسال رمز التحقق.');
  const row = data as unknown as { out_code: string; out_whatsapp: string | null; out_expires_at: string };
  return { code: row.out_code, whatsapp: row.out_whatsapp, expiresAt: row.out_expires_at };
}

export async function guestDeviceTrustedByToken(
  token: string,
  deviceId: string,
  phone: string,
): Promise<boolean> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('restaurant_guest_device_status_by_token', {
    p_token: token, p_device_id: deviceId, p_phone: phone,
  });
  if (error) return false;
  return Boolean(data);
}

/** Online storefront: resolved through the org/branch slug pair, like checkout itself. */
export async function startGuestVerification(
  orgSlug: string,
  branchSlug: string,
  deviceId: string,
  phone: string,
): Promise<VerificationStart> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .rpc('restaurant_guest_verification_start', {
      p_org_slug: orgSlug, p_branch_slug: branchSlug, p_device_id: deviceId, p_phone: phone,
    })
    .single();
  if (error) throw new AppError('validation', 'تعذّر إرسال رمز التحقق.');
  const row = data as unknown as { out_code: string; out_whatsapp: string | null; out_expires_at: string };
  return { code: row.out_code, whatsapp: row.out_whatsapp, expiresAt: row.out_expires_at };
}

export async function guestDeviceTrusted(
  orgSlug: string,
  branchSlug: string,
  deviceId: string,
  phone: string,
): Promise<boolean> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('restaurant_guest_device_status', {
    p_org_slug: orgSlug, p_branch_slug: branchSlug, p_device_id: deviceId, p_phone: phone,
  });
  if (error) return false;
  return Boolean(data);
}

/**
 * The cashier's own step: "I checked our WhatsApp and this is really them."
 * Flips both the order and the device/phone pair, so every later order from
 * this same device is recognised automatically (requirement: bypass on a
 * recognised device).
 */
export async function verifyGuestOrder(ctx: TenantContext, orderId: string): Promise<void> {
  requirePermission(ctx, 'restaurant.order.update');
  const supabase = createSupabaseServerClient();
  const { error } = await supabase.rpc('restaurant_guest_verify_order', {
    p_org: ctx.organizationId, p_order: orderId,
  });
  if (error) throw toAppError(error, 'verifyGuestOrder');
}
