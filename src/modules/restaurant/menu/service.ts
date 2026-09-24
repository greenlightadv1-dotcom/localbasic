import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { toAppError, notFound } from '@/lib/errors';
import type { TenantContext } from '@/modules/core/tenancy/context';
import type { MenuProductInput } from './schemas';

export type MenuVariant = {
  id: string;
  name: string;
  priceCents: number;
  isAvailableHere: boolean;
};

export type MenuItem = {
  id: string;
  name: string;
  description: string | null;
  categoryId: string | null;
  categoryName: string | null;
  taxRateBp: number;
  prepMinutes: number;
  isActive: boolean;
  isBestSeller: boolean;
  variants: MenuVariant[];
  modifierGroupCount: number;
};

/**
 * The full menu for the admin screens, with this branch's availability folded
 * in. Availability is per branch, so the same menu reads differently at each
 * location without duplicating a single item.
 */
export async function listMenu(ctx: TenantContext): Promise<MenuItem[]> {
  const supabase = createSupabaseServerClient();

  const [{ data: products, error }, { data: categories }] = await Promise.all([
    supabase
      .from('restaurant_products')
      .select(
        'id, name, description, category_id, tax_rate_bp, prep_minutes, is_active, is_best_seller, sort_order',
      )
      .eq('organization_id', ctx.organizationId)
      .is('deleted_at', null)
      .order('sort_order')
      .order('name'),
    supabase
      .from('restaurant_categories')
      .select('id, name')
      .eq('organization_id', ctx.organizationId),
  ]);

  if (error) throw toAppError(error, 'listMenu');
  if (!products?.length) return [];

  const productIds = products.map((p) => p.id);
  const [{ data: variants }, { data: groups }] = await Promise.all([
    supabase
      .from('restaurant_variants')
      .select('id, product_id, name, price_cents, sort_order')
      .in('product_id', productIds)
      .is('deleted_at', null)
      .order('sort_order'),
    supabase
      .from('restaurant_modifier_groups')
      .select('id, product_id')
      .in('product_id', productIds),
  ]);

  const variantIds = (variants ?? []).map((v) => v.id);
  const { data: availability } = variantIds.length
    ? await supabase
        .from('restaurant_branch_availability')
        .select('variant_id, is_available')
        .eq('branch_id', ctx.branchId)
        .in('variant_id', variantIds)
    : { data: [] as { variant_id: string; is_available: boolean }[] };

  // Absence of a row means available — a branch only records what it ran out of.
  const unavailable = new Set(
    (availability ?? []).filter((a) => !a.is_available).map((a) => a.variant_id),
  );
  const categoryName = new Map((categories ?? []).map((c) => [c.id, c.name]));

  return products.map((product) => ({
    id: product.id,
    name: product.name,
    description: product.description,
    categoryId: product.category_id,
    categoryName: product.category_id ? (categoryName.get(product.category_id) ?? null) : null,
    taxRateBp: product.tax_rate_bp,
    prepMinutes: product.prep_minutes,
    isActive: product.is_active,
    isBestSeller: product.is_best_seller,
    variants: (variants ?? [])
      .filter((v) => v.product_id === product.id)
      .map((v) => ({
        id: v.id,
        name: v.name,
        priceCents: v.price_cents,
        isAvailableHere: !unavailable.has(v.id),
      })),
    modifierGroupCount: (groups ?? []).filter((g) => g.product_id === product.id).length,
  }));
}

export async function listCategories(ctx: TenantContext) {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from('restaurant_categories')
    .select('id, name, description, sort_order, is_active')
    .eq('organization_id', ctx.organizationId)
    .order('sort_order')
    .order('name');
  if (error) throw toAppError(error, 'listCategories');
  return data ?? [];
}

export async function createCategory(
  ctx: TenantContext,
  input: { name: string; description?: string; sortOrder: number },
) {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from('restaurant_categories')
    .insert({
      organization_id: ctx.organizationId,
      name: input.name,
      description: input.description ?? null,
      sort_order: input.sortOrder,
      created_by: ctx.userId,
    })
    .select('id')
    .single();
  if (error) throw toAppError(error, 'createCategory');
  return data;
}

