import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { fetchAllRows, fetchAllRowsIn } from '@/lib/supabase/paginate';
import { can, type TenantContext } from '@/modules/core/tenancy/context';

export { resolveRange, type DateRangeKey } from '@/modules/restaurant/reports/service';

/**
 * Retail analytics for one branch and date range.
 *
 * Two rules decide the whole shape of this file:
 *
 *   1. EVERY FIGURE IS READ BACK from a table that already holds the truth —
 *      payments and the treasury ledger for money, stock movements for goods,
 *      purchase orders for what was bought. Nothing is estimated, extrapolated
 *      or carried over from a previous screen, so a report cannot disagree
 *      with what was actually banked or actually moved.
 *
 *   2. A SECTION THE CALLER MAY NOT SEE IS NOT COMPUTED. Permission is checked
 *      before each block rather than filtering the result afterwards, and RLS
 *      refuses anything that slipped through anyway.
 *
 * Reads go through the ordinary server client, so every row this aggregates is
 * a row the signed-in member was already allowed to read.
 */

export type RetailReport = {
  /** Money actually taken in the range, from `payments`. */
  revenueCents: number;
  /** What those goods cost, from the movement's own recorded unit cost. */
  cogsCents: number;
  grossProfitCents: number;
  /** Money that left the treasury in the range. */
  outflowCents: number;
  salesCount: number;
  averageSaleCents: number;
  byPaymentMethod: { method: string; amountCents: number }[];
  /** Where the sales came from: the till, or the storefront. */
  bySource: { source: string; amountCents: number; count: number }[];
  topProducts: { name: string; quantity: number; amountCents: number }[];
  /** Units that left the shelf and units that arrived, from the one ledger. */
  unitsSold: number;
  unitsReceived: number;
  /** Variants at or below their reorder point right now. */
  lowStock: { name: string; quantity: number; reorderPoint: number }[];
  purchasing: {
    ordersRaised: number;
    committedCents: number;
    paidCents: number;
    openOrders: number;
  } | null;
  storeOrders: {
    placed: number;
    completed: number;
    cancelled: number;
  } | null;
};

const EMPTY: RetailReport = {
  revenueCents: 0,
  cogsCents: 0,
  grossProfitCents: 0,
  outflowCents: 0,
  salesCount: 0,
  averageSaleCents: 0,
  byPaymentMethod: [],
  bySource: [],
  topProducts: [],
  unitsSold: 0,
  unitsReceived: 0,
  lowStock: [],
  purchasing: null,
  storeOrders: null,
};

