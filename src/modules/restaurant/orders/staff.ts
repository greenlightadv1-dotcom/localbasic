import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { AppError } from '@/lib/errors';
import type { TenantContext } from '@/modules/core/tenancy/context';
import { parsePerformance, type StaffPerformance, type TrailEntry } from './staff-metrics';

/**
 * Who did what on an order, and one employee's month.
 *
 * Both read the audit trail the order lifecycle already writes (see migration
 * 0089); authorization is the database's — audit.read for a trail, report.read
 * or member.manage for performance, per branch — and the page-level `can()`
 * checks only decide whether to render the card.
 */

export async function getOrderStaffTrail(ctx: TenantContext, orderId: string): Promise<TrailEntry[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('restaurant_order_staff_trail', {
    p_org: ctx.organizationId,
    p_order: orderId,
  });
  if (error) throw new AppError('validation', error.message);

  type Row = { out_stage: string; out_actor_id: string | null; out_actor_name: string | null; out_at: string };
  const rows = (Array.isArray(data) ? data : data == null ? [] : [data]) as Row[];
  return rows.map((r) => ({
    stage: r.out_stage,
    actorId: r.out_actor_id,
    actorName: r.out_actor_name,
    at: r.out_at,
  }));
}

/** `monthStart` is any date in the month wanted, as YYYY-MM-DD. */
export async function getStaffPerformance(
  ctx: TenantContext,
  userId: string,
  monthStart: string,
): Promise<StaffPerformance> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('restaurant_staff_performance', {
    p_org: ctx.organizationId,
    p_user: userId,
    p_month: monthStart,
  });
  if (error) throw new AppError('validation', error.message);
  return parsePerformance(data);
}