/**
 * Creates a menu item with its variants and modifier groups.
 *
 * A dish with no sizes still gets one variant named "default", so ordering,
 * pricing and reporting only ever deal with one shape.
 */
export async function createMenuProduct(ctx: TenantContext, input: MenuProductInput) {
  const supabase = createSupabaseServerClient();

  const { data: product, error } = await supabase
    .from('restaurant_products')
    .insert({
      organization_id: ctx.organizationId,
      category_id: input.categoryId ?? null,
      name: input.name,
      description: input.description ?? null,
      tax_rate_bp: Math.round(input.taxRatePercent * 100),
      prep_minutes: input.prepMinutes,
      created_by: ctx.userId,
    })
    .select('id')
    .single();
  if (error) throw toAppError(error, 'createMenuProduct');

  const { error: variantError } = await supabase.from('restaurant_variants').insert(
    input.variants.map((v, index) => ({
      organization_id: ctx.organizationId,
      product_id: product.id,
      name: v.name || 'default',
      price_cents: v.priceCents,
      sort_order: index,
    })),
  );
  if (variantError) throw toAppError(variantError, 'createMenuProduct variants');

  for (const [index, group] of input.modifierGroups.entries()) {
    const { data: created, error: groupError } = await supabase
      .from('restaurant_modifier_groups')
      .insert({
        organization_id: ctx.organizationId,
        product_id: product.id,
        name: group.name,
        min_select: group.minSelect,
        max_select: Math.max(group.maxSelect, group.minSelect),
        sort_order: index,
      })
      .select('id')
      .single();
    if (groupError) throw toAppError(groupError, 'createMenuProduct group');

    if (group.modifiers.length) {
      const { error: modifierError } = await supabase.from('restaurant_modifiers').insert(
        group.modifiers.map((m, i) => ({
          organization_id: ctx.organizationId,
          group_id: created.id,
          name: m.name,
          price_cents: m.priceCents,
          sort_order: i,
        })),
      );
      if (modifierError) throw toAppError(modifierError, 'createMenuProduct modifiers');
    }
  }

  return { id: product.id };
}

export async function setProductActive(ctx: TenantContext, productId: string, isActive: boolean) {
  const supabase = createSupabaseServerClient();
  const { error } = await supabase
    .from('restaurant_products')
    .update({ is_active: isActive })
    .eq('organization_id', ctx.organizationId)
    .eq('id', productId);
  if (error) throw toAppError(error, 'setProductActive');
}

/** Toggles the "best seller" highlight — a merchandising flag, not availability. */
export async function setProductBestSeller(
  ctx: TenantContext,
  productId: string,
  isBestSeller: boolean,
) {
  const supabase = createSupabaseServerClient();
  const { error } = await supabase
    .from('restaurant_products')
    .update({ is_best_seller: isBestSeller })
    .eq('organization_id', ctx.organizationId)
    .eq('id', productId);
  if (error) throw toAppError(error, 'setProductBestSeller');
}

/**
 * Marks a dish available or "86'd" at this branch only.
 *
 * Recorded as an explicit row rather than a flag on the variant, so one branch
 * running out never affects the others.
 */
export async function setBranchAvailability(
  ctx: TenantContext,
  input: { variantId: string; isAvailable: boolean; note?: string },
) {
  const supabase = createSupabaseServerClient();
  const { error } = await supabase.from('restaurant_branch_availability').upsert(
    {
      organization_id: ctx.organizationId,
      branch_id: ctx.branchId,
      variant_id: input.variantId,
      is_available: input.isAvailable,
      unavailable_note: input.note ?? null,
      updated_at: new Date().toISOString(),
      updated_by: ctx.userId,
    },
    { onConflict: 'branch_id,variant_id' },
  );
  if (error) throw toAppError(error, 'setBranchAvailability');
}

export async function getMenuProduct(ctx: TenantContext, productId: string) {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from('restaurant_products')
    .select('id, name, description, category_id, tax_rate_bp, prep_minutes, is_active')
    .eq('organization_id', ctx.organizationId)
    .eq('id', productId)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw toAppError(error, 'getMenuProduct');
  if (!data) throw notFound();
  return data;
}
