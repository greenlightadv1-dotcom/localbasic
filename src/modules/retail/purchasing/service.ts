import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { AppError, toAppError } from '@/lib/errors';
import { requirePermission, type TenantContext } from '@/modules/core/tenancy/context';
import type {
  CreatePurchaseInput, PayInput, ReceiveInput, SupplierInput,
} from './schemas';

/**
 * Retail purchasing.
 *
 * Every mutation is a single database function so that the document, the stock
 * ledger, the treasury and the audit row either all happen or none do. This
 * layer resolves the tenant from context — never from a form — checks the
 * permission and hands over.
 *
 * Input arrives ALREADY PARSED, as everywhere else in this codebase: the
 * action wrapper in `src/lib/action.ts` is the single place a payload meets its
 * schema. Parsing twice is not harmless — the money transform turns "30.00"
 * into 3000 minor units, and running it again would read that 3000 as a fresh
 * amount and store 300000.
 *
 * The client names variants, quantities and the supplier's cost. It never
 * names a total: those are derived by trigger in the database, so what is
 * displayed here is read back rather than computed.
 */

export const PURCHASE_STATUSES = [
  'draft', 'ordered', 'partially_received', 'received', 'cancelled',
] as const;
export type PurchaseStatus = (typeof PURCHASE_STATUSES)[number];

export const PURCHASE_STATUS_LABELS: Record<PurchaseStatus, string> = {
  draft: 'مسودة',
  ordered: 'مطلوبة',
  partially_received: 'مستلمة جزئيًا',
  received: 'مستلمة',
  cancelled: 'ملغاة',
};

export type Supplier = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  taxId: string | null;
  notes: string | null;
  isActive: boolean;
};

export type PurchaseOrderRow = {
  id: string;
  number: string;
  status: PurchaseStatus;
  supplierName: string | null;
  totalCents: number;
  paidCents: number;
  expectedAt: string | null;
  createdAt: string;
};

export type PurchaseLine = {
  id: string;
  variantId: string;
  productName: string;
  variantName: string;
  quantityOrdered: number;
  quantityReceived: number;
  unitCostCents: number;
  lineTotalCents: number;
};

export type PurchaseOrder = PurchaseOrderRow & {
  currency: string;
  notes: string | null;
  orderedAt: string | null;
  receivedAt: string | null;
  lines: PurchaseLine[];
};

function rows<T>(data: unknown): T[] {
  return (Array.isArray(data) ? data : data == null ? [] : [data]) as T[];
}

function asStatus(value: string): PurchaseStatus {
  return (PURCHASE_STATUSES as readonly string[]).includes(value)
    ? (value as PurchaseStatus)
    : 'draft';
}

// ---------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------

export async function listSuppliers(
  ctx: TenantContext,
  options: { includeInactive?: boolean } = {},
): Promise<Supplier[]> {
  requirePermission(ctx, 'retail.purchase.read');
  const supabase = createSupabaseServerClient();

  let query = supabase
    .from('retail_suppliers')
    .select('id, name, phone, email, address, tax_id, notes, is_active')
    .eq('organization_id', ctx.organizationId)
    .order('name')
    .limit(500);

  if (!options.includeInactive) query = query.eq('is_active', true);

  const { data, error } = await query;
  if (error) throw toAppError(error, 'listSuppliers');

  return (data ?? []).map((s) => ({
    id: s.id,
    name: s.name,
    phone: s.phone,
    email: s.email,
    address: s.address,
    taxId: s.tax_id,
    notes: s.notes,
    isActive: s.is_active,
  }));
}

export async function createSupplier(
  ctx: TenantContext,
  input: SupplierInput,
): Promise<string> {
  requirePermission(ctx, 'retail.supplier.manage');
  const supabase = createSupabaseServerClient();
  // RLS re-checks `retail.supplier.manage` on this insert; the check above is
  // for the message, not for the security.
  const { data, error } = await supabase
    .from('retail_suppliers')
    .insert({
      organization_id: ctx.organizationId,
      name: input.name,
      phone: input.phone || null,
      email: input.email || null,
      address: input.address || null,
      tax_id: input.taxId || null,
      notes: input.notes || null,
      created_by: ctx.userId,
    })
    .select('id')
    .single();

  if (error) throw toAppError(error, 'createSupplier');
  return data.id;
}

