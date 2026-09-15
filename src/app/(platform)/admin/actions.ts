'use server';

import { revalidatePath } from 'next/cache';
import { renewSubscription, quoteRenewal } from '@/modules/platform/billing/service';
import { PROMO_REASONS } from '@/modules/platform/billing/schemas';
import { AppError } from '@/lib/errors';

export type RenewState = { error?: string; ok?: string } | undefined;

/**
 * Renew a term for cash.
 *
 * The form posts four identifiers and a note — never a price, a discount or a
 * date. Those are recomputed inside platform_renew_subscription() from the plan
 * and the promo code, so a tampered form cannot buy a year for nothing.
 */
export async function renewAction(_prev: RenewState, formData: FormData): Promise<RenewState> {
  const input = {
    organizationId: String(formData.get('organizationId') ?? ''),
    planId: String(formData.get('planId') ?? ''),
    billingPeriod: String(formData.get('billingPeriod') ?? ''),
    promoCode: String(formData.get('promoCode') ?? '').trim(),
    paymentMethod: 'cash' as const,
    note: String(formData.get('note') ?? '').trim(),
  };

  // Priced first so a rejected code is reported in the admin's language rather
  // than surfacing as a raw SQL exception from the write path.
  try {
    const quote = await quoteRenewal(input);
    if (!quote.valid) {
      return { error: PROMO_REASONS[quote.reason ?? ''] ?? 'رمز الخصم غير صالح.' };
    }
  } catch (error) {
    return { error: error instanceof AppError ? error.message : 'تعذّر حساب السعر.' };
  }

  try {
    await renewSubscription(input);
  } catch (error) {
    return { error: error instanceof AppError ? error.message : 'تعذّر تنفيذ التجديد.' };
  }

  revalidatePath('/admin', 'layout');
  return { ok: 'تم تسجيل التجديد والدفع النقدي.' };
}
