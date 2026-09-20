import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { AppError, notFound, toAppError } from '@/lib/errors';
import type { TenantContext } from '@/modules/core/tenancy/context';
import type { OrderStatus } from './schemas';

export type OrderLine = {
  id: string;
  productName: string;
  variantName: string;
  quantity: number;
  unitPriceCents: number;
  modifiersCents: number;
  lineTotalCents: number;
  note: string | null;
  modifiers: { name: string; priceCents: number }[];
};

export type OrderSummary = {
  id: string;
  number: string;
  status: OrderStatus;
  channel: string;
  type: string;
  tableName: string | null;
  tableId: string | null;
  guestName: string | null;
  totalCents: number;
  paidCents: number;
  itemCount: number;
  note: string | null;
  placedAt: string;
  invoiceId: string | null;
};

const ACTIVE: OrderStatus[] = ['new', 'confirmed', 'preparing', 'ready', 'served'];

/**
 * Orders for this branch. `statuses` narrows the list for each surface: the
 * kitchen wants confirmed and preparing, the floor wants ready, the till wants
 * everything still open.
 */
export async function listOrders(
  ctx: TenantContext,
  options: { statuses?: OrderStatus[]; limit?: number; since?: Date } = {},
): Promise<OrderSummary[]> {
  const supabase = createSupabaseServerClient();

  let query = supabase
    .from('restaurant_orders')
    .select(
      'id, number, status, channel, type, table_id, guest_name, total_cents, note, placed_at, invoice_id',
    )
    .eq('organization_id', ctx.organizationId)
    .eq('branch_id', ctx.branchId)
    // NEWEST first in the query, oldest first in the result — see below.
    .order('placed_at', { ascending: false })
    .limit(Math.min(options.limit ?? 100, 300));

  if (options.statuses?.length) query = query.in('status', options.statuses);
  if (options.since) query = query.gte('placed_at', options.since.toISOString());

  const { data: rows, error } = await query;
  if (error) throw toAppError(error, 'listOrders');
  if (!rows?.length) return [];

  /**
   * The screens want a queue: oldest first, because that is the order a
   * kitchen cooks in and a cashier calls out.
   *
   * But asking the DATABASE for oldest-first and then capping the result means
   * the cap discards the NEWEST rows — so a branch busy enough to exceed the
   * limit stops seeing the orders it just took, which is exactly backwards.
   * That is not hypothetical: it is what made the smoke tests fail once the
   * development database had accumulated a hundred open orders.
   *
   * So the query takes the most recent window and the presentation order is
   * restored here. Overflow now drops the stalest rows, which is the only
   * direction a cap can safely drop in.
   */
  const orders = [...rows].reverse();

  const orderIds = orders.map((o) => o.id);
  const tableIds = [...new Set(orders.map((o) => o.table_id).filter(Boolean))] as string[];
  const invoiceIds = [...new Set(orders.map((o) => o.invoice_id).filter(Boolean))] as string[];

  const [{ data: items }, { data: tables }, { data: invoices }] = await Promise.all([
    supabase.from('restaurant_order_items').select('order_id, quantity').in('order_id', orderIds),
    tableIds.length
      ? supabase.from('restaurant_tables').select('id, name').in('id', tableIds)
      : Promise.resolve({ data: [] as { id: string; name: string }[] }),
    invoiceIds.length
      ? supabase.from('invoices').select('id, paid_cents').in('id', invoiceIds)
      : Promise.resolve({ data: [] as { id: string; paid_cents: number }[] }),
  ]);

  const tableName = new Map((tables ?? []).map((t) => [t.id, t.name]));
  const paid = new Map((invoices ?? []).map((i) => [i.id, i.paid_cents]));

  return orders.map((o) => ({
    id: o.id,
    number: o.number,
    status: o.status as OrderStatus,
    channel: o.channel,
    type: o.type,
    tableId: o.table_id,
    tableName: o.table_id ? (tableName.get(o.table_id) ?? null) : null,
    guestName: o.guest_name,
    totalCents: o.total_cents,
    paidCents: o.invoice_id ? (paid.get(o.invoice_id) ?? 0) : 0,
    itemCount: (items ?? []).filter((i) => i.order_id === o.id).length,
    note: o.note,
    placedAt: o.placed_at,
    invoiceId: o.invoice_id,
  }));
}

