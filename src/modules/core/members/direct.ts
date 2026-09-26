import 'server-only';
import { z } from 'zod';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { AppError } from '@/lib/errors';
import { requirePermission, type TenantContext } from '@/modules/core/tenancy/context';
import { ownerProvisioningAvailable, SERVICE_ROLE_ENV } from '@/modules/platform/onboarding/service';

/**
 * Creating a staff account directly, with a password an admin sets.
 *
 * Alongside invitations, not instead of them: invitations exist for someone
 * who is not at a keyboard yet. This exists for the opposite case — an admin
 * handing a cashier a working login before their first shift, with no email
 * round trip in between.
 *
 * THE SAME TWO HALVES onboarding uses:
 *   1. IDENTITY — creating the auth.users row with a password is the Supabase
 *      Admin API, not something SQL can do. Requires SUPABASE_SERVICE_ROLE_KEY.
 *   2. WORKSPACE — member_provision_direct() attaches that user id to this
 *      organization: profile, organization_members, member_branches,
 *      user_roles, audit log. Every guard invitation_accept() enforces is
 *      reproduced there (role/branch ownership, app.role_grantable()).
 *
 * ROLLBACK. If the workspace half fails after the identity half succeeded, the
 * auth account is deleted rather than left an orphan with a password and no
 * membership anywhere — a login that goes nowhere is worse than none.
 */

export const createMemberDirectInput = z.object({
  // Optional. An admin who does not want to invent or track a real address
  // for a cashier leaves this blank; createMemberDirect() then generates a
  // guaranteed-unique login address itself, rather than the admin needing to
  // come up with something unique across the whole platform (auth.users.email
  // is unique platform-wide, not per organization) or the request failing.
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(200)
    .refine((v) => v === '' || z.string().email().safeParse(v).success, 'بريد إلكتروني غير صحيح')
    .optional(),
  password: z
    .string()
    .min(8, 'كلمة المرور 8 أحرف على الأقل')
    .max(72, 'كلمة المرور طويلة جدًا'),
  fullName: z.string().trim().min(2, 'الاسم مطلوب').max(120),
  roleIds: z.array(z.string().uuid()).max(20).default([]),
  branchIds: z.array(z.string().uuid()).max(50).default([]),
  allBranches: z.boolean().default(false),
});

export type CreateMemberDirectInput = z.infer<typeof createMemberDirectInput>;

/**
 * A login address for a staff member who was never given a real one.
 *
 * auth.users.email is unique across the WHOLE platform, not per organization
 * — so a placeholder cannot be a fixed pattern like "cashier@{org}", since
 * nothing stops two different requests (or two different organizations)
 * generating that exact string. A random token makes collision practically
 * impossible; `createMemberDirect` still retries once on the off chance,
 * rather than trusting that alone.
 */
function generatePlaceholderEmail(): string {
  return `staff-${crypto.randomUUID()}@staff.localbasic.internal`;
}

export async function createMemberDirect(
  ctx: TenantContext,
  input: CreateMemberDirectInput,
): Promise<{ memberId: string; email: string; generatedEmail: boolean }> {
  requirePermission(ctx, 'member.manage');

  if (!ownerProvisioningAvailable()) {
    throw new AppError(
      'validation',
      `إنشاء الحسابات مباشرةً غير مُهيأ على الخادم. اضبط ${SERVICE_ROLE_ENV}، أو استخدم "دعوة موظف" بدلًا من ذلك.`,
    );
  }

  const admin = createSupabaseAdminClient();
  const generatedEmail = !input.email;
  let email = input.email || generatePlaceholderEmail();

  let created: { id: string } | null = null;
  let lastError: { message: string } | null = null;

  // Two attempts only when the email itself was generated here — a
  // caller-provided address that collides is a real duplicate and reported
  // as one, not silently retried under a different address.
  for (let attempt = 0; attempt < (generatedEmail ? 2 : 1) && !created; attempt++) {
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password: input.password,
      email_confirm: true,
      user_metadata: { full_name: input.fullName },
    });
    if (data.user) { created = data.user; break; }
    lastError = error;
    const collided = /already.*registered|already.*exists/i.test(error?.message ?? '');
    if (generatedEmail && collided) { email = generatePlaceholderEmail(); continue; }
    break;
  }

  if (!created) {
    const already = /already.*registered|already.*exists/i.test(lastError?.message ?? '');
    // "Invalid API key" from the Admin API means SUPABASE_SERVICE_ROLE_KEY
    // itself is wrong for this project — a stale, rotated, or mistakenly
    // truncated/whitespace-corrupted value in the deployment's environment
    // variables — never something this request or its caller can fix.
    const badKey = /invalid api key/i.test(lastError?.message ?? '');
    throw new AppError(
      'validation',
      already
        ? 'هذا البريد مسجّل بحساب بالفعل. استخدم "دعوة موظف" بدلًا من الإنشاء المباشر.'
        : badKey
          ? `تعذّر إنشاء الحساب: مفتاح ${SERVICE_ROLE_ENV} في إعدادات النشر غير صحيح أو منتهي. تحقّق منه في لوحة Supabase (Settings → API → service_role) وأعد ضبطه في متغيرات البيئة.`
          : `تعذّر إنشاء الحساب: ${lastError?.message ?? 'خطأ غير معروف'}`,
    );
  }

  const userId = created.id;
  const supabase = createSupabaseServerClient();

  const { data: memberId, error: rpcError } = await supabase.rpc('member_provision_direct', {
    p_org: ctx.organizationId,
    p_user: userId,
    p_full_name: input.fullName,
    p_role_ids: input.roleIds,
    p_branch_ids: input.allBranches ? [] : input.branchIds,
    p_all_branches: input.allBranches,
  });

  if (rpcError || !memberId) {
    // The account exists with a password and no membership anywhere — worse
    // than not existing at all. Remove it rather than leave a dead login.
    await admin.auth.admin.deleteUser(userId).catch(() => {});
    throw new AppError('validation', rpcError?.message ?? 'تعذّر إنشاء الحساب');
  }

  return { memberId: memberId as string, email, generatedEmail };
}
