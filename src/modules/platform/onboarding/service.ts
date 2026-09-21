import 'server-only';
import { z } from 'zod';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { serverEnv } from '@/lib/env';
import { appOrigin } from '@/lib/auth/redirects';
import { requirePlatformAdmin } from '@/modules/platform/admin/context';
import { AppError } from '@/lib/errors';
import { BILLING_PERIODS } from '@/modules/platform/billing/schemas';

/**
 * Onboarding a new customer.
 *
 * Two halves, deliberately separated:
 *
 *   1. The IDENTITY half needs the Supabase Admin API, because creating or
 *      inviting an auth user is not something the database can do. That
 *      requires SUPABASE_SERVICE_ROLE_KEY, which is server-only and must never
 *      be exposed to the browser or prefixed NEXT_PUBLIC_.
 *
 *   2. The WORKSPACE half is one plpgsql transaction —
 *      platform_onboard_customer() — which provisions, applies the plan, opens
 *      the subscription term and closes the lead. A failure anywhere rolls all
 *      of it back, so there is no orphan workspace and no orphan subscription.
 *
 * We never store or handle a password. The owner receives an invitation and
 * sets their own credentials through Supabase Auth.
 */

export const onboardInput = z.object({
  ownerEmail: z.string().trim().toLowerCase().email('بريد إلكتروني غير صحيح'),
  ownerName: z.string().trim().min(2, 'اسم المالك مطلوب').max(120),
  organizationName: z.string().trim().min(2, 'اسم المنشأة مطلوب').max(120),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])$/, 'معرّف غير صالح (حروف إنجليزية وأرقام وشرطات)'),
  moduleKey: z.string().trim().min(2).max(32),
  planId: z.string().uuid('اختر باقة'),
  billingPeriod: z.enum(BILLING_PERIODS),
  promoCode: z.string().trim().max(32).optional().or(z.literal('')),
  branchName: z.string().trim().max(120).optional().or(z.literal('')),
  leadId: z.string().uuid().optional().or(z.literal('')),
  note: z.string().trim().max(500).optional().or(z.literal('')),
});

export type OnboardResult = {
  organizationId: string;
  customerCode: string;
  slug: string;
  ownerInvited: boolean;
};

/** The exact variable an operator must set for account creation to work. */
export const SERVICE_ROLE_ENV = 'SUPABASE_SERVICE_ROLE_KEY';

/**
 * Whether the identity half can run at all.
 *
 * Checked on the server and reported to the admin as a configuration status —
 * never by pretending an account was created.
 */
export function ownerProvisioningAvailable(): boolean {
  return Boolean(serverEnv().SUPABASE_SERVICE_ROLE_KEY);
}

/** Finds an existing auth account for an address, via the admin-only RPC. */
async function findOwnerByEmail(email: string): Promise<string | null> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('platform_find_user_by_email', { p_email: email });
  if (error) throw new AppError('validation', error.message);
  const row = (Array.isArray(data) ? data[0] : data) as { user_id: string } | undefined;
  return row?.user_id ?? null;
}

/**
 * Resolves the owner's user id, inviting a new account when there isn't one.
 *
 * Returns `invited` so the caller can tell the admin whether an email went out.
 * Never creates a password; the invitation link lets the owner set their own.
 */
async function resolveOwner(
  email: string,
  fullName: string,
): Promise<{ userId: string; invited: boolean }> {
  const existing = await findOwnerByEmail(email);
  if (existing) return { userId: existing, invited: false };

  if (!ownerProvisioningAvailable()) {
    throw new AppError(
      'validation',
      `لا يوجد حساب بهذا البريد، وإنشاء الحسابات غير مُهيأ على الخادم. ` +
        `اضبط ${SERVICE_ROLE_ENV} أو اطلب من المالك إنشاء حساب أولًا.`,
    );
  }

  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
    data: { full_name: fullName },
    // appOrigin(), so an invite cannot be mailed pointing at localhost when
    // NEXT_PUBLIC_APP_URL was absent for the build that produced this bundle.
    redirectTo: `${appOrigin()}/callback`,
  });

  if (error || !data.user) {
    throw new AppError('validation', `تعذّر إنشاء حساب المالك: ${error?.message ?? 'خطأ غير معروف'}`);
  }
  return { userId: data.user.id, invited: true };
}

export async function onboardCustomer(input: unknown): Promise<OnboardResult> {
  await requirePlatformAdmin();

  const parsed = onboardInput.safeParse(input);
  if (!parsed.success) {
    throw new AppError('validation', parsed.error.issues[0]?.message ?? 'بيانات غير صالحة');
  }
  const v = parsed.data;

  const supabase = createSupabaseServerClient();

  // Check the slug before touching identity, so a taken slug never leaves a
  // freshly invited account with no workspace attached.
  const { data: slugFree } = await supabase.rpc('is_org_slug_available', { p_slug: v.slug });
  if (slugFree === false) {
    throw new AppError('validation', 'هذا المعرّف مستخدم بالفعل.');
  }

  const owner = await resolveOwner(v.ownerEmail, v.ownerName);

  // One transaction: workspace, module, plan, subscription term, lead close and
  // audit. Nothing partial survives a failure.
  const { data, error } = await supabase.rpc('platform_onboard_customer', {
    p_owner_user_id: owner.userId,
    p_org_name: v.organizationName,
    p_slug: v.slug,
    p_module: v.moduleKey,
    p_plan_id: v.planId,
    p_billing_period: v.billingPeriod,
    p_promo_code: v.promoCode || null,
    p_payment_method: 'cash',
    p_branch_name: v.branchName || null,
    p_lead_id: v.leadId || null,
    p_note: v.note || null,
  });

  if (error) throw new AppError('validation', error.message);

  const row = (Array.isArray(data) ? data[0] : data) as
    | { out_organization_id: string; out_customer_code: string; out_slug: string }
    | undefined;
  if (!row) throw new AppError('validation', 'تعذّر إنشاء مساحة العمل.');

  return {
    organizationId: row.out_organization_id,
    customerCode: row.out_customer_code,
    slug: row.out_slug,
    ownerInvited: owner.invited,
  };
}
