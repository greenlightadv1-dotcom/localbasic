import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { toAppError } from '@/lib/errors';
import type { TenantContext } from '@/modules/core/tenancy/context';

export type StockRow = {
  variantId: string;
  productName: string;
  variantName: string;
  sku: string | null;
  barcode: string | null;
  quantity: number;
  reorderPoint: number;
  priceCents: number;
  status: 'ok' | 'low' | 'out';
};

/**
 * Stock for the current branch. Every variant in the catalog appears, whether
 * or not it has a stock row — a product that has never been stocked reads as
 * zero rather than vanishing from the list.
 */
export async function listStock(
  ctx: TenantContext,
  options: { search?: string; only?: 'low' | 'out' } = {},
): Promise<StockRow[]> {
  const supabase = createSupabaseServerClient();

  const { data: variants, error } = await supabase
    .from('retail_variants')
    .select('id, name, sku, barcode, price_cents, reorder_point, retail_products!inner(name)')
    .eq('organization_id', ctx.organizationId)
    .eq('is_active', true)
    .is('deleted_at', null)
    .limit(500);

  if (error) throw toAppError(error, 'listStock');
  if (!variants?.length) return [];

  const { data: levels } = await supabase
    .from('retail_stock_levels')
    .select('variant_id, quantity')
    .eq('branch_id', ctx.branchId)
    .in(
      'variant_id',
      variants.map((v) => v.id),
    );

  const byVariant = new Map((levels ?? []).map((l) => [l.variant_id, Number(l.quantity)]));

  let rows: StockRow[] = variants.map((v) => {
    const product = v.retail_products as unknown as { name: string } | null;
    const quantity = byVariant.get(v.id) ?? 0;
    const reorderPoint = Number(v.reorder_point);
    return {
      variantId: v.id,
      productName: product?.name ?? '—',
      variantName: v.name,
      sku: v.sku,
      barcode: v.barcode,
      quantity,
      reorderPoint,
      priceCents: v.price_cents,
      status: quantity <= 0 ? 'out' : quantity <= reorderPoint ? 'low' : 'ok',
    };
  });

  if (options.search?.trim()) {
    const term = options.search.trim().toLowerCase();
    rows = rows.filter(
      (r) =>
        r.productName.toLowerCase().includes(term) ||
        r.sku?.toLowerCase().includes(term) ||
        r.barcode?.toLowerCase().includes(term),
    );
  }
  if (options.only) rows = rows.filter((r) => r.status === options.only);

  return rows.sort((a, b) => a.productName.localeCompare(b.productName, 'ar'));
}

/**
 * Records a stock movement. The database decides whether this member may make
 * this kind of movement — a `sale` needs retail.pos.use, a `damage` needs
 * retail.inventory.adjust — so there is no permission logic duplicated here.
 */
export async function adjustStock(
  ctx: TenantContext,
  input: {
    variantId: string;
    quantityDelta: number;
    reason: 'adjustment' | 'damage' | 'stocktake' | 'transfer_in' | 'transfer_out' | 'initial';
    note?: string;
  },
) {
  const supabase = createSupabaseServerClient();
  const { error } = await supabase.from('retail_stock_movements').insert({
    organization_id: ctx.organizationId,
    branch_id: ctx.branchId,
    variant_id: input.variantId,
    quantity_delta: input.quantityDelta,
    reason: input.reason,
    ref_type: 'manual',
    note: input.note ?? null,
    created_by: ctx.userId,
  });

  // 23514 = check_violation, i.e. the movement would drive stock negative.
  if (error?.code === '23514') {
    throw toAppError(
      Object.assign(new Error('insufficient stock'), { publicMessage: true }),
      'adjustStock',
    );
  }
  if (error) throw toAppError(error, 'adjustStock');
}

export async function listMovements(ctx: TenantContext, variantId?: string, limit = 50) {
  const supabase = createSupabaseServerClient();
  let query = supabase
    .from('retail_stock_movements')
    .select('id, variant_id, quantity_delta, reason, ref_type, note, occurred_at')
    .eq('organization_id', ctx.organizationId)
    .eq('branch_id', ctx.branchId)
    .order('occurred_at', { ascending: false })
    .limit(Math.min(limit, 200));

  if (variantId) query = query.eq('variant_id', variantId);

  const { data, error } = await query;
  if (error) throw toAppError(error, 'listMovements');
  return data ?? [];
}
