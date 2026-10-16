import 'server-only';
import { z } from 'zod';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { AppError, staffDbError, toDataUnavailable } from '@/lib/errors';
import type { TenantContext } from '@/modules/core/tenancy/context';

/**
 * Cashier fraud prevention (0108). Events are written by the database as a
 * side effect of the till's own actions (printing, cancelling, discounting,
 * refunding, opening the drawer); this module reads the scores and calls the
 * few functions a screen triggers directly.
 */

import type { RiskEvent, RiskLogEntry, RiskRow } from './events';

export { RISK_EVENTS, RISK_EVENT_LABELS, RISK_EVENT_POINTS, RISK_FLAG_THRESHOLD } from './events';
export type { RiskEvent, RiskLogEntry, RiskRow } from './events';

async function call(fn: string, args: Record<string, unknown>, context: string): Promise<unknown> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc(fn as never, args as never);
  if (error) throw staffDbError(error, context);
  return data;
}

// ---------------------------------------------------------------------------
// Reads (restaurant.audit.risk_view)
// ---------------------------------------------------------------------------

export async function getRiskDashboard(ctx: TenantContext, from: Date, to: Date): Promise<RiskRow[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('restaurant_risk_dashboard' as never, {
    p_org: ctx.organizationId, p_from: from.toISOString(), p_to: to.toISOString(),
  } as never);
  if (error) throw toDataUnavailable(error, 'getRiskDashboard');
  return ((data ?? []) as unknown as Record<string, unknown>[]).map((r) => ({
    userId: String(r.out_user_id), name: String(r.out_name), points: Number(r.out_points), flagged: Boolean(r.out_flagged),
    flaggedAt: (r.out_flagged_at as string) ?? null,
    counts: {
      void_after_print: Number(r.out_void_after_print), drawer_kick_no_sale: Number(r.out_drawer_no_sale),
      reprint_receipt: Number(r.out_reprints), discount_over_limit: Number(r.out_discount_over), refund_processed: Number(r.out_refunds),
    },
    refundCents: Number(r.out_refund_cents), discountOverCents: Number(r.out_discount_over_cents), windowPoints: Number(r.out_window_points),
    refundLimitCents: r.out_refund_limit_cents === null ? null : Number(r.out_refund_limit_cents),
    discountLimitCents: r.out_discount_limit_cents === null ? null : Number(r.out_discount_limit_cents),
    lastEventAt: (r.out_last_event_at as string) ?? null, lastResetAt: (r.out_last_reset_at as string) ?? null,
  }));
}


/** The latest events across the organization (RLS: risk viewers by branch). */
export async function listRiskLog(ctx: TenantContext, opts: { userId?: string; from: Date; to: Date; limit?: number }): Promise<RiskLogEntry[]> {
  const supabase = createSupabaseServerClient();
  let q = supabase.from('restaurant_cashier_risk_logs')
    .select('id, user_id, event_type, points, created_at, amount_cents, reason, order_id, branch_id, approved_by')
    .eq('organization_id', ctx.organizationId)
    .gte('created_at', opts.from.toISOString()).lt('created_at', opts.to.toISOString())
    .order('created_at', { ascending: false }).limit(Math.min(opts.limit ?? 200, 500));
  if (opts.userId) q = q.eq('user_id', opts.userId);
  const { data, error } = await q;
  if (error) throw toDataUnavailable(error, 'listRiskLog');
  const rows = data ?? [];
  const orderIds = [...new Set(rows.map((r) => r.order_id).filter(Boolean))] as string[];
  const branchIds = [...new Set(rows.map((r) => r.branch_id).filter(Boolean))] as string[];
  const approverIds = [...new Set(rows.map((r) => r.approved_by).filter(Boolean))] as string[];
  const [orders, branches, approvers] = await Promise.all([
    orderIds.length ? supabase.from('restaurant_orders').select('id, number').in('id', orderIds) : Promise.resolve({ data: [] as { id: string; number: string }[] }),
    branchIds.length ? supabase.from('branches').select('id, name').in('id', branchIds) : Promise.resolve({ data: [] as { id: string; name: string }[] }),
    approverIds.length ? supabase.from('profiles').select('id, full_name').in('id', approverIds) : Promise.resolve({ data: [] as { id: string; full_name: string | null }[] }),
  ]);
  const num = new Map((orders.data ?? []).map((o) => [o.id, o.number]));
  const br = new Map((branches.data ?? []).map((b) => [b.id, b.name]));
  const ap = new Map((approvers.data ?? []).map((p) => [p.id, p.full_name]));
  return rows.map((r) => ({
    id: r.id, userId: r.user_id, event: r.event_type as RiskEvent, points: r.points, at: r.created_at, amountCents: r.amount_cents,
    reason: r.reason, orderNumber: r.order_id ? num.get(r.order_id) ?? null : null,
    branchName: r.branch_id ? br.get(r.branch_id) ?? null : null,
    approvedBy: r.approved_by ? ap.get(r.approved_by) ?? 'مدير' : null,
  }));
}

