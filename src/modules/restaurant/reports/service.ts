import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { toAppError } from '@/lib/errors';
import { can, type TenantContext } from '@/modules/core/tenancy/context';

export type DateRangeKey = 'today' | 'yesterday' | 'week' | 'month' | 'custom';

export function resolveRange(key: DateRangeKey, from?: string, to?: string) {
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  switch (key) {
    case 'yesterday':
      start.setDate(start.getDate() - 1);
      end.setDate(end.getDate() - 1);
      break;
    case 'week':
      start.setDate(start.getDate() - 6);
      break;
    case 'month':
      start.setDate(1);
      break;
    case 'custom':
      if (from) start.setTime(new Date(from).setHours(0, 0, 0, 0));
      if (to) {
        const t = new Date(to);
        t.setHours(0, 0, 0, 0);
        t.setDate(t.getDate() + 1);
        end.setTime(t.getTime());
      }
      break;
    default:
      break;
  }
  return { start, end };
}

export type RestaurantReport = {
  revenueCents: number;
  expensesCents: number;
  netCents: number;
  paidOrders: number;
  openOrders: number;
  cancelledOrders: number;
  averageOrderCents: number;
  discountsCents: number;
  byPaymentMethod: { method: string; amountCents: number }[];
  byCashier: { name: string; amountCents: number; count: number }[];
  topProducts: { name: string; quantity: number; amountCents: number }[];
};

/**
 * Restaurant analytics for one branch and date range.
 *
 * Every figure is read back from the Core money tables — invoices, payments
 * and the treasury ledger — rather than from the orders, so a report can never
 * disagree with what was actually banked. Sections the caller lacks permission
 * for are skipped, not computed and hidden.
 */
export async function getRestaurantReport(
  ctx: TenantContext,
  range: { start: Date; end: Date },
): Promise<RestaurantReport> {
  const supabase = createSupabaseServerClient();
  const from = range.start.toISOString();
  const to = range.end.toISOString();

  const report: RestaurantReport = {
    revenueCents: 0,
    expensesCents: 0,
    netCents: 0,
    paidOrders: 0,
    openOrders: 0,
    cancelledOrders: 0,
    averageOrderCents: 0,
    discountsCents: 0,
    byPaymentMethod: [],
    byCashier: [],
    topProducts: [],
  };

  const { data: orders, error: orderError } = await supabase
    .from('restaurant_orders')
    .select('id, status, total_cents, discount_cents, invoice_id')
    .eq('organization_id', ctx.organizationId)
    .eq('branch_id', ctx.branchId)
    .gte('placed_at', from)
    .lt('placed_at', to);
  if (orderError) throw toAppError(orderError, 'restaurant report orders');

  report.openOrders = (orders ?? []).filter((o) =>
    ['new', 'confirmed', 'preparing', 'ready', 'served'].includes(o.status),
  ).length;
  report.cancelledOrders = (orders ?? []).filter((o) => o.status === 'cancelled').length;
  report.discountsCents = (orders ?? []).reduce((sum, o) => sum + o.discount_cents, 0);

  if (can(ctx, 'payment.read')) {
    const { data: payments, error } = await supabase
      .from('payments')
      .select('amount_cents, method, created_by, invoice_id')
      .eq('organization_id', ctx.organizationId)
      .eq('branch_id', ctx.branchId)
      .eq('status', 'completed')
      .gte('created_at', from)
      .lt('created_at', to);
    if (error) throw toAppError(error, 'restaurant report payments');

    report.revenueCents = (payments ?? []).reduce((sum, p) => sum + p.amount_cents, 0);

    const byMethod = new Map<string, number>();
    const byUser = new Map<string, { amount: number; count: number }>();
    for (const p of payments ?? []) {
      byMethod.set(p.method, (byMethod.get(p.method) ?? 0) + p.amount_cents);
      if (p.created_by) {
        const current = byUser.get(p.created_by) ?? { amount: 0, count: 0 };
        byUser.set(p.created_by, {
          amount: current.amount + p.amount_cents,
          count: current.count + 1,
        });
      }
    }
    report.byPaymentMethod = [...byMethod.entries()]
      .map(([method, amountCents]) => ({ method, amountCents }))
      .sort((a, b) => b.amountCents - a.amountCents);

    const paidInvoices = new Set((payments ?? []).map((p) => p.invoice_id).filter(Boolean));
    report.paidOrders = paidInvoices.size;
    report.averageOrderCents = paidInvoices.size
      ? Math.round(report.revenueCents / paidInvoices.size)
      : 0;

    if (byUser.size) {
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, full_name')
        .in('id', [...byUser.keys()]);
      const nameById = new Map((profiles ?? []).map((p) => [p.id, p.full_name ?? '—']));
      report.byCashier = [...byUser.entries()]
        .map(([id, v]) => ({
          name: nameById.get(id) ?? '—',
          amountCents: v.amount,
          count: v.count,
        }))
        .sort((a, b) => b.amountCents - a.amountCents);
    }
  }

  if (can(ctx, 'treasury.read')) {
    const { data: ledger, error } = await supabase
      .from('treasury_transactions')
      .select('direction, amount_cents, category')
      .eq('organization_id', ctx.organizationId)
      .eq('branch_id', ctx.branchId)
      .gte('occurred_at', from)
      .lt('occurred_at', to);
    if (error) throw toAppError(error, 'restaurant report treasury');

    report.expensesCents = (ledger ?? [])
      .filter((t) => t.direction === 'out')
      .reduce((sum, t) => sum + t.amount_cents, 0);
    report.netCents = report.revenueCents - report.expensesCents;
  }

  // Best sellers come from the order lines, which carry the price snapshots.
  const orderIds = (orders ?? []).map((o) => o.id);
  if (orderIds.length) {
    const { data: items } = await supabase
      .from('restaurant_order_items')
      .select('product_name, quantity, line_total_cents, order_id')
      .in('order_id', orderIds)
      .limit(2000);

    const cancelled = new Set(
      (orders ?? []).filter((o) => o.status === 'cancelled').map((o) => o.id),
    );
    const byProduct = new Map<string, { quantity: number; amount: number }>();
    for (const item of items ?? []) {
      if (cancelled.has(item.order_id)) continue;
      const current = byProduct.get(item.product_name) ?? { quantity: 0, amount: 0 };
      byProduct.set(item.product_name, {
        quantity: current.quantity + Number(item.quantity),
        amount: current.amount + item.line_total_cents,
      });
    }
    report.topProducts = [...byProduct.entries()]
      .map(([name, v]) => ({ name, quantity: v.quantity, amountCents: v.amount }))
      .sort((a, b) => b.amountCents - a.amountCents)
      .slice(0, 8);
  }

  return report;
}
