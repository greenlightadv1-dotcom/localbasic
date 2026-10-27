import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { staffDbError } from '@/lib/errors';
import type { TenantContext } from '@/modules/core/tenancy/context';
import type {
  CheckoutInput,
  PromotionsPreviewInput,
  ReturnInput,
  StoreCreditAdjustInput,
  TransferCancelInput,
  TransferDecideInput,
  TransferDispatchInput,
  TransferReceiveInput,
  TransferRequestInput,
} from './schemas';

/**
 * Retail operations (0111/0112): the till's barcode lookup and checkout,
 * returns, store credit, the branch transfer workflow and auto-reorder.
 *
 * Every function here is a thin call into one SECURITY DEFINER function that
 * re-checks permission, tenancy and every amount. The organization and branch
 * always come from the URL-resolved context, never from the input.
 */

type Row = Record<string, unknown>;

async function call(fn: string, args: Record<string, unknown>, context: string): Promise<unknown> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc(fn as never, args as never);
  if (error) throw staffDbError(error, context);
  return data;
}

const rows = (data: unknown): Row[] => (Array.isArray(data) ? (data as Row[]) : data ? [data as Row] : []);
const num = (v: unknown) => Number(v ?? 0);

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------
export type BarcodeHit = {
  variantId: string;
  productId: string;
  productName: string;
  variantName: string;
  /** 1 for a plain barcode, the pack size for a carton, the weight for a scale label. */
  quantity: number;
  unitPriceCents: number;
  linePriceCents: number;
  matchedBy: 'barcode' | 'sku' | 'alternate' | 'scale';
};

export async function lookupBarcode(ctx: TenantContext, code: string): Promise<BarcodeHit | null> {
  const [r] = rows(await call('retail_barcode_lookup', { p_org: ctx.organizationId, p_code: code }, 'lookupBarcode'));
  if (!r) return null;
  return {
    variantId: String(r.variant_id), productId: String(r.product_id),
    productName: String(r.product_name), variantName: String(r.variant_name),
    quantity: num(r.quantity), unitPriceCents: num(r.unit_price_cents), linePriceCents: num(r.line_price_cents),
    matchedBy: r.matched_by as BarcodeHit['matchedBy'],
  };
}

// ---------------------------------------------------------------------------
// Promotions and checkout
// ---------------------------------------------------------------------------
export type PromotionLine = {
  promotionId: string; name: string; kind: string; code: string | null;
  discountCents: number; pointsMultiplier: number; applied: boolean;
};

const items = (list: { variantId: string; quantity: number; discountCents?: number }[]) =>
  list.map((i) => ({ variant_id: i.variantId, quantity: i.quantity, discount_cents: i.discountCents ?? 0 }));

export async function previewPromotions(ctx: TenantContext, input: PromotionsPreviewInput): Promise<PromotionLine[]> {
  const data = await call('retail_promotions_preview', {
    p_org: ctx.organizationId, p_branch: ctx.branchId, p_items: items(input.items),
    p_customer: input.customerId ?? null, p_code: input.code || null,
  }, 'previewPromotions');
  return rows(data).map((r) => ({
    promotionId: String(r.promotion_id), name: String(r.name), kind: String(r.kind),
    code: (r.code as string) ?? null, discountCents: num(r.discount_cents),
    pointsMultiplier: num(r.points_multiplier), applied: Boolean(r.applied),
  }));
}

export type CheckoutResult = {
  invoiceId: string; invoiceNumber: string; totalCents: number; promoCents: number;
  storeCreditCents: number; paidCents: number; changeCents: number; pointsEarned: number;
};

export async function checkout(ctx: TenantContext, input: CheckoutInput): Promise<CheckoutResult> {
  const [r] = rows(await call('retail_checkout', {
    p_org: ctx.organizationId, p_branch: ctx.branchId, p_items: items(input.items),
    p_method: input.method, p_tendered_cents: input.tenderedCents, p_customer_id: input.customerId ?? null,
    p_promo_code: input.promoCode || null, p_store_credit_cents: input.storeCreditCents,
    p_order_discount_cents: input.orderDiscountCents, p_note: input.note || null,
  }, 'checkout'));
  return {
    invoiceId: String(r!.out_invoice_id), invoiceNumber: String(r!.out_invoice_number),
    totalCents: num(r!.out_total_cents), promoCents: num(r!.out_promo_cents),
    storeCreditCents: num(r!.out_store_credit_cents), paidCents: num(r!.out_paid_cents),
    changeCents: num(r!.out_change_cents), pointsEarned: num(r!.out_points_earned),
  };
}

