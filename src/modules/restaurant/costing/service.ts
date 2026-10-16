import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { toDataUnavailable } from '@/lib/errors';
import type { TenantContext } from '@/modules/core/tenancy/context';
import type { BaseUnit } from '@/modules/restaurant/inventory/units';
import type { MenuItemPerformance } from './calc';

/**
 * Recipe costing and menu engineering reads (0109). The cost of a dish is its
 * recipe (restaurant_recipe_items, the BOM) at each item's current moving
 * average cost — recomputed on every read, so a dearer delivery shows up in
 * every dish that uses it straight away.
 */

export type CostedVariant = {
  variantId: string; productId: string; productName: string; variantName: string; categoryName: string | null;
  priceCents: number; costCents: number; lineCount: number; missingCost: boolean;
  lines: { itemId: string; qty: number; locationKind: 'kitchen' | 'bar' | null }[];
};
export type CostItem = { id: string; name: string; unit: BaseUnit; avgCostCents: number; isActive: boolean };

export async function getRecipeBoard(ctx: TenantContext): Promise<{ variants: CostedVariant[]; items: CostItem[] }> {
  const supabase = createSupabaseServerClient();
  const [costs, lines, items] = await Promise.all([
    supabase.rpc('restaurant_recipe_costs' as never, { p_org: ctx.organizationId } as never),
    supabase.from('restaurant_recipe_items').select('variant_id, inventory_item_id, quantity, location_kind').eq('organization_id', ctx.organizationId),
    supabase.from('inventory_items').select('id, name, unit, avg_cost_cents, is_active').eq('organization_id', ctx.organizationId).order('name'),
  ]);
  if (costs.error) throw toDataUnavailable(costs.error, 'getRecipeBoard costs');
  if (lines.error) throw toDataUnavailable(lines.error, 'getRecipeBoard lines');
  if (items.error) throw toDataUnavailable(items.error, 'getRecipeBoard items');
  const byVariant = new Map<string, CostedVariant['lines']>();
  for (const l of lines.data ?? []) {
    const list = byVariant.get(l.variant_id) ?? [];
    list.push({ itemId: l.inventory_item_id, qty: Number(l.quantity), locationKind: l.location_kind });
    byVariant.set(l.variant_id, list);
  }
  return {
    variants: ((costs.data ?? []) as unknown as Record<string, unknown>[]).map((r) => ({
      variantId: String(r.out_variant_id), productId: String(r.out_product_id), productName: String(r.out_product_name),
      variantName: String(r.out_variant_name), categoryName: (r.out_category_name as string) ?? null,
      priceCents: Number(r.out_price_cents), costCents: Number(r.out_cost_cents), lineCount: Number(r.out_line_count),
      missingCost: Boolean(r.out_missing_cost), lines: byVariant.get(String(r.out_variant_id)) ?? [],
    })),
    items: (items.data ?? []).map((i) => ({ id: i.id, name: i.name, unit: i.unit, avgCostCents: Number(i.avg_cost_cents), isActive: i.is_active })),
  };
}

export type MenuMatrixRow = MenuItemPerformance & { productName: string; variantName: string; categoryName: string | null };

export async function getMenuPerformance(ctx: TenantContext, from: Date, to: Date, allBranches: boolean): Promise<MenuMatrixRow[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('restaurant_menu_engineering' as never, {
    p_org: ctx.organizationId, p_branch: allBranches ? null : ctx.branchId, p_from: from.toISOString(), p_to: to.toISOString(),
  } as never);
  if (error) throw toDataUnavailable(error, 'getMenuPerformance');
  return ((data ?? []) as unknown as Record<string, unknown>[]).map((r) => {
    const productName = String(r.out_product_name);
    const variantName = String(r.out_variant_name);
    return {
      variantId: String(r.out_variant_id), productName, variantName, categoryName: (r.out_category_name as string) ?? null,
      name: variantName && variantName !== 'default' && variantName !== productName ? `${productName} — ${variantName}` : productName,
      qtySold: Number(r.out_qty_sold), revenueCents: Number(r.out_revenue_cents), unitCostCents: Number(r.out_unit_cost_cents),
      hasRecipe: Boolean(r.out_has_recipe),
    };
  });
}
