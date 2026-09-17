import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { AppError, toAppError } from '@/lib/errors';
import { requirePermission, type TenantContext } from '@/modules/core/tenancy/context';

/**
 * Store orders, from the shop's side.
 *
 * Reads go through RLS as the signed-in member; every transition goes through
 * a database function that re-checks the permission and moves stock, money or
 * both. This layer never computes a total and never touches the ledger.
 */

export const ORDER_STATUSES = [
  'placed', 'confirmed', 'packed', 'fulfilled', 'completed', 'cancelled',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  placed: 'جديد',
  confirmed: 'مؤكَّد',
  packed: 'مُجهَّز',
  fulfilled: 'مُسلَّم',
  completed: 'مكتمل',
  cancelled: 'ملغي',
};

/** What a staff member may do next, mirroring the database's state machine. */
export const NEXT_STATUS: Partial<Record<OrderStatus, 'confirmed' | 'packed' | 'fulfilled'>> = {
  placed: 'confirmed',
  confirmed: 'packed',
  packed: 'fulfilled',
};

export type StoreOrderRow = {
  id: string;
  number: string;
  status: OrderStatus;
  fulfillment: 'pickup' | 'delivery';
  contactName: string;
  contactPhone: string;
  totalCents: number;
  paymentMethod: string;
  placedAt: string;
};

export type StoreOrder = StoreOrderRow & {
  currency: string;
  subtotalCents: number;
  taxCents: number;
  deliveryFeeCents: number;
  note: string | null;
  invoiceId: string | null;
  cancelReason: string | null;
  lines: {
    id: string;
    productName: string;
    variantName: string;
    quantity: number;
    unitPriceCents: number;
    lineTotalCents: number;
  }[];
  delivery: {
    recipientName: string;
    phone: string;
    city: string;
    area: string | null;
    addressLine: string;
    landmark: string | null;
  } | null;
};

function asStatus(value: string): OrderStatus {
  return (ORDER_STATUSES as readonly string[]).includes(value)
    ? (value as OrderStatus)
    : 'placed';
}

export async function listStoreOrders(
  ctx: TenantContext,
  options: { status?: OrderStatus } = {},
): Promise<StoreOrderRow[]> {
  requirePermission(ctx, 'retail.order.read');
  const supabase = createSupabaseServerClient();

  let query = supabase
    .from('retail_orders')
    .select('id, number, status, fulfillment_type, contact_name, contact_phone, total_cents, payment_method, placed_at')
    .eq('organization_id', ctx.organizationId)
    .eq('branch_id', ctx.branchId)
    .order('placed_at', { ascending: false })
    .limit(200);

  if (options.status) query = query.eq('status', options.status);

  const { data, error } = await query;
  if (error) throw toAppError(error, 'listStoreOrders');

  return (data ?? []).map((o) => ({
    id: o.id,
    number: o.number,
    status: asStatus(o.status),
    fulfillment: o.fulfillment_type === 'delivery' ? 'delivery' : 'pickup',
    contactName: o.contact_name,
    contactPhone: o.contact_phone,
    totalCents: Number(o.total_cents),
    paymentMethod: o.payment_method,
    placedAt: o.placed_at,
  }));
}