// ---------------------------------------------------------------------------
// Returns and store credit
// ---------------------------------------------------------------------------
export type ReturnResult = {
  returnId: string; number: string; valueCents: number; refundCents: number;
  storeCreditCents: number; exchangeInvoiceId: string | null;
};

/** A cash refund raises LB403 ('retail.cashback') until a manager's PIN grant exists. */
export async function processReturn(ctx: TenantContext, input: ReturnInput): Promise<ReturnResult> {
  const [r] = rows(await call('retail_process_return', {
    p_org: ctx.organizationId, p_branch: ctx.branchId, p_invoice: input.invoiceId,
    p_items: input.items.map((i) => ({ variant_id: i.variantId, quantity: i.quantity, condition: i.condition, note: i.note ?? null })),
    p_resolution: input.resolution, p_customer_id: input.customerId ?? null, p_reason: input.reason || null,
    p_exchange_items: input.exchangeItems ? items(input.exchangeItems) : null,
    p_exchange_method: input.exchangeMethod, p_exchange_tendered_cents: input.exchangeTenderedCents,
  }, 'processReturn'));
  return {
    returnId: String(r!.out_return_id), number: String(r!.out_number), valueCents: num(r!.out_value_cents),
    refundCents: num(r!.out_refund_cents), storeCreditCents: num(r!.out_store_credit_cents),
    exchangeInvoiceId: (r!.out_exchange_invoice_id as string) ?? null,
  };
}

export async function getStoreCreditBalance(ctx: TenantContext, customerId: string): Promise<number> {
  return num(await call('retail_store_credit_balance', { p_org: ctx.organizationId, p_customer: customerId }, 'getStoreCreditBalance'));
}

/** Needs retail.credit.manage and a second person's PIN ('retail.credit_adjust'). Returns the new balance. */
export async function adjustStoreCredit(ctx: TenantContext, input: StoreCreditAdjustInput): Promise<number> {
  return num(await call('retail_store_credit_adjust', {
    p_org: ctx.organizationId, p_branch: ctx.branchId, p_customer: input.customerId,
    p_delta_cents: input.deltaCents, p_note: input.note,
  }, 'adjustStoreCredit'));
}

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------
export async function requestTransfer(ctx: TenantContext, input: TransferRequestInput): Promise<{ transferId: string; number: string }> {
  const [r] = rows(await call('retail_transfer_request', {
    p_org: ctx.organizationId, p_from_branch: input.fromBranchId, p_to_branch: ctx.branchId,
    p_items: input.items.map((i) => ({ variant_id: i.variantId, quantity: i.quantity })), p_reason: input.reason || null,
  }, 'requestTransfer'));
  return { transferId: String(r!.out_transfer_id), number: String(r!.out_number) };
}

export async function decideTransfer(ctx: TenantContext, input: TransferDecideInput): Promise<void> {
  await call('retail_transfer_decide', {
    p_org: ctx.organizationId, p_transfer: input.transferId, p_approve: input.approve, p_note: input.note || null,
  }, 'decideTransfer');
}

export async function dispatchTransfer(ctx: TenantContext, input: TransferDispatchInput): Promise<void> {
  await call('retail_transfer_dispatch', {
    p_org: ctx.organizationId, p_transfer: input.transferId,
    p_items: input.items?.map((i) => ({ variant_id: i.variantId, quantity: i.quantity })) ?? null,
  }, 'dispatchTransfer');
}

export async function receiveTransfer(
  ctx: TenantContext, input: TransferReceiveInput,
): Promise<{ shortageLines: number; shortageQty: number }> {
  const [r] = rows(await call('retail_transfer_receive', {
    p_org: ctx.organizationId, p_transfer: input.transferId,
    p_items: input.items?.map((i) => ({ variant_id: i.variantId, quantity_received: i.quantityReceived })) ?? null,
    p_note: input.note || null,
  }, 'receiveTransfer'));
  return { shortageLines: num(r?.out_shortage_lines), shortageQty: num(r?.out_shortage_qty) };
}