export const listActiveOrders = (ctx: TenantContext) => listOrders(ctx, { statuses: ACTIVE });

/**
 * A kitchen ticket: what to cook, for which table, and how long it has been
 * waiting. Deliberately carries no money.
 *
 * The kitchen page used to build this by calling listOrders() and then
 * getOrder() once per order. getOrder() issues up to five queries — the order,
 * its items, their modifiers, the table and the INVOICE — so a board showing
 * thirty tickets cost about 150 round trips, repeated every twenty seconds by
 * every tablet in the kitchen.
 *
 * It also meant every ticket arrived at the browser carrying unit prices, line
 * totals, the order total and the invoice id. The board renders none of it, but
 * a React Server Component payload is readable in the browser, so it was there
 * for anyone on the kitchen tablet to open DevTools and read. That contradicts
 * what the board itself documents: no financial information of any kind.
 *
 * This is four queries regardless of how many tickets are on the board, and no
 * price column is selected at all — the money never leaves the database rather
 * than being dropped on the way out.
 */
export type KitchenTicket = {
  summary: {
    id: string;
    number: string;
    status: OrderStatus;
    tableName: string | null;
    note: string | null;
    placedAt: string;
  };
  lines: {
    id: string;
    productName: string;
    variantName: string;
    quantity: number;
    note: string | null;
    modifiers: { name: string }[];
  }[];
};

export async function listKitchenTickets(
  ctx: TenantContext,
  statuses: OrderStatus[] = ['confirmed', 'preparing', 'ready'],
): Promise<KitchenTicket[]> {
  const supabase = createSupabaseServerClient();

  const { data: rows, error } = await supabase
    .from('restaurant_orders')
    .select('id, number, status, table_id, note, placed_at')
    .eq('organization_id', ctx.organizationId)
    .eq('branch_id', ctx.branchId)
    .in('status', statuses)
    .order('placed_at', { ascending: false })
    .limit(300);

  if (error) throw toAppError(error, 'listKitchenTickets');
  if (!rows?.length) return [];

  // Oldest first on the board — the order a kitchen cooks in. The query takes
  // the newest window so the cap drops the stalest rows, as listOrders explains.
  const orders = [...rows].reverse();
  const orderIds = orders.map((o) => o.id);
  const tableIds = [...new Set(orders.map((o) => o.table_id).filter(Boolean))] as string[];

  const [{ data: items }, { data: tables }] = await Promise.all([
    supabase
      .from('restaurant_order_items')
      .select('id, order_id, product_name, variant_name, quantity, note')
      .in('order_id', orderIds)
      .order('position'),
    tableIds.length
      ? supabase.from('restaurant_tables').select('id, name').in('id', tableIds)
      : Promise.resolve({ data: [] as { id: string; name: string }[] }),
  ]);

  const itemIds = (items ?? []).map((i) => i.id);
  const { data: modifiers } = itemIds.length
    ? await supabase
        .from('restaurant_order_item_modifiers')
        .select('order_item_id, name')
        .in('order_item_id', itemIds)
    : { data: [] as { order_item_id: string; name: string }[] };

  const tableName = new Map((tables ?? []).map((t) => [t.id, t.name]));
  const modsByItem = new Map<string, { name: string }[]>();
  for (const m of modifiers ?? []) {
    const list = modsByItem.get(m.order_item_id) ?? [];
    list.push({ name: m.name });
    modsByItem.set(m.order_item_id, list);
  }

  const linesByOrder = new Map<string, KitchenTicket['lines']>();
  for (const i of items ?? []) {
    const list = linesByOrder.get(i.order_id) ?? [];
    list.push({
      id: i.id,
      productName: i.product_name,
      variantName: i.variant_name,
      quantity: i.quantity,
      note: i.note,
      modifiers: modsByItem.get(i.id) ?? [],
    });
    linesByOrder.set(i.order_id, list);
  }

  return orders.map((o) => ({
    summary: {
      id: o.id,
      number: o.number,
      status: o.status as OrderStatus,
      tableName: o.table_id ? (tableName.get(o.table_id) ?? null) : null,
      note: o.note,
      placedAt: o.placed_at,
    },
    lines: linesByOrder.get(o.id) ?? [],
  }));
}