/** The signed-in person's own score (anyone may read their own). */
export async function getMyRisk(ctx: TenantContext): Promise<{ points: number; flagged: boolean } | null> {
  const supabase = createSupabaseServerClient();
  const { data } = await supabase.from('restaurant_cashier_risk_profiles')
    .select('accumulated_risk_points, is_flagged').eq('organization_id', ctx.organizationId).eq('user_id', ctx.userId).maybeSingle();
  return data ? { points: data.accumulated_risk_points, flagged: data.is_flagged } : null;
}

// ---------------------------------------------------------------------------
// Till
// ---------------------------------------------------------------------------
export const printTrackSchema = z.object({
  orderId: z.string().uuid().nullable().optional(),
  invoiceId: z.string().uuid().nullable().optional(),
  kind: z.enum(['bill', 'receipt']),
}).refine((v) => Boolean(v.orderId || v.invoiceId), { message: 'orderId or invoiceId', path: ['orderId'] });

export const trackPrint = async (ctx: TenantContext, i: z.infer<typeof printTrackSchema>) =>
  Number(await call('restaurant_order_print_track', { p_org: ctx.organizationId, p_order: i.orderId ?? null, p_invoice: i.invoiceId ?? null, p_kind: i.kind }, 'trackPrint'));

export const drawerSchema = z.object({ reason: z.string().trim().min(2, 'اكتب سبب فتح الدرج').max(300) });
export const openDrawer = (ctx: TenantContext, i: z.infer<typeof drawerSchema>) =>
  call('restaurant_drawer_open', { p_org: ctx.organizationId, p_branch: ctx.branchId, p_reason: i.reason }, 'openDrawer');

export const refundSchema = z.object({
  invoiceId: z.string().uuid(),
  amountCents: z.coerce.number().int().min(1).max(100_000_000_000),
  method: z.enum(['cash', 'card', 'transfer', 'wallet', 'other']),
  reason: z.string().trim().min(2, 'اكتب سبب الاسترداد').max(200),
});
export async function refundPayment(ctx: TenantContext, i: z.infer<typeof refundSchema>) {
  const data = await call('restaurant_refund_payment', {
    p_org: ctx.organizationId, p_invoice: i.invoiceId, p_amount: i.amountCents, p_method: i.method, p_reason: i.reason,
  }, 'refundPayment');
  const row = (Array.isArray(data) ? data[0] : data) as { out_payment_id: string; out_refund_cents: number; out_paid_cents: number };
  return { paymentId: row.out_payment_id, refundCents: Number(row.out_refund_cents), paidCents: Number(row.out_paid_cents) };
}

// ---------------------------------------------------------------------------
// Manager (restaurant.audit.risk_reset)
// ---------------------------------------------------------------------------
export const resetSchema = z.object({
  userId: z.string().uuid(),
  pin: z.string().regex(/^[0-9]{4,8}$/, 'الرمز من 4 إلى 8 أرقام'),
  note: z.string().trim().min(3, 'اكتب سبب التصفير').max(300),
});
export async function resetRisk(ctx: TenantContext, i: z.infer<typeof resetSchema>) {
  const refusal = await call('restaurant_risk_reset', { p_org: ctx.organizationId, p_user: i.userId, p_pin: i.pin, p_note: i.note }, 'resetRisk');
  if (typeof refusal === 'string' && refusal) throw new AppError('validation', refusal);
}

const limit = z.coerce.number().int().min(0).max(100_000_000_000).nullable();
export const limitsSchema = z.object({ userId: z.string().uuid(), refundLimitCents: limit, discountLimitCents: limit });
export const setLimits = (ctx: TenantContext, i: z.infer<typeof limitsSchema>) =>
  call('restaurant_risk_set_limits', { p_org: ctx.organizationId, p_user: i.userId, p_refund_limit: i.refundLimitCents, p_discount_limit: i.discountLimitCents }, 'setLimits');