export async function cancelTransfer(ctx: TenantContext, input: TransferCancelInput): Promise<void> {
  await call('retail_transfer_cancel', { p_org: ctx.organizationId, p_transfer: input.transferId, p_reason: input.reason }, 'cancelTransfer');
}

// ---------------------------------------------------------------------------
// Auto-reorder
// ---------------------------------------------------------------------------
export type ReorderSuggestion = {
  variantId: string; productName: string; variantName: string; supplierId: string | null;
  onHand: number; reorderPoint: number; suggestedQty: number; unitCostCents: number;
};

export async function getReorderSuggestions(ctx: TenantContext): Promise<ReorderSuggestion[]> {
  const data = await call('retail_reorder_suggestions', { p_org: ctx.organizationId, p_branch: ctx.branchId }, 'getReorderSuggestions');
  return rows(data).map((r) => ({
    variantId: String(r.variant_id), productName: String(r.product_name), variantName: String(r.variant_name),
    supplierId: (r.supplier_id as string) ?? null, onHand: num(r.on_hand), reorderPoint: num(r.reorder_point),
    suggestedQty: num(r.suggested_qty), unitCostCents: num(r.unit_cost_cents),
  }));
}

export async function generateReorderDrafts(
  ctx: TenantContext,
): Promise<{ orderId: string; number: string; supplierId: string | null; lines: number }[]> {
  const data = await call('retail_reorder_generate', { p_org: ctx.organizationId, p_branch: ctx.branchId }, 'generateReorderDrafts');
  return rows(data).map((r) => ({
    orderId: String(r.out_order_id), number: String(r.out_number),
    supplierId: (r.out_supplier_id as string) ?? null, lines: num(r.out_lines),
  }));
}

// ---------------------------------------------------------------------------
// Till reads: catalog, customer, receipt
// ---------------------------------------------------------------------------
export type RetailPosItem = {
  variantId: string;
  productId: string;
  productName: string;
  variantName: string;
  categoryId: string | null;
  sku: string | null;
  barcode: string | null;
  priceCents: number;
  taxRateBp: number;
  /** piece | kg | gram | litre | metre | box | pack — fractional quantities for the weighed ones. */
  unit: string;
  stock: number;
  reorderPoint: number;
  costCents: number;
};

export type RetailPosCatalog = { items: RetailPosItem[]; categories: { id: string; name: string }[] };

/**
 * Everything sellable at this branch with live stock, loaded once: at the
 * till a round trip per keystroke is the difference between fast and
 * unusable. Prices here are for display only; retail_checkout re-reads them.
 */
export async function listRetailPosCatalog(ctx: TenantContext): Promise<RetailPosCatalog> {
  const supabase = createSupabaseServerClient();
  const [{ data: variants, error }, { data: categories, error: catError }] = await Promise.all([
    supabase
      .from('retail_variants')
      .select('id, name, sku, barcode, price_cents, cost_cents, reorder_point, product_id, retail_products!inner(name, unit, tax_rate_bp, is_active, category_id, deleted_at)')
      .eq('organization_id', ctx.organizationId)
      .eq('is_active', true)
      .is('deleted_at', null)
      .limit(3000),
    supabase
      .from('retail_categories')
      .select('id, name, sort_order')
      .eq('organization_id', ctx.organizationId)
      .eq('is_active', true)
      .order('sort_order')
      .limit(200),
  ]);
  if (error) throw staffDbError(error, 'listRetailPosCatalog');
  if (catError) throw staffDbError(catError, 'listRetailPosCatalog.categories');

  const ids = (variants ?? []).map((v) => v.id);
  const stock = new Map<string, number>();
  for (let i = 0; i < ids.length; i += 500) {
    const { data: levels, error: levelError } = await supabase
      .from('retail_stock_levels')
      .select('variant_id, quantity')
      .eq('branch_id', ctx.branchId)
      .in('variant_id', ids.slice(i, i + 500));
    if (levelError) throw staffDbError(levelError, 'listRetailPosCatalog.stock');
    for (const l of levels ?? []) stock.set(l.variant_id, Number(l.quantity));
  }

  const items: RetailPosItem[] = [];
  for (const v of variants ?? []) {
    const p = v.retail_products as unknown as {
      name: string; unit: string; tax_rate_bp: number; is_active: boolean; category_id: string | null; deleted_at: string | null;
    } | null;
    if (!p?.is_active || p.deleted_at) continue;
    items.push({
      variantId: v.id, productId: v.product_id, productName: p.name, variantName: v.name,
      categoryId: p.category_id, sku: v.sku, barcode: v.barcode, priceCents: v.price_cents,
      taxRateBp: p.tax_rate_bp, unit: p.unit, stock: stock.get(v.id) ?? 0,
      reorderPoint: Number(v.reorder_point), costCents: v.cost_cents,
    });
  }
  items.sort((a, b) => a.productName.localeCompare(b.productName, 'ar'));
  return { items, categories: (categories ?? []).map((c) => ({ id: c.id, name: c.name })) };
}