export async function getRetailReport(
  ctx: TenantContext,
  range: { start: Date; end: Date },
): Promise<RetailReport> {
  const supabase = createSupabaseServerClient();
  const from = range.start.toISOString();
  const to = range.end.toISOString();
  const report: RetailReport = { ...EMPTY, byPaymentMethod: [], bySource: [], topProducts: [], lowStock: [] };

  // ---- money -------------------------------------------------------------
  if (can(ctx, 'payment.read')) {
    // Paginated for the same reason the Restaurant report is: this panel is
    // rendered from the SAME range object, so it scans the same corrected
    // window and would be truncated by db-max-rows in exactly the same way.
    const payments = await fetchAllRows<{
      amount_cents: number;
      method: string;
      invoice_id: string | null;
      kind: string;
    }>('retail report payments', (offset, limit) =>
      supabase
        .from('payments')
        .select('amount_cents, method, invoice_id, kind', { count: 'exact' })
        .eq('organization_id', ctx.organizationId)
        .eq('branch_id', ctx.branchId)
        .eq('status', 'completed')
        .gte('created_at', from)
        .lt('created_at', to)
        .order('id', { ascending: true })
        .range(offset, offset + limit - 1),
    );

    // A refund is a negative payment in the same table, so netting them here
    // is what makes revenue mean "what the shop kept".
    report.revenueCents = (payments ?? []).reduce((sum, p) => sum + p.amount_cents, 0);

    const byMethod = new Map<string, number>();
    for (const p of payments ?? []) {
      byMethod.set(p.method, (byMethod.get(p.method) ?? 0) + p.amount_cents);
    }
    report.byPaymentMethod = [...byMethod.entries()]
      .map(([method, amountCents]) => ({ method, amountCents }))
      .sort((a, b) => b.amountCents - a.amountCents);

    const invoiceIds = [...new Set((payments ?? []).map((p) => p.invoice_id).filter(Boolean))] as string[];
    report.salesCount = invoiceIds.length;
    report.averageSaleCents = invoiceIds.length
      ? Math.round(report.revenueCents / invoiceIds.length)
      : 0;

    // Which door each sale came through. `source` is set by whoever created
    // the invoice — 'pos' by the till, 'online' by the storefront.
    if (invoiceIds.length && can(ctx, 'invoice.read')) {
      const invoices = await fetchAllRowsIn<
        { id: string; source: string; total_cents: number },
        string
      >('retail report invoices', invoiceIds, (ids, offset, limit) =>
        supabase
          .from('invoices')
          .select('id, source, total_cents', { count: 'exact' })
          .in('id', ids)
          .order('id', { ascending: true })
          .range(offset, offset + limit - 1),
      );

      const bySource = new Map<string, { amount: number; count: number }>();
      for (const inv of invoices ?? []) {
        const current = bySource.get(inv.source) ?? { amount: 0, count: 0 };
        bySource.set(inv.source, {
          amount: current.amount + inv.total_cents,
          count: current.count + 1,
        });
      }
      report.bySource = [...bySource.entries()]
        .map(([source, v]) => ({ source, amountCents: v.amount, count: v.count }))
        .sort((a, b) => b.amountCents - a.amountCents);
    }
  }

  if (can(ctx, 'treasury.read')) {
    const treasury = await fetchAllRows<{ direction: string; amount_cents: number }>(
      'retail report treasury',
      (offset, limit) =>
        supabase
          .from('treasury_transactions')
          .select('direction, amount_cents', { count: 'exact' })
          .eq('organization_id', ctx.organizationId)
          .eq('branch_id', ctx.branchId)
          .gte('occurred_at', from)
          .lt('occurred_at', to)
          .order('id', { ascending: true })
          .range(offset, offset + limit - 1),
    );

    report.outflowCents = (treasury ?? [])
      .filter((t) => t.direction === 'out')
      .reduce((sum, t) => sum + t.amount_cents, 0);
  }

  // ---- goods -------------------------------------------------------------
  if (can(ctx, 'retail.inventory.read')) {
    const movements = await fetchAllRows<{
      variant_id: string;
      quantity_delta: number;
      reason: string;
      unit_cost_cents: number | null;
    }>('retail report movements', (offset, limit) =>
      supabase
        .from('retail_stock_movements')
        .select('variant_id, quantity_delta, reason, unit_cost_cents', { count: 'exact' })
        .eq('organization_id', ctx.organizationId)
        .eq('branch_id', ctx.branchId)
        .gte('occurred_at', from)
        .lt('occurred_at', to)
        .order('id', { ascending: true })
        .range(offset, offset + limit - 1),
    );

    const sold = new Map<string, number>();
    for (const m of movements ?? []) {
      const delta = Number(m.quantity_delta);
      if (m.reason === 'sale') {
        // Sales are negative; report them as units that left.
        report.unitsSold += -delta;
        sold.set(m.variant_id, (sold.get(m.variant_id) ?? 0) + -delta);
        // Cost of goods, from the cost recorded ON THE MOVEMENT where there is
        // one. A sale movement written before costs were tracked contributes
        // nothing rather than a guess.
        if (m.unit_cost_cents != null) {
          report.cogsCents += Math.round(-delta * Number(m.unit_cost_cents));
        }
      } else if (m.reason === 'purchase') {
        report.unitsReceived += delta;
      } else if (m.reason === 'return') {
        report.unitsSold += -delta;
        sold.set(m.variant_id, (sold.get(m.variant_id) ?? 0) + -delta);
      }
    }
    report.grossProfitCents = report.revenueCents - report.cogsCents;

    const topIds = [...sold.entries()]
      .filter(([, q]) => q > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([id]) => id);

    if (topIds.length) {
      const variants = await fetchAllRowsIn<
        { id: string; name: string; price_cents: number; retail_products: unknown },
        string
      >('retail report top products', topIds, (ids, offset, limit) =>
        supabase
          .from('retail_variants')
          .select('id, name, price_cents, retail_products!inner(name)', { count: 'exact' })
          .in('id', ids)
          .order('id', { ascending: true })
          .range(offset, offset + limit - 1),
      );

      report.topProducts = topIds
        .map((id) => {
          const v = (variants ?? []).find((x) => x.id === id);
          if (!v) return null;
          const product = v.retail_products as unknown as { name: string } | null;
          const quantity = sold.get(id) ?? 0;
          const label =
            v.name && v.name !== 'default'
              ? `${product?.name ?? '—'} — ${v.name}`
              : (product?.name ?? '—');
          return {
            name: label,
            quantity,
            amountCents: Math.round(quantity * Number(v.price_cents)),
          };
        })
        .filter((x): x is { name: string; quantity: number; amountCents: number } => x !== null);
    }

    // Low stock is a NOW figure, not a range one: what needs reordering today.
    // A NOW figure, not a range one, but the same truncation applies: the
    // .limit(1000) this replaces hid every low-stock line past the thousandth.
    const levels = await fetchAllRows<{ variant_id: string; quantity: number }>(
      'retail report stock levels',
      (offset, limit) =>
        supabase
          .from('retail_stock_levels')
          .select('variant_id, quantity', { count: 'exact' })
          .eq('organization_id', ctx.organizationId)
          .eq('branch_id', ctx.branchId)
          // Unique per (organization, branch), which the filter above fixes.
          .order('variant_id', { ascending: true })
          .range(offset, offset + limit - 1),
    );

    if (levels?.length) {
      const variants = await fetchAllRowsIn<
        { id: string; name: string; reorder_point: number; retail_products: unknown },
        string
      >(
        'retail report low stock',
        levels.map((l) => l.variant_id),
        (ids, offset, limit) =>
          supabase
            .from('retail_variants')
            .select('id, name, reorder_point, retail_products!inner(name)', { count: 'exact' })
            .in('id', ids)
            .eq('is_active', true)
            .is('deleted_at', null)
            .order('id', { ascending: true })
            .range(offset, offset + limit - 1),
      );

      report.lowStock = (variants ?? [])
        .map((v) => {
          const product = v.retail_products as unknown as { name: string } | null;
          const quantity = Number(
            levels.find((l) => l.variant_id === v.id)?.quantity ?? 0,
          );
          const reorderPoint = Number(v.reorder_point);
          const label =
            v.name && v.name !== 'default'
              ? `${product?.name ?? '—'} — ${v.name}`
              : (product?.name ?? '—');
          return { name: label, quantity, reorderPoint };
        })
        .filter((v) => v.reorderPoint > 0 && v.quantity <= v.reorderPoint)
        .sort((a, b) => a.quantity - b.quantity)
        .slice(0, 20);
    }
  }

  // ---- purchasing --------------------------------------------------------
  if (can(ctx, 'retail.purchase.read')) {
    const orders = await fetchAllRows<{
      status: string;
      total_cents: number;
      paid_cents: number;
    }>('retail report purchasing', (offset, limit) =>
      supabase
        .from('retail_purchase_orders')
        .select('status, total_cents, paid_cents', { count: 'exact' })
        .eq('organization_id', ctx.organizationId)
        .eq('branch_id', ctx.branchId)
        .gte('created_at', from)
        .lt('created_at', to)
        .order('id', { ascending: true })
        .range(offset, offset + limit - 1),
    );

    const live = (orders ?? []).filter((o) => o.status !== 'cancelled');
    report.purchasing = {
      ordersRaised: (orders ?? []).length,
      committedCents: live.reduce((sum, o) => sum + Number(o.total_cents), 0),
      paidCents: live.reduce((sum, o) => sum + Number(o.paid_cents), 0),
      openOrders: live.filter((o) => o.status !== 'received').length,
    };
  }

  // ---- the storefront ----------------------------------------------------
  if (can(ctx, 'retail.order.read')) {
    const orders = await fetchAllRows<{ status: string }>(
      'retail report store orders',
      (offset, limit) =>
        supabase
          .from('retail_orders')
          .select('status', { count: 'exact' })
          .eq('organization_id', ctx.organizationId)
          .eq('branch_id', ctx.branchId)
          .gte('placed_at', from)
          .lt('placed_at', to)
          .order('id', { ascending: true })
          .range(offset, offset + limit - 1),
    );

    report.storeOrders = {
      placed: (orders ?? []).length,
      completed: (orders ?? []).filter((o) => o.status === 'completed').length,
      cancelled: (orders ?? []).filter((o) => o.status === 'cancelled').length,
    };
  }

  return report;
}
