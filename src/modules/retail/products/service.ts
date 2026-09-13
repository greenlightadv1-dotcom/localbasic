import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { conflict, notFound, toAppError } from '@/lib/errors';
import type { TenantContext } from '@/modules/core/tenancy/context';
import type { CreateProductInput } from './schemas';

export type ProductListItem = {
  id: string;
  name: string;
  unit: string;
  isActive: boolean;
  isOnline: boolean;
  categoryName: string | null;
  variantCount: number;
  priceFromCents: number;
  stock: number;
};

/**
 * Product list for the current branch, with stock for that branch only.
 *
 * The catalog is organization-wide but stock is per branch, so the two are
 * read separately and joined here rather than pretending a product "has" a
 * quantity.
 */
export async function listProducts(
  ctx: TenantContext,
  options: { search?: string; limit?: number } = {},
): Promise<ProductListItem[]> {
  const supabase = createSupabaseServerClient();
  const limit = Math.min(options.limit ?? 100, 200);

  let query = supabase
    .from('retail_products')
    .select('id, name, unit, is_active, is_online, category_id')
    .eq('organization_id', ctx.organizationId)
    .is('deleted_at', null)
    .order('name')
    .limit(limit);

  if (options.search?.trim()) {
    // Escape the LIKE wildcards a user might type so a search for "50%" does
    // not turn into a match-everything pattern.
    const term = options.search.trim().replace(/[%_\\]/g, (m) => `\\${m}`);
    query = query.ilike('name', `%${term}%`);
  }

  const { data: products, error } = await query;
  if (error) throw toAppError(error, 'listProducts');
  if (!products?.length) return [];

  const productIds = products.map((p) => p.id);
  const categoryIds = [...new Set(products.map((p) => p.category_id).filter(Boolean))] as string[];

  const [{ data: variants }, { data: categories }] = await Promise.all([
    supabase
      .from('retail_variants')
      .select('id, product_id, price_cents')
      .in('product_id', productIds)
      .is('deleted_at', null),
    categoryIds.length
      ? supabase.from('retail_categories').select('id, name').in('id', categoryIds)
      : Promise.resolve({ data: [] as { id: string; name: string }[] }),
  ]);

  const variantIds = (variants ?? []).map((v) => v.id);
  const { data: stock } = variantIds.length
    ? await supabase
        .from('retail_stock_levels')
        .select('variant_id, quantity')
        .eq('branch_id', ctx.branchId)
        .in('variant_id', variantIds)
    : { data: [] as { variant_id: string; quantity: number }[] };

  const stockByVariant = new Map((stock ?? []).map((s) => [s.variant_id, Number(s.quantity)]));
  const categoryById = new Map((categories ?? []).map((c) => [c.id, c.name]));

  return products.map((product) => {
    const own = (variants ?? []).filter((v) => v.product_id === product.id);
    return {
      id: product.id,
      name: product.name,
      unit: product.unit,
      isActive: product.is_active,
      isOnline: product.is_online,
      categoryName: product.category_id ? (categoryById.get(product.category_id) ?? null) : null,
      variantCount: own.length,
      priceFromCents: own.length ? Math.min(...own.map((v) => v.price_cents)) : 0,
      stock: own.reduce((sum, v) => sum + (stockByVariant.get(v.id) ?? 0), 0),
    };
  });
}

export async function listCategories(ctx: TenantContext) {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from('retail_categories')
    .select('id, name')
    .eq('organization_id', ctx.organizationId)
    .eq('is_active', true)
    .order('sort_order')
    .order('name');
  if (error) throw toAppError(error, 'listCategories');
  return data ?? [];
}

export async function createCategory(ctx: TenantContext, name: string) {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from('retail_categories')
    .insert({ organization_id: ctx.organizationId, name, created_by: ctx.userId })
    .select('id, name')
    .single();
  if (error) throw toAppError(error, 'createCategory');
  return data;
}

/**
 * Creates a product with its variants, and records opening stock as `initial`
 * movements so the very first quantity is part of the ledger like every other
 * change — there is no way to set a stock figure outside it.
 */
export async function createProduct(ctx: TenantContext, input: CreateProductInput) {
  const supabase = createSupabaseServerClient();

  const { data: product, error: productError } = await supabase
    .from('retail_products')
    .insert({
      organization_id: ctx.organizationId,
      category_id: input.categoryId ?? null,
      name: input.name,
      description: input.description ?? null,
      unit: input.unit,
      tax_rate_bp: Math.round(input.taxRatePercent * 100),
      is_online: input.isOnline,
      created_by: ctx.userId,
    })
    .select('id')
    .single();

  if (productError) throw toAppError(productError, 'createProduct');

  const { data: variants, error: variantError } = await supabase
    .from('retail_variants')
    .insert(
      input.variants.map((v) => ({
        organization_id: ctx.organizationId,
        product_id: product.id,
        name: v.name || 'default',
        sku: v.sku || null,
        barcode: v.barcode || null,
        price_cents: v.priceCents,
        cost_cents: v.costCents ?? 0,
        reorder_point: v.reorderPoint,
      })),
    )
    .select('id');

  if (variantError) {
    // 23505 = unique_violation on SKU or barcode within this organization.
    if (variantError.code === '23505') {
      throw conflict('كود المنتج أو الباركود مستخدم بالفعل في منتج آخر.');
    }
    throw toAppError(variantError, 'createProduct variants');
  }

  const openings = input.variants
    .map((v, index) => ({ variant: variants?.[index], quantity: v.openingQuantity }))
    .filter((o) => o.variant && o.quantity > 0);

  if (openings.length) {
    const { error: stockError } = await supabase.from('retail_stock_movements').insert(
      openings.map((o) => ({
        organization_id: ctx.organizationId,
        branch_id: ctx.branchId,
        variant_id: o.variant!.id,
        quantity_delta: o.quantity,
        reason: 'initial' as const,
        ref_type: 'manual',
        created_by: ctx.userId,
      })),
    );
    if (stockError) throw toAppError(stockError, 'createProduct opening stock');
  }

  return { id: product.id };
}

export async function getProduct(ctx: TenantContext, productId: string) {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from('retail_products')
    .select('id, name, description, unit, tax_rate_bp, category_id, is_active, is_online')
    .eq('organization_id', ctx.organizationId)
    .eq('id', productId)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw toAppError(error, 'getProduct');
  if (!data) throw notFound();

  const { data: variants } = await supabase
    .from('retail_variants')
    .select('id, name, sku, barcode, price_cents, cost_cents, reorder_point, is_active')
    .eq('product_id', productId)
    .is('deleted_at', null)
    .order('created_at');

  return { product: data, variants: variants ?? [] };
}