export type PosCustomer = {
  customerId: string; name: string; phone: string | null;
  storeCreditCents: number; loyaltyPoints: number; loyaltyEnabled: boolean;
};

export async function lookupCustomer(ctx: TenantContext, phone: string): Promise<PosCustomer[]> {
  const data = await call('retail_customer_lookup', { p_org: ctx.organizationId, p_phone: phone }, 'lookupCustomer');
  return rows(data).map((r) => ({
    customerId: String(r.customer_id), name: String(r.name), phone: (r.phone as string) ?? null,
    storeCreditCents: num(r.store_credit_cents), loyaltyPoints: num(r.loyalty_points), loyaltyEnabled: Boolean(r.loyalty_enabled),
  }));
}

export type ReceiptLine = {
  variantId: string; description: string; quantity: number; returned: number; unitRefundCents: number;
};

export type Receipt = {
  invoiceId: string; number: string; issuedAt: string | null; totalCents: number; paidCents: number; status: string;
  customer: { id: string; name: string; phone: string | null } | null;
  lines: ReceiptLine[];
};

export async function lookupReceipt(ctx: TenantContext, number: string): Promise<Receipt | null> {
  const data = (await call('retail_receipt_lookup', {
    p_org: ctx.organizationId, p_branch: ctx.branchId, p_number: number,
  }, 'lookupReceipt')) as Row | null;
  if (!data) return null;
  const customer = data.customer as Row | null;
  return {
    invoiceId: String(data.invoice_id), number: String(data.number), issuedAt: (data.issued_at as string) ?? null,
    totalCents: num(data.total_cents), paidCents: num(data.paid_cents), status: String(data.status),
    customer: customer ? { id: String(customer.id), name: String(customer.name), phone: (customer.phone as string) ?? null } : null,
    lines: ((data.lines as Row[]) ?? []).map((l) => ({
      variantId: String(l.variant_id), description: String(l.description), quantity: num(l.quantity),
      returned: num(l.returned), unitRefundCents: num(l.unit_refund_cents),
    })),
  };
}

// ---------------------------------------------------------------------------
// Inventory workspace reads: transfers, branches, suppliers
// ---------------------------------------------------------------------------
export const TRANSFER_STATUSES = ['requested', 'approved', 'in_transit', 'received', 'cancelled', 'rejected'] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

export type TransferLineView = { variantId: string; name: string; quantity: number; quantityReceived: number | null };

export type TransferView = {
  id: string;
  number: string | null;
  status: TransferStatus;
  direction: 'incoming' | 'outgoing';
  fromBranchId: string;
  toBranchId: string;
  fromBranchName: string;
  toBranchName: string;
  reason: string | null;
  note: string | null;
  cancelReason: string | null;
  autoGenerated: boolean;
  createdAt: string;
  approvedAt: string | null;
  dispatchedAt: string | null;
  dispatchedBy: string | null;
  receivedAt: string | null;
  cancelledAt: string | null;
  lines: TransferLineView[];
};

export type BranchOption = { id: string; name: string };