/** One order, or null — the same answer for another tenant's as for none. */
export async function getStoreOrder(
  ctx: TenantContext,
  id: string,
): Promise<StoreOrder | null> {
  requirePermission(ctx, 'retail.order.read');
  const supabase = createSupabaseServerClient();

  const { data, error } = await supabase
    .from('retail_orders')
    .select('id, number, status, fulfillment_type, contact_name, contact_phone, currency, subtotal_cents, tax_cents, delivery_fee_cents, total_cents, payment_method, note, invoice_id, cancel_reason, placed_at')
    .eq('id', id)
    .eq('organization_id', ctx.organizationId)
    .eq('branch_id', ctx.branchId)
    .maybeSingle();

  if (error) throw toAppError(error, 'getStoreOrder');
  if (!data) return null;

  const [{ data: items }, { data: delivery }] = await Promise.all([
    supabase
      .from('retail_order_items')
      .select('id, product_name, variant_name, quantity, unit_price_cents, line_total_cents, position')
      .eq('order_id', id)
      .order('position'),
    supabase
      .from('retail_order_deliveries')
      .select('recipient_name, phone, city, area, address_line, landmark')
      .eq('order_id', id)
      .maybeSingle(),
  ]);

  return {
    id: data.id,
    number: data.number,
    status: asStatus(data.status),
    fulfillment: data.fulfillment_type === 'delivery' ? 'delivery' : 'pickup',
    contactName: data.contact_name,
    contactPhone: data.contact_phone,
    currency: data.currency,
    subtotalCents: Number(data.subtotal_cents),
    taxCents: Number(data.tax_cents),
    deliveryFeeCents: Number(data.delivery_fee_cents),
    totalCents: Number(data.total_cents),
    paymentMethod: data.payment_method,
    note: data.note,
    invoiceId: data.invoice_id,
    cancelReason: data.cancel_reason,
    placedAt: data.placed_at,
    lines: (items ?? []).map((i) => ({
      id: i.id,
      productName: i.product_name,
      variantName: i.variant_name,
      quantity: Number(i.quantity),
      unitPriceCents: Number(i.unit_price_cents),
      lineTotalCents: Number(i.line_total_cents),
    })),
    delivery: delivery
      ? {
          recipientName: delivery.recipient_name,
          phone: delivery.phone,
          city: delivery.city,
          area: delivery.area,
          addressLine: delivery.address_line,
          landmark: delivery.landmark,
        }
      : null,
  };
}

export async function advanceStoreOrder(
  ctx: TenantContext,
  id: string,
  status: 'confirmed' | 'packed' | 'fulfilled',
): Promise<void> {
  requirePermission(ctx, 'retail.order.manage');
  const supabase = createSupabaseServerClient();

  const { error } = await supabase.rpc('retail_order_set_status', {
    p_org: ctx.organizationId,
    p_branch: ctx.branchId,
    p_order: id,
    p_status: status,
  });
  if (error) throw new AppError('validation', error.message);
}

export async function cancelStoreOrder(
  ctx: TenantContext,
  id: string,
  reason?: string,
): Promise<void> {
  requirePermission(ctx, 'retail.order.manage');
  const supabase = createSupabaseServerClient();

  const { error } = await supabase.rpc('retail_order_cancel', {
    p_org: ctx.organizationId,
    p_branch: ctx.branchId,
    p_order: id,
    p_reason: reason || null,
  });
  if (error) throw new AppError('validation', error.message);
}

/**
 * Close the order and take the money.
 *
 * This is the moment a receipt exists, so it needs the document and payment
 * privileges as well as the order one — the database checks all three again.
 */
export async function completeStoreOrder(
  ctx: TenantContext,
  id: string,
  method: 'cash' | 'card' | 'transfer' | 'wallet' | 'other' = 'cash',
): Promise<{ invoiceId: string; invoiceNumber: string; totalCents: number }> {
  requirePermission(ctx, 'retail.order.manage');
  requirePermission(ctx, 'invoice.create');
  requirePermission(ctx, 'payment.create');
  const supabase = createSupabaseServerClient();

  const { data, error } = await supabase.rpc('retail_order_complete', {
    p_org: ctx.organizationId,
    p_branch: ctx.branchId,
    p_order: id,
    p_method: method,
    p_account: null,
  });
  if (error) throw new AppError('validation', error.message);

  const row = (Array.isArray(data) ? data : [data])[0] as
    | { out_invoice_id: string; out_invoice_number: string; out_total_cents: number }
    | undefined;
  if (!row?.out_invoice_id) throw new AppError('validation', 'تعذّر إتمام الطلب');

  return {
    invoiceId: row.out_invoice_id,
    invoiceNumber: row.out_invoice_number,
    totalCents: Number(row.out_total_cents),
  };
}