export async function setSupplierActive(
  ctx: TenantContext,
  id: string,
  isActive: boolean,
): Promise<void> {
  requirePermission(ctx, 'retail.supplier.manage');
  const supabase = createSupabaseServerClient();

  const { error } = await supabase
    .from('retail_suppliers')
    .update({ is_active: isActive })
    .eq('id', id)
    .eq('organization_id', ctx.organizationId);

  if (error) throw toAppError(error, 'setSupplierActive');
}

// ---------------------------------------------------------------------------
// Purchase orders
// ---------------------------------------------------------------------------

export async function listPurchaseOrders(
  ctx: TenantContext,
  options: { status?: PurchaseStatus } = {},
): Promise<PurchaseOrderRow[]> {
  requirePermission(ctx, 'retail.purchase.read');
  const supabase = createSupabaseServerClient();

  let query = supabase
    .from('retail_purchase_orders')
    // One string literal, not a concatenation: postgrest-js parses this at the
    // type level, and a concatenation infers as `string`, which makes every
    // row an error type.
    .select('id, number, status, total_cents, paid_cents, expected_at, created_at, retail_suppliers(name)')
    .eq('organization_id', ctx.organizationId)
    .eq('branch_id', ctx.branchId)
    .order('created_at', { ascending: false })
    .limit(200);

  if (options.status) query = query.eq('status', options.status);

  const { data, error } = await query;
  if (error) throw toAppError(error, 'listPurchaseOrders');

  return (data ?? []).map((o) => {
    const supplier = o.retail_suppliers as unknown as { name: string } | null;
    return {
      id: o.id,
      number: o.number,
      status: asStatus(o.status),
      supplierName: supplier?.name ?? null,
      totalCents: Number(o.total_cents),
      paidCents: Number(o.paid_cents),
      expectedAt: o.expected_at,
      createdAt: o.created_at,
    };
  });
}

/** One order with its lines, or null — 404, never 403, for another tenant's. */
export async function getPurchaseOrder(
  ctx: TenantContext,
  id: string,
): Promise<PurchaseOrder | null> {
  requirePermission(ctx, 'retail.purchase.read');
  const supabase = createSupabaseServerClient();

  const { data, error } = await supabase
    .from('retail_purchase_orders')
    .select('id, number, status, currency, total_cents, paid_cents, expected_at, ordered_at, received_at, notes, created_at, retail_suppliers(name)')
    .eq('id', id)
    .eq('organization_id', ctx.organizationId)
    .eq('branch_id', ctx.branchId)
    .maybeSingle();

  if (error) throw toAppError(error, 'getPurchaseOrder');
  if (!data) return null;

  const { data: items, error: itemsError } = await supabase
    .from('retail_purchase_order_items')
    .select('id, variant_id, product_name, variant_name, quantity_ordered, quantity_received, unit_cost_cents, line_total_cents, position')
    .eq('purchase_order_id', id)
    .order('position');

  if (itemsError) throw toAppError(itemsError, 'getPurchaseOrder.items');

  const supplier = data.retail_suppliers as unknown as { name: string } | null;
  return {
    id: data.id,
    number: data.number,
    status: asStatus(data.status),
    currency: data.currency,
    supplierName: supplier?.name ?? null,
    totalCents: Number(data.total_cents),
    paidCents: Number(data.paid_cents),
    expectedAt: data.expected_at,
    orderedAt: data.ordered_at,
    receivedAt: data.received_at,
    notes: data.notes,
    createdAt: data.created_at,
    lines: (items ?? []).map((i) => ({
      id: i.id,
      variantId: i.variant_id,
      productName: i.product_name,
      variantName: i.variant_name,
      quantityOrdered: Number(i.quantity_ordered),
      quantityReceived: Number(i.quantity_received),
      unitCostCents: Number(i.unit_cost_cents),
      lineTotalCents: Number(i.line_total_cents),
    })),
  };
}

export async function createPurchaseOrder(
  ctx: TenantContext,
  input: CreatePurchaseInput,
): Promise<{ id: string; number: string; totalCents: number }> {
  requirePermission(ctx, 'retail.purchase.manage');
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('retail_purchase_create', {
    p_org: ctx.organizationId,
    p_branch: ctx.branchId,
    p_supplier: input.supplierId || null,
    p_items: input.lines.map((l) => ({
      variant_id: l.variantId,
      quantity: l.quantity,
      unit_cost_cents: l.unitCostCents,
    })),
    p_expected_at: input.expectedAt || null,
    p_note: input.note || null,
  });

  if (error) throw new AppError('validation', error.message);
  const row = rows<{ out_id: string; out_number: string; out_total_cents: number }>(data)[0];
  if (!row) throw new AppError('validation', 'تعذّر إنشاء أمر الشراء');

  return { id: row.out_id, number: row.out_number, totalCents: Number(row.out_total_cents) };
}

