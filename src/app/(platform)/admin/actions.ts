'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  renewSubscription, quoteRenewal, createPromoCode, setPromoCodeActive,
} from '@/modules/platform/billing/service';
import { createLead, updateLead } from '@/modules/platform/leads/service';
import { setServiceAvailability } from '@/modules/platform/services/service';
import { onboardCustomer } from '@/modules/platform/onboarding/service';
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

export type LeadState = { error?: string; ok?: string } | undefined;

export async function createLeadAction(_prev: LeadState, formData: FormData): Promise<LeadState> {
  try {
    await createLead({
      name: String(formData.get('name') ?? ''),
      phone: String(formData.get('phone') ?? ''),
      businessName: String(formData.get('businessName') ?? ''),
      requestedService: String(formData.get('requestedService') ?? ''),
      source: String(formData.get('source') ?? 'whatsapp'),
      notes: String(formData.get('notes') ?? ''),
    });
  } catch (error) {
    return { error: error instanceof AppError ? error.message : 'تعذّر إضافة العميل المحتمل.' };
  }
  revalidatePath('/admin/leads');
  // Revalidating re-renders the page this form sits on, which drops the
  // useFormState message. The flag in the URL survives that, so the admin
  // always sees whether the write landed. redirect() must stay outside the
  // try above: it throws NEXT_REDIRECT, which the catch would swallow.
  redirect('/admin/leads?created=1');
}

export async function updateLeadAction(_prev: LeadState, formData: FormData): Promise<LeadState> {
  try {
    await updateLead({
      id: String(formData.get('id') ?? ''),
      status: String(formData.get('status') ?? ''),
      notes: String(formData.get('notes') ?? ''),
    });
  } catch (error) {
    return { error: error instanceof AppError ? error.message : 'تعذّر التحديث.' };
  }
  revalidatePath('/admin/leads');
  return { ok: 'تم التحديث.' };
}

export type ServiceState = { error?: string; ok?: string } | undefined;

export async function setServiceAvailabilityAction(
  _prev: ServiceState,
  formData: FormData,
): Promise<ServiceState> {
  try {
    await setServiceAvailability({
      moduleKey: String(formData.get('moduleKey') ?? ''),
      isAvailable: formData.get('isAvailable') === 'true',
    });
  } catch (error) {
    return { error: error instanceof AppError ? error.message : 'تعذّر التحديث.' };
  }
  revalidatePath('/admin/services');
  return { ok: 'تم تحديث حالة الخدمة.' };
}

export type PromoState = { error?: string; ok?: string } | undefined;

export async function createPromoCodeAction(
  _prev: PromoState,
  formData: FormData,
): Promise<PromoState> {
  const kind = String(formData.get('kind') ?? 'percent');
  try {
    await createPromoCode({
      code: String(formData.get('code') ?? ''),
      description: String(formData.get('description') ?? ''),
      kind,
      // Only the field belonging to the chosen kind is sent; the others would
      // fail the database CHECK that ties the effect to the kind.
      percentOff: kind === 'percent' ? String(formData.get('percentOff') ?? '') || undefined : undefined,
      amountOffCents:
        kind === 'fixed'
          ? Math.round(Number(formData.get('amountOff') ?? 0) * 100) || undefined
          : undefined,
      trialDays: kind === 'trial_days' ? String(formData.get('trialDays') ?? '') || undefined : undefined,
      maxRedemptions: String(formData.get('maxRedemptions') ?? '') || undefined,
      newCustomersOnly: formData.get('newCustomersOnly') === 'on',
      endsAt: String(formData.get('endsAt') ?? ''),
      planId: String(formData.get('planId') ?? ''),
      moduleKey: String(formData.get('moduleKey') ?? ''),
    });
  } catch (error) {
    return { error: error instanceof AppError ? error.message : 'تعذّر إنشاء الرمز.' };
  }
  revalidatePath('/admin/promo-codes');
  redirect('/admin/promo-codes?created=1');
}

export async function togglePromoCodeAction(
  _prev: PromoState,
  formData: FormData,
): Promise<PromoState> {
  try {
    await setPromoCodeActive(
      String(formData.get('id') ?? ''),
      formData.get('isActive') === 'true',
    );
  } catch (error) {
    return { error: error instanceof AppError ? error.message : 'تعذّر التحديث.' };
  }
  revalidatePath('/admin/promo-codes');
  return { ok: 'تم التحديث.' };
}

export type OnboardState = { error?: string; ok?: string; customerCode?: string } | undefined;

export async function onboardCustomerAction(
  _prev: OnboardState,
  formData: FormData,
): Promise<OnboardState> {
  let result: Awaited<ReturnType<typeof onboardCustomer>>;
  try {
    result = await onboardCustomer({
      ownerEmail: String(formData.get('ownerEmail') ?? ''),
      ownerName: String(formData.get('ownerName') ?? ''),
      organizationName: String(formData.get('organizationName') ?? ''),
      slug: String(formData.get('slug') ?? ''),
      moduleKey: String(formData.get('moduleKey') ?? 'restaurant'),
      planId: String(formData.get('planId') ?? ''),
      billingPeriod: String(formData.get('billingPeriod') ?? 'month'),
      promoCode: String(formData.get('promoCode') ?? ''),
      branchName: String(formData.get('branchName') ?? ''),
      leadId: String(formData.get('leadId') ?? ''),
      note: String(formData.get('note') ?? ''),
    });
  } catch (error) {
    return { error: error instanceof AppError ? error.message : 'تعذّر إنشاء مساحة العمل.' };
  }

  revalidatePath('/admin', 'layout');

  // Land on the customer that was just created, rather than returning a success
  // message to this form. Revalidating the layout remounts the form and resets
  // useFormState, so a returned message is silently lost — and an admin who
  // sees no confirmation after taking cash may well sell the same thing twice.
  //
  // redirect() throws NEXT_REDIRECT, so it must sit outside the try above or
  // the catch would swallow it and report a failure for work that succeeded.
  redirect(`/admin/organizations/${result.customerCode}?created=1`);
}