/** One order with its lines and modifiers — the kitchen ticket and the bill. */
export async function getOrder(ctx: TenantContext, orderId: string) {
  const supabase = createSupabaseServerClient();

  const { data: order, error } = await supabase
    .from('restaurant_orders')
    .select(
      'id, number, status, channel, type, table_id, customer_id, guest_name, guest_phone, note, currency, subtotal_cents, discount_cents, tax_cents, total_cents, invoice_id, placed_at, confirmed_at, ready_at, served_at, completed_at, cancelled_at, cancel_reason',
    )
    .eq('organization_id', ctx.organizationId)
    .eq('id', orderId)
    .maybeSingle();

  if (error) throw toAppError(error, 'getOrder');
  if (!order) throw notFound();

  const { data: items } = await supabase
    .from('restaurant_order_items')
    .select(
      'id, product_name, variant_name, quantity, unit_price_cents, modifiers_cents, line_total_cents, note',
    )
    .eq('order_id', orderId)
    .order('position');

  const itemIds = (items ?? []).map((i) => i.id);
  const { data: modifiers } = itemIds.length
    ? await supabase
        .from('restaurant_order_item_modifiers')
        .select('order_item_id, name, price_cents')
        .in('order_item_id', itemIds)
    : { data: [] as { order_item_id: string; name: string; price_cents: number }[] };

  const [{ data: table }, { data: invoice }] = await Promise.all([
    order.table_id
      ? supabase.from('restaurant_tables').select('name').eq('id', order.table_id).maybeSingle()
      : Promise.resolve({ data: null }),
    order.invoice_id
      ? supabase
          .from('invoices')
          .select('id, number, paid_cents, total_cents, status')
          .eq('id', order.invoice_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const lines: OrderLine[] = (items ?? []).map((i) => ({
    id: i.id,
    productName: i.product_name,
    variantName: i.variant_name,
    quantity: Number(i.quantity),
    unitPriceCents: i.unit_price_cents,
    modifiersCents: i.modifiers_cents,
    lineTotalCents: i.line_total_cents,
    note: i.note,
    modifiers: (modifiers ?? [])
      .filter((m) => m.order_item_id === i.id)
      .map((m) => ({ name: m.name, priceCents: m.price_cents })),
  }));

  return { order, lines, tableName: table?.name ?? null, invoice };
}

/**
 * Creates a staff order. Prices come from the database inside
 * restaurant_create_order; the input only names items and quantities.
 */
export async function createOrder(
  ctx: TenantContext,
  input: {
    items: { variantId: string; quantity: number; modifierIds: string[]; note?: string }[];
    tableId?: string | null;
    type: 'dine_in' | 'takeaway';
    customerId?: string | null;
    note?: string;
  },
  channel: 'cashier' | 'waiter',
) {
  const supabase = createSupabaseServerClient();

  const { data, error } = await supabase
    .rpc('restaurant_create_order', {
      p_org: ctx.organizationId,
      p_branch: ctx.branchId,
      p_items: input.items.map((i) => ({
        variant_id: i.variantId,
        quantity: i.quantity,
        modifier_ids: i.modifierIds,
        note: i.note ?? null,
      })),
      p_table_id: input.tableId ?? null,
      p_type: input.type,
      p_channel: channel,
      p_customer_id: input.customerId ?? null,
      p_note: input.note ?? null,
    })
    .single();

  if (error?.code === '42501') throw new AppError('forbidden');
  if (error) throw mapOrderError(error, 'createOrder');

  const row = data as unknown as {
    out_order_id: string;
    out_number: string;
    out_total_cents: number;
  } | null;
  if (!row) throw new AppError('internal');
  return { id: row.out_order_id, number: row.out_number, totalCents: row.out_total_cents };
}

export async function setOrderStatus(
  ctx: TenantContext,
  orderId: string,
  status: OrderStatus,
  reason?: string,
) {
  const supabase = createSupabaseServerClient();
  const { error } = await supabase.rpc('restaurant_set_order_status', {
    p_org: ctx.organizationId,
    p_order: orderId,
    p_status: status,
    p_reason: reason ?? null,
  });

  if (error?.code === '42501') throw new AppError('forbidden');
  if (error) throw mapOrderError(error, 'setOrderStatus');
}

export type PaymentResult = {
  invoiceId: string;
  receiptNumber: string;
  totalCents: number;
  paidCents: number;
  dueCents: number;
  changeCents: number;
};

/**
 * Takes payment. The database recomputes the total from the order's own lines,
 * so a tampered order row or a client-sent figure changes nothing about what
 * is charged.
 */
export async function payOrder(
  ctx: TenantContext,
  input: { orderId: string; method: string; tenderedCents: number; discountCents: number },
): Promise<PaymentResult> {
  const supabase = createSupabaseServerClient();

  const { data, error } = await supabase
    .rpc('restaurant_pay_order', {
      p_org: ctx.organizationId,
      p_order: input.orderId,
      p_method: input.method,
      p_tendered_cents: input.tenderedCents,
      p_discount_cents: input.discountCents,
    })
    .single();

  if (error?.code === '42501') throw new AppError('forbidden');
  if (error) throw mapOrderError(error, 'payOrder');

  const row = data as unknown as {
    out_invoice_id: string;
    out_receipt_number: string;
    out_total_cents: number;
    out_paid_cents: number;
    out_due_cents: number;
    out_change_cents: number;
  } | null;
  if (!row) throw new AppError('internal');

  return {
    invoiceId: row.out_invoice_id,
    receiptNumber: row.out_receipt_number,
    totalCents: row.out_total_cents,
    paidCents: row.out_paid_cents,
    dueCents: row.out_due_cents,
    changeCents: row.out_change_cents,
  };
}

/**
 * The database raises business rules as check violations with a message meant
 * for a person. Those are safe to show; anything else is logged and replaced.
 */
function mapOrderError(error: { code?: string; message: string }, context: string): AppError {
  if (error.code === '23514' || error.code === 'P0001') {
    return new AppError('conflict', translateDbMessage(error.message));
  }
  return toAppError(error, context);
}

const DB_MESSAGES: Record<string, string> = {
  'an order needs at least one item': 'الطلب يحتاج صنفًا واحدًا على الأقل.',
  'unknown or unavailable menu item': 'صنف غير موجود أو غير متاح.',
  'item is not available at this branch': 'الصنف غير متاح في هذا الفرع حاليًا.',
  'invalid quantity': 'الكمية غير صحيحة.',
  'a cancellation needs a reason': 'اذكر سبب الإلغاء.',
  'a paid order cannot be cancelled — issue a refund':
    'لا يمكن إلغاء طلب مدفوع — استخدم المرتجع.',
  'the order must be paid before it is completed': 'يجب تحصيل الطلب قبل إغلاقه.',
  'this order is already paid in full': 'تم تحصيل هذا الطلب بالكامل بالفعل.',
  'a cancelled order cannot be paid': 'لا يمكن تحصيل طلب ملغي.',
  'discount exceeds the order total': 'الخصم أكبر من قيمة الطلب.',
  'too many open orders for this table': 'يوجد طلبات مفتوحة كثيرة على هذه الطاولة.',
  'this QR code is no longer active': 'رمز QR لم يعد صالحًا.',
  'ordering from the QR code is disabled': 'الطلب عبر QR غير مفعّل حاليًا.',
};

function translateDbMessage(message: string): string {
  for (const [needle, arabic] of Object.entries(DB_MESSAGES)) {
    if (message.includes(needle)) return arabic;
  }
  if (message.includes('invalid order transition')) {
    return 'لا يمكن الانتقال إلى هذه الحالة من الحالة الحالية.';
  }
  if (message.includes('invalid selection for group')) {
    return 'اختياراتك للإضافات غير مكتملة أو غير صحيحة.';
  }
  return 'تعذّر تنفيذ العملية. تحقق من البيانات.';
}
