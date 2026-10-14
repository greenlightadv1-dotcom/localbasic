import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { AppError, toAppError } from '@/lib/errors';
import type { TenantContext } from '@/modules/core/tenancy/context';
import { getBranding } from '@/modules/core/branding/service';
import type { ReceiptData } from '@/lib/print/receipt-html';
import { getReceiptHeader } from '@/modules/restaurant/receipt/service';

/**
 * Everything the printed receipt says, read from `invoices`, `invoice_items`
 * and `payments` — the database's own record of what was charged and taken, not
 * anything the browser sends. Scoped to this branch, so a receipt id from
 * another branch or organization is simply "not found".
 */
export async function getReceiptData(ctx: TenantContext, invoiceId: string): Promise<ReceiptData> {
  const supabase = createSupabaseServerClient();

  const { data: invoice, error } = await supabase
    .from('invoices')
    .select('id, number, currency, subtotal_cents, discount_cents, tax_cents, total_cents, paid_cents, created_at')
    .eq('organization_id', ctx.organizationId)
    .eq('branch_id', ctx.branchId)
    .eq('id', invoiceId)
    .maybeSingle();
  if (error) throw toAppError(error, 'getReceiptData');
  if (!invoice) throw new AppError('not_found');

  const [{ data: items }, { data: payments }, { data: order }, branding, header] = await Promise.all([
    supabase
      .from('invoice_items')
      .select('description, quantity, total_cents')
      .eq('invoice_id', invoice.id)
      .order('position'),
    supabase
      .from('payments')
      .select('method, amount_cents, kind, created_at')
      .eq('invoice_id', invoice.id)
      .eq('status', 'completed')
      .order('created_at'),
    supabase
      .from('restaurant_orders')
      .select('number, table_id')
      .eq('organization_id', ctx.organizationId)
      .eq('invoice_id', invoice.id)
      .maybeSingle(),
    getBranding(ctx),
    getReceiptHeader(ctx),
  ]);

  const tableName = order?.table_id
    ? (await supabase.from('restaurant_tables').select('name').eq('id', order.table_id).maybeSingle()).data?.name ?? null
    : null;

  const paymentRows = payments ?? [];
  // Dated when the money was taken, not when the order was opened.
  const issuedAt = paymentRows.length > 0 ? paymentRows[paymentRows.length - 1]!.created_at : invoice.created_at;

  return {
    businessName: branding.displayName,
    branchName: header?.branchName ?? ctx.branchName,
    phone: header?.phone ?? branding.phone,
    number: invoice.number,
    orderNumber: order?.number ?? null,
    tableName,
    issuedAt,
    currency: invoice.currency,
    items: (items ?? []).map((i) => ({
      description: i.description,
      quantity: Number(i.quantity),
      totalCents: i.total_cents,
    })),
    subtotalCents: invoice.subtotal_cents,
    discountCents: invoice.discount_cents,
    taxCents: invoice.tax_cents,
    totalCents: invoice.total_cents,
    payments: paymentRows.map((p) => ({
      method: p.method,
      amountCents: p.amount_cents,
      kind: p.kind === 'refund' ? 'refund' : 'payment',
    })),
    paidCents: invoice.paid_cents,
    whiteLabel: branding.whiteLabel,
    legalName: header?.legalName ?? null,
    commercialRegistration: header?.commercialRegistration ?? null,
    taxId: header?.taxId ?? null,
    address: header?.address ?? null,
    headerNote: header?.headerNote ?? null,
    footerNote: header?.footerNote ?? null,
  };
}
