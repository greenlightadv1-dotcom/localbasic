import { z } from 'zod';

/**
 * The four things a Platform Admin may choose. Everything else — price,
 * discount, period start and end — is computed in the database, so nothing
 * here carries money or dates.
 */
export const BILLING_PERIODS = ['month', 'quarter', 'semiannual', 'year'] as const;
export type BillingPeriod = (typeof BILLING_PERIODS)[number];

export const BILLING_PERIOD_LABELS: Record<BillingPeriod | 'trial', string> = {
  month: 'شهري',
  quarter: 'ربع سنوي (٣ شهور)',
  semiannual: 'نصف سنوي (٦ شهور)',
  year: 'سنوي (١٢ شهر)',
  trial: 'تجريبي',
};

export const PAYMENT_METHODS = ['cash'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const renewInput = z.object({
  organizationId: z.string().uuid(),
  planId: z.string().uuid(),
  billingPeriod: z.enum(BILLING_PERIODS),
  promoCode: z
    .string()
    .trim()
    .max(32)
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'رمز غير صالح')
    .optional()
    .or(z.literal('')),
  // CASH only for now. The column and the adapter seam accept more, but no
  // other method is offered until a provider is actually integrated.
  paymentMethod: z.enum(PAYMENT_METHODS).default('cash'),
  note: z.string().trim().max(500).optional().or(z.literal('')),
});
export type RenewInput = z.infer<typeof renewInput>;

export const quoteInput = renewInput.pick({
  organizationId: true,
  planId: true,
  billingPeriod: true,
  promoCode: true,
});

export const createWorkspaceInput = z.object({
  ownerEmail: z.string().email('بريد إلكتروني غير صحيح'),
  organizationName: z.string().trim().min(2).max(120),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])$/, 'معرّف غير صالح'),
  module: z.literal('restaurant'),
  branchName: z.string().trim().max(120).optional().or(z.literal('')),
});

export const promoCodeInput = z
  .object({
    code: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{2,31}$/, 'رمز غير صالح'),
    description: z.string().trim().max(200).optional().or(z.literal('')),
    kind: z.enum(['percent', 'fixed', 'trial_days']),
    percentOff: z.coerce.number().int().min(1).max(100).optional(),
    amountOffCents: z.coerce.number().int().positive().optional(),
    trialDays: z.coerce.number().int().min(1).max(365).optional(),
    maxRedemptions: z.coerce.number().int().positive().optional(),
    newCustomersOnly: z.coerce.boolean().default(false),
    endsAt: z.string().optional().or(z.literal('')),
  })
  // Mirrors the database CHECK constraint, so the form rejects the same shapes
  // the table would — the table stays the authority either way.
  .refine(
    (v) =>
      (v.kind === 'percent' && v.percentOff != null) ||
      (v.kind === 'fixed' && v.amountOffCents != null) ||
      (v.kind === 'trial_days' && v.trialDays != null),
    { message: 'قيمة الخصم لا تطابق نوع الرمز' },
  );

/** Why a code was refused. The database returns the key; the UI says it in Arabic. */
export const PROMO_REASONS: Record<string, string> = {
  code_not_found: 'الرمز غير موجود.',
  code_inactive: 'الرمز موقوف.',
  code_not_started: 'الرمز لم يبدأ بعد.',
  code_expired: 'انتهت صلاحية الرمز.',
  code_exhausted: 'تم استهلاك الحد الأقصى لاستخدام الرمز.',
  code_wrong_plan: 'الرمز لا ينطبق على هذه الباقة.',
  code_wrong_service: 'الرمز لا ينطبق على خدمة هذا العميل.',
  code_already_used: 'سبق استخدام هذا الرمز لهذا العميل.',
  code_new_customers_only: 'الرمز للعملاء الجدد فقط.',
};