export async function submitPurchaseOrder(ctx: TenantContext, id: string): Promise<void> {
  requirePermission(ctx, 'retail.purchase.manage');
  const supabase = createSupabaseServerClient();

  const { error } = await supabase.rpc('retail_purchase_submit', {
    p_org: ctx.organizationId,
    p_branch: ctx.branchId,
    p_order: id,
  });
  if (error) throw new AppError('validation', error.message);
}

/**
 * Record a delivery.
 *
 * The quantities come from whoever counted the boxes, which is why this is the
 * one purchasing input a human types twice — once on the order, once on the
 * receipt. The database refuses anything beyond what was ordered.
 */
export async function receivePurchaseOrder(
  ctx: TenantContext,
  input: ReceiveInput,
): Promise<{ status: PurchaseStatus; receivedLines: number }> {
  requirePermission(ctx, 'retail.purchase.manage');
  requirePermission(ctx, 'retail.inventory.adjust');
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('retail_purchase_receive', {
    p_org: ctx.organizationId,
    p_branch: ctx.branchId,
    p_order: input.purchaseOrderId,
    p_lines: input.lines.map((l) => ({ item_id: l.itemId, quantity: l.quantity })),
    p_note: input.note || null,
  });

  if (error) throw new AppError('validation', error.message);
  const row = rows<{ out_status: string; out_received_lines: number }>(data)[0];
  return {
    status: asStatus(row?.out_status ?? 'ordered'),
    receivedLines: Number(row?.out_received_lines ?? 0),
  };
}

export async function cancelPurchaseOrder(
  ctx: TenantContext,
  id: string,
  reason?: string,
): Promise<void> {
  requirePermission(ctx, 'retail.purchase.manage');
  const supabase = createSupabaseServerClient();

  const { error } = await supabase.rpc('retail_purchase_cancel', {
    p_org: ctx.organizationId,
    p_branch: ctx.branchId,
    p_order: id,
    p_reason: reason || null,
  });
  if (error) throw new AppError('validation', error.message);
}

/** Pay a supplier. Money out of the treasury, capped at the order total. */
export async function payPurchaseOrder(
  ctx: TenantContext,
  input: PayInput,
): Promise<{ paidCents: number; totalCents: number }> {
  requirePermission(ctx, 'retail.purchase.manage');
  requirePermission(ctx, 'treasury.create');
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('retail_purchase_pay', {
    p_org: ctx.organizationId,
    p_branch: ctx.branchId,
    p_order: input.purchaseOrderId,
    p_amount_cents: input.amountCents,
    p_account: null,
    p_note: input.note || null,
  });

  if (error) throw new AppError('validation', error.message);
  const row = rows<{ out_paid_cents: number; out_total_cents: number }>(data)[0];
  return {
    paidCents: Number(row?.out_paid_cents ?? 0),
    totalCents: Number(row?.out_total_cents ?? 0),
  };
}

/** Variants a purchase line can name, for the order builder. */
export async function listPurchasableVariants(ctx: TenantContext): Promise<
  { id: string; label: string; costCents: number }[]
> {
  requirePermission(ctx, 'retail.purchase.manage');
  const supabase = createSupabaseServerClient();

  const { data, error } = await supabase
    .from('retail_variants')
    .select('id, name, sku, cost_cents, retail_products!inner(name)')
    .eq('organization_id', ctx.organizationId)
    .eq('is_active', true)
    .is('deleted_at', null)
    .limit(500);

  if (error) throw toAppError(error, 'listPurchasableVariants');

  return (data ?? []).map((v) => {
    const product = v.retail_products as unknown as { name: string } | null;
    const base = `${product?.name ?? '—'}${v.name && v.name !== 'default' ? ` — ${v.name}` : ''}`;
    return {
      id: v.id,
      label: v.sku ? `${base} (${v.sku})` : base,
      costCents: Number(v.cost_cents),
    };
  });
}
