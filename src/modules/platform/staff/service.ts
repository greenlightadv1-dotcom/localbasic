import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requirePlatformAdmin } from '@/modules/platform/admin/context';
import { AppError } from '@/lib/errors';

/**
 * Platform console: granular staff role management for a customer.
 *
 * Every write here calls a SECURITY DEFINER function (0074) that re-checks
 * app.require_platform_admin() itself, and refuses the organization's own
 * `is_owner` role to anyone but a platform owner. requirePlatformAdmin()
 * here is for the UI's benefit only, exactly like every other function in
 * this module.
 */

export type StaffRoleGrant = {
  userRoleId: string;
  roleId: string;
  roleKey: string;
  roleNameAr: string;
  isOwner: boolean;
  branchId: string | null;
  branchName: string | null;
};

export type StaffMember = {
  memberId: string;
  userId: string;
  fullName: string | null;
  phone: string | null;
  status: string;
  allBranches: boolean;
  roles: StaffRoleGrant[];
};

export async function listCustomerStaff(code: string): Promise<StaffMember[]> {
  await requirePlatformAdmin();
  const supabase = createSupabaseServerClient();

  const { data, error } = await supabase.rpc('platform_customer_staff', {
    p_customer_code: code.trim(),
  });
  if (error) throw error;

  type Row = {
    member_id: string; user_id: string; full_name: string | null; phone: string | null;
    status: string; all_branches: boolean;
    roles: {
      userRoleId: string; roleId: string; roleKey: string; roleNameAr: string;
      isOwner: boolean; branchId: string | null; branchName: string | null;
    }[] | null;
  };
  const rows = (Array.isArray(data) ? data : data == null ? [] : [data]) as Row[];

  return rows.map((r) => ({
    memberId: r.member_id,
    userId: r.user_id,
    fullName: r.full_name,
    phone: r.phone,
    status: r.status,
    allBranches: r.all_branches,
    roles: (r.roles ?? []).map((g) => ({
      userRoleId: g.userRoleId,
      roleId: g.roleId,
      roleKey: g.roleKey,
      roleNameAr: g.roleNameAr,
      isOwner: g.isOwner,
      branchId: g.branchId,
      branchName: g.branchName,
    })),
  }));
}

export type CustomerRole = {
  roleId: string;
  key: string;
  nameAr: string;
  isOwner: boolean;
};

export async function listCustomerRoleCatalog(code: string): Promise<CustomerRole[]> {
  await requirePlatformAdmin();
  const supabase = createSupabaseServerClient();

  const { data, error } = await supabase.rpc('platform_customer_role_catalog', {
    p_customer_code: code.trim(),
  });
  if (error) throw error;

  type Row = { role_id: string; key: string; name_ar: string; is_owner: boolean };
  const rows = (Array.isArray(data) ? data : data == null ? [] : [data]) as Row[];

  return rows.map((r) => ({
    roleId: r.role_id,
    key: r.key,
    nameAr: r.name_ar,
    isOwner: r.is_owner,
  }));
}

export async function grantStaffRole(input: {
  customerCode: string;
  memberId: string;
  roleId: string;
  branchId?: string | null;
}): Promise<void> {
  await requirePlatformAdmin();
  const supabase = createSupabaseServerClient();
  const { error } = await supabase.rpc('platform_grant_staff_role', {
    p_customer_code: input.customerCode.trim(),
    p_member_id: input.memberId,
    p_role_id: input.roleId,
    p_branch_id: input.branchId || null,
  });
  if (error) throw new AppError('validation', error.message);
}

export async function revokeStaffRole(input: {
  customerCode: string;
  memberId: string;
  roleId: string;
  branchId?: string | null;
}): Promise<void> {
  await requirePlatformAdmin();
  const supabase = createSupabaseServerClient();
  const { error } = await supabase.rpc('platform_revoke_staff_role', {
    p_customer_code: input.customerCode.trim(),
    p_member_id: input.memberId,
    p_role_id: input.roleId,
    p_branch_id: input.branchId || null,
  });
  if (error) throw new AppError('validation', error.message);
}