/** Every live branch of the organization, for "request from" pickers and names on cards. */
export async function listOrgBranches(ctx: TenantContext): Promise<BranchOption[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from('branches')
    .select('id, name')
    .eq('organization_id', ctx.organizationId)
    .eq('is_active', true)
    .is('deleted_at', null)
    .order('name');
  if (error) throw staffDbError(error, 'listOrgBranches');
  const seen = new Map((data ?? []).map((b) => [b.id, b.name]));
  for (const b of ctx.branches) if (!seen.has(b.id)) seen.set(b.id, b.name);
  return [...seen].map(([id, name]) => ({ id, name }));
}

export async function listSupplierNames(ctx: TenantContext): Promise<Record<string, string>> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from('retail_suppliers')
    .select('id, name')
    .eq('organization_id', ctx.organizationId)
    .limit(1000);
  if (error) throw staffDbError(error, 'listSupplierNames');
  return Object.fromEntries((data ?? []).map((s) => [s.id, s.name]));
}

/**
 * Transfers this branch sent or asked for, newest first. RLS already limits
 * rows to branches where the caller holds retail.inventory.read.
 */
export async function listBranchTransfers(ctx: TenantContext, branches: BranchOption[], limit = 150): Promise<TransferView[]> {
  const supabase = createSupabaseServerClient();
  const { data: transfers, error } = await supabase
    .from('retail_stock_transfers')
    .select('id, number, status, from_branch_id, to_branch_id, reason, note, cancel_reason, auto_generated, created_at, approved_at, dispatched_at, dispatched_by, received_at, cancelled_at')
    .eq('organization_id', ctx.organizationId)
    .or(`from_branch_id.eq.${ctx.branchId},to_branch_id.eq.${ctx.branchId}`)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw staffDbError(error, 'listBranchTransfers');
  if (!transfers?.length) return [];

  const ids = transfers.map((t) => t.id);
  const { data: lines, error: lineError } = await supabase
    .from('retail_stock_transfer_lines')
    .select('transfer_id, variant_id, quantity, quantity_received')
    .in('transfer_id', ids);
  if (lineError) throw staffDbError(lineError, 'listBranchTransfers.lines');

  const variantIds = [...new Set((lines ?? []).map((l) => l.variant_id))];
  const names = new Map<string, string>();
  for (let i = 0; i < variantIds.length; i += 500) {
    const { data: variants, error: vError } = await supabase
      .from('retail_variants')
      .select('id, name, retail_products!inner(name)')
      .in('id', variantIds.slice(i, i + 500));
    if (vError) throw staffDbError(vError, 'listBranchTransfers.variants');
    for (const v of variants ?? []) {
      const product = (v.retail_products as unknown as { name: string } | null)?.name ?? 'صنف';
      names.set(v.id, v.name === 'default' ? product : `${product} — ${v.name}`);
    }
  }

  const branchName = new Map(branches.map((b) => [b.id, b.name]));
  const byTransfer = new Map<string, TransferLineView[]>();
  for (const l of lines ?? []) {
    const list = byTransfer.get(l.transfer_id) ?? [];
    list.push({
      variantId: l.variant_id, name: names.get(l.variant_id) ?? 'صنف محذوف',
      quantity: Number(l.quantity), quantityReceived: l.quantity_received === null ? null : Number(l.quantity_received),
    });
    byTransfer.set(l.transfer_id, list);
  }

  return transfers.map((t) => ({
    id: t.id, number: t.number, status: t.status as TransferStatus,
    direction: t.to_branch_id === ctx.branchId ? 'incoming' : 'outgoing',
    fromBranchId: t.from_branch_id, toBranchId: t.to_branch_id,
    fromBranchName: branchName.get(t.from_branch_id) ?? 'فرع آخر',
    toBranchName: branchName.get(t.to_branch_id) ?? 'فرع آخر',
    reason: t.reason, note: t.note, cancelReason: t.cancel_reason, autoGenerated: t.auto_generated,
    createdAt: t.created_at, approvedAt: t.approved_at, dispatchedAt: t.dispatched_at, dispatchedBy: t.dispatched_by,
    receivedAt: t.received_at, cancelledAt: t.cancelled_at,
    lines: (byTransfer.get(t.id) ?? []).sort((a, b) => a.name.localeCompare(b.name, 'ar')),
  }));
}
