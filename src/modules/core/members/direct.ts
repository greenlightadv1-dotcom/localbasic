import 'server-only';
import { z } from 'zod';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { AppError } from '@/lib/errors';
import { usernameField } from '@/lib/auth/username';
import { requirePermission, type TenantContext } from '@/modules/core/tenancy/context';
import {
  createLoginAccount,
  discardLoginAccount,
  requireProvisioning,
  setLoginPassword,
} from './credentials';

/**
 * Creating a staff account directly, with a username and password an admin
 * sets, and re-keying it later.
 *
 * Staff sign in with USERNAME + password. There is no email on the form: the
 * account's login address is derived from the username (see lib/auth/username),
 * so an admin never has to invent or track a real mailbox for a cashier.
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
 *
 * Staff cannot change or recover their own password. The only way a staff
 * password changes is resetMemberPassword() below, by someone with
 * member.manage.
 */

/** A PIN is accepted, so the floor is Supabase's own minimum rather than 8. */
export const STAFF_PASSWORD_MIN = 6;

export const staffPasswordField = z
  .string()
  .min(STAFF_PASSWORD_MIN, `كلمة المرور/الرقم السري ${STAFF_PASSWORD_MIN} أحرف أو أرقام على الأقل`)
  .max(72, 'كلمة المرور طويلة جدًا');

export const createMemberDirectInput = z.object({
  username: usernameField,
  password: staffPasswordField,
  fullName: z.string().trim().min(2, 'الاسم مطلوب').max(120),
  roleIds: z.array(z.string().uuid()).max(20).default([]),
  branchIds: z.array(z.string().uuid()).max(50).default([]),
  allBranches: z.boolean().default(false),
});

export type CreateMemberDirectInput = z.infer<typeof createMemberDirectInput>;

export async function createMemberDirect(
  ctx: TenantContext,
  input: CreateMemberDirectInput,
): Promise<{ memberId: string; username: string }> {
  requirePermission(ctx, 'member.manage');
  requireProvisioning();

  if (!input.allBranches && input.branchIds.length === 0) {
    throw new AppError('validation', 'اختر فرعًا واحدًا على الأقل، أو "كل الفروع".');
  }

  const { userId } = await createLoginAccount({
    username: input.username,
    password: input.password,
    fullName: input.fullName,
    // Staff have no way to change a password, so a forced change would lock
    // them out of the app permanently.
    mustChangePassword: false,
  });

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
    await discardLoginAccount(userId);
    throw new AppError('validation', rpcError?.message ?? 'تعذّر إنشاء الحساب');
  }

  return { memberId: memberId as string, username: input.username };
}

/**
 * The admin assigns a staff member a new password directly. No email, no link,
 * and the member is not asked to change it — they cannot.
 *
 * Authorization lives in member_reset_password_authorize() (0088): it checks
 * member.manage, refuses the organization's owner and anyone holding more
 * permissions than the caller, and writes the audit row. This function only
 * performs the Admin API write the database cannot.
 */
export async function resetMemberPassword(
  ctx: TenantContext,
  memberId: string,
  newPassword: string,
): Promise<void> {
  requirePermission(ctx, 'member.manage');
  requireProvisioning();

  const parsed = staffPasswordField.safeParse(newPassword);
  if (!parsed.success) {
    throw new AppError('validation', parsed.error.issues[0]?.message ?? 'كلمة مرور غير صالحة');
  }

  const supabase = createSupabaseServerClient();
  const { data: targetUserId, error } = await supabase.rpc('member_reset_password_authorize', {
    p_org: ctx.organizationId,
    p_member: memberId,
  });
  if (error || !targetUserId) {
    throw new AppError('validation', error?.message ?? 'تعذّر تغيير كلمة المرور');
  }

  await setLoginPassword(targetUserId as string, parsed.data, false);
}
