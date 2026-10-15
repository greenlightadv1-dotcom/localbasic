import 'server-only';
import type { z } from 'zod';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { AppError, staffDbError, toDataUnavailable } from '@/lib/errors';
import type { TenantContext } from '@/modules/core/tenancy/context';
import type { grantSchema, setPinSchema, zoneSchema } from './schema';

/**
 * Manager PIN approvals and cashier zones (0103). The checks — who may
 * approve, no self-approval, single use, two-minute expiry, lockout after
 * five wrong PINs — all live in the database; this file only carries calls.
 */

export async function listApprovers(ctx: TenantContext): Promise<{ memberId: string; name: string }[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('approval_approvers', { p_org: ctx.organizationId, p_branch: ctx.branchId });
  if (error) throw staffDbError(error, 'listApprovers');
  return ((data ?? []) as unknown as { out_member_id: string; out_name: string }[]).map((r) => ({ memberId: r.out_member_id, name: r.out_name }));
}

export async function grantApproval(ctx: TenantContext, input: z.infer<typeof grantSchema>): Promise<{ grantId: string }> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('approval_grant', {
    p_org: ctx.organizationId, p_branch: ctx.branchId, p_action: input.action, p_subject: input.subjectId,
    p_amount: input.amount ?? null, p_approver_member: input.approverMemberId, p_pin: input.pin,
  }).single();
  if (error) throw staffDbError(error, 'grantApproval');
  const row = data as unknown as { out_grant: string | null; out_error: string | null };
  if (!row.out_grant) throw new AppError('validation', row.out_error ?? 'تعذّرت الموافقة');
  return { grantId: row.out_grant };
}

export async function getPinStatus(ctx: TenantContext): Promise<{ hasPin: boolean; canApprove: boolean }> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('approval_pin_status', { p_org: ctx.organizationId }).single();
  if (error) throw toDataUnavailable(error, 'getPinStatus');
  const r = data as unknown as { out_has_pin: boolean; out_can_approve: boolean };
  return { hasPin: r.out_has_pin, canApprove: r.out_can_approve };
}

export async function setPin(ctx: TenantContext, input: z.infer<typeof setPinSchema>): Promise<void> {
  const supabase = createSupabaseServerClient();
  const { error } = await supabase.rpc('approval_set_pin', { p_org: ctx.organizationId, p_pin: input.pin });
  if (error) throw staffDbError(error, 'setPin');
}

export type CashierZoneRow = {
  memberId: string; name: string; role: string | null; restricted: boolean;
  allowTakeaway: boolean; allowOnline: boolean; sectionIds: string[];
};

export async function listCashierZones(ctx: TenantContext): Promise<CashierZoneRow[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('restaurant_cashier_zones', { p_org: ctx.organizationId });
  if (error) throw toDataUnavailable(error, 'listCashierZones');
  return ((data ?? []) as unknown as {
    out_member_id: string; out_name: string; out_role: string | null; out_restricted: boolean;
    out_allow_takeaway: boolean; out_allow_online: boolean; out_sections: string[] | null;
  }[]).map((r) => ({
    memberId: r.out_member_id, name: r.out_name, role: r.out_role, restricted: r.out_restricted,
    allowTakeaway: r.out_allow_takeaway, allowOnline: r.out_allow_online, sectionIds: r.out_sections ?? [],
  }));
}

export async function saveCashierZone(ctx: TenantContext, input: z.infer<typeof zoneSchema>): Promise<void> {
  const supabase = createSupabaseServerClient();
  const { error } = await supabase.rpc('restaurant_cashier_zone_save', {
    p_org: ctx.organizationId, p_member: input.memberId, p_restricted: input.restricted,
    p_sections: input.sectionIds, p_allow_takeaway: input.allowTakeaway, p_allow_online: input.allowOnline,
  });
  if (error) throw staffDbError(error, 'saveCashierZone');
}
