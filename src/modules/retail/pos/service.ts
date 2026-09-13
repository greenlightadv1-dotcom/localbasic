import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { AppError, notFound, toAppError } from '@/lib/errors';
import type { TenantContext } from '@/modules/core/tenancy/context';
import type { PosSaleInput } from './schemas';

export type PosProduct = {
  variantId: string;
  productName: string;
  variantName: string;
  sku: string | null;
  barcode: string | null;
  priceCents: number;
  taxRateBp: number;
  unit: string;
  stock: number;
};

/**
 * POS catalog for the current branch: everything sellable, with its price and
 * live stock. Loaded once and filtered in the browser, because at the till a
 * round trip per keystroke is the difference between fast and unusable.
 */
export async function listPosCatalog(ctx: TenantContext): Promise<PosProduct[]> {
  const supabase = createSupabaseServerClient();

  const { data: variants, error } = await supabase
    .from('retail_variants')
    .select(
      'id, name, sku, barcode, price_cents, retail_products!inner(name, unit, tax_rate_bp, is_active)',
    )
    .eq('organization_id', ctx.organizationId)
    .eq('is_active', true)
    .is('deleted_at', null)
    .limit(2000);

  if (error) throw toAppError(error, 'listPosCatalog');
  if (!variants?.length) return [];

  const { data: levels } = await supabase
    .from('retail_stock_levels')
    .select('variant_id, quantity')
    .eq('branch_id', ctx.branchId)
    .in(
      'variant_id',
      variants.map((v) => v.id),
    );

  const stock = new Map((levels ?? []).map((l) => [l.variant_id, Number(l.quantity)]));

  return variants
    .map((v) => {
      const product = v.retail_products as unknown as {
        name: string;
        unit: string;
        tax_rate_bp: number;
        is_active: boolean;
      } | null;
      if (!product?.is_active) return null;
      return {
        variantId: v.id,
        productName: product.name,
        variantName: v.name,
        sku: v.sku,
        barcode: v.barcode,
        priceCents: v.price_cents,
        taxRateBp: product.tax_rate_bp,
        unit: product.unit,
        stock: stock.get(v.id) ?? 0,
      };
    })
    .filter((p): p is PosProduct => p !== null);
}

export type SaleResult = {
  invoiceId: string;
  invoiceNumber: string;
  totalCents: number;
  paidCents: number;
  changeCents: number;
};

/**
 * Completes a sale.
 *
 * All the work happens inside retail_create_sale: one transaction covering
 * invoice, items, stock, payment, treasury and audit, with prices read from
 * the database. This function only translates the result and turns database
 * error codes into messages a cashier can act on.
 */
export async function createSale(ctx: TenantContext, input: PosSaleInput): Promise<SaleResult> {
  const supabase = createSupabaseServerClient();

  const { data, error } = await supabase
    .rpc('retail_create_sale', {
      p_org: ctx.organizationId,
      p_branch: ctx.branchId,
      p_items: input.items.map((i) => ({
        variant_id: i.variantId,
        quantity: i.quantity,
        discount_cents: i.discountCents,
      })),
      p_method: input.method,
      p_tendered_cents: input.tenderedCents,
      p_customer_id: input.customerId ?? null,
      p_order_discount_cents: input.orderDiscountCents,
      p_note: input.note ?? null,
    })
    .single();

  if (error) {
    // 23514 is the non-negative stock CHECK: the basket exceeds what is here.
    if (error.code === '23514' || error.message.includes('retail_stock_non_negative')) {
      throw new AppError('conflict', 'الكمية المطلوبة غير متوفرة في المخزون.');
    }
    if (error.code === '42501') {
      throw new AppError('forbidden', 'ليس لديك صلاحية لإتمام هذه العملية.');
    }
    throw toAppError(error, 'createSale');
  }

  const row = data as unknown as {
    out_invoice_id: string;
    out_invoice_number: string;
    out_total_cents: number;
    out_paid_cents: number;
    out_change_cents: number;
  } | null;
  if (!row) throw new AppError('internal');

  return {
    invoiceId: row.out_invoice_id,
    invoiceNumber: row.out_invoice_number,
    totalCents: row.out_total_cents,
    paidCents: row.out_paid_cents,
    changeCents: row.out_change_cents,
  };
}

/** A completed sale, for the receipt view. */
export async function getReceipt(ctx: TenantContext, invoiceId: string) {
  const supabase = createSupabaseServerClient();

  const { data: invoice, error } = await supabase
    .from('invoices')
    .select(
      'id, number, status, currency, subtotal_cents, discount_cents, tax_cents, total_cents, paid_cents, created_at, customer_id',
    )
    .eq('organization_id', ctx.organizationId)
    .eq('id', invoiceId)
    .maybeSingle();

  if (error) throw toAppError(error, 'getReceipt');
  if (!invoice) throw notFound();

  const { data: items } = await supabase
    .from('invoice_items')
    .select('description, quantity, unit_price_cents, discount_cents, total_cents')
    .eq('invoice_id', invoiceId)
    .order('position');

  return { invoice, items: items ?? [] };
}
