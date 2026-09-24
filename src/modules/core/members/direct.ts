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
  email: z.string().trim().toLowerCase().email('بريد إلكتروني غير صحيح').max(200),
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

export async function createMemberDirect(
  ctx: TenantContext,
  input: CreateMemberDirectInput,
): Promise<{ memberId: string }> {
  requirePermission(ctx, 'member.manage');

  if (!ownerProvisioningAvailable()) {
    throw new AppError(
      'validation',
      `إنشاء الحسابات مباشرةً غير مُهيأ على الخادم. اضبط ${SERVICE_ROLE_ENV}، أو استخدم "دعوة موظف" بدلًا من ذلك.`,
    );
  }

  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.auth.admin.createUser({
    email: input.email,
    password: input.password,
    email_confirm: true,
    user_metadata: { full_name: input.fullName },
  });

  if (error || !data.user) {
    const already = /already.*registered|already.*exists/i.test(error?.message ?? '');
    throw new AppError(
      'validation',
      already
        ? 'هذا البريد مسجّل بحساب بالفعل. استخدم "دعوة موظف" بدلًا من الإنشاء المباشر.'
        : `تعذّر إنشاء الحساب: ${error?.message ?? 'خطأ غير معروف'}`,
    );
  }

  const userId = data.user.id;
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

  return { memberId: memberId as string };
}
