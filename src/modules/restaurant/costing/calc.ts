/**
 * Recipe costing, BOM requirements, reorder quantities and menu engineering —
 * pure functions, client-safe. The database is the authority for what is
 * charged, deducted and ordered (0102/0109); these give the screens the same
 * numbers live while a manager edits, and are unit-tested to the same rules.
 *
 * Money is in cents; a cost per base unit may be fractional (0.5 cents/g), so
 * costs are carried unrounded and rounded once, at display.
 */

export type RecipeLine = { itemId: string; qty: number };
export type ItemCost = { itemId: string; unitCostCents: number };

/** Cost of one portion: Σ qty × the item's average cost per base unit. */
export function recipeCost(lines: RecipeLine[], costs: ItemCost[] | Map<string, number>): { costCents: number; missing: string[] } {
  const byId = costs instanceof Map ? costs : new Map(costs.map((c) => [c.itemId, c.unitCostCents]));
  let costCents = 0;
  const missing: string[] = [];
  for (const l of lines) {
    const unit = byId.get(l.itemId);
    if (!unit) { missing.push(l.itemId); continue; }
    costCents += l.qty * unit;
  }
  return { costCents, missing };
}

/** Food cost as a fraction of the menu price (0.3 = 30%); null when there is no price. */
export function foodCostRatio(costCents: number, priceCents: number): number | null {
  return priceCents > 0 ? costCents / priceCents : null;
}

/** Margin per portion and the price that would hit a target food-cost ratio. */
export function pricing(costCents: number, priceCents: number, targetRatio = 0.3) {
  return {
    marginCents: priceCents - costCents,
    ratio: foodCostRatio(costCents, priceCents),
    suggestedPriceCents: targetRatio > 0 ? Math.ceil(costCents / targetRatio) : null,
  };
}

/**
 * What a set of order lines takes from stock: every recipe line × the ordered
 * quantity, summed per item. This is the rule the database applies when an
 * order is confirmed to its station (0102 app.inventory_consume_line).
 */
export function bomRequirement(
  orderLines: { variantId: string; quantity: number }[],
  recipes: Map<string, RecipeLine[]> | Record<string, RecipeLine[]>,
): Map<string, number> {
  const get = (id: string) => (recipes instanceof Map ? recipes.get(id) : recipes[id]) ?? [];
  const out = new Map<string, number>();
  for (const o of orderLines) {
    if (!(o.quantity > 0)) continue;
    for (const l of get(o.variantId)) {
      out.set(l.itemId, round3((out.get(l.itemId) ?? 0) + l.qty * o.quantity));
    }
  }
  return out;
}

/**
 * The reorder rule of 0109 app.reorder_suggestions: at or below the minimum
 * and not already covered by open purchase orders → the reorder quantity, or
 * (none set) enough to reach twice the minimum. 0 = nothing to order.
 */
export function suggestedReorder(t: { onHand: number; minQty: number; reorderQty: number | null; openPoQty?: number }): number {
  const open = t.openPoQty ?? 0;
  if (t.onHand > t.minQty || t.onHand + open > t.minQty) return 0;
  if (t.reorderQty !== null) return t.reorderQty;
  return Math.max(round3(2 * t.minQty - t.onHand - open), 0);
}

// ---------------------------------------------------------------------------
// Menu engineering (Kasavana & Smith)
// ---------------------------------------------------------------------------
export type Quadrant = 'star' | 'plowhorse' | 'puzzle' | 'dog';
export const QUADRANT_LABELS: Record<Quadrant, { title: string; advice: string }> = {
  star:      { title: 'نجوم',         advice: 'شعبية وربحية عالية: حافظ على الجودة والمكان البارز.' },
  plowhorse: { title: 'أحصنة العمل',  advice: 'تُباع كثيرًا بهامش ضعيف: راجع التكلفة أو ارفع السعر قليلًا.' },
  puzzle:    { title: 'ألغاز',        advice: 'هامش عالٍ ومبيعات قليلة: أبرزها في المنيو ودرّب الطاقم على اقتراحها.' },
  dog:       { title: 'كلاب',         advice: 'ضعيفة في الاثنين: أعد تصميمها أو احذفها من المنيو.' },
};

export type MenuItemPerformance = {
  variantId: string; name: string; qtySold: number; revenueCents: number; unitCostCents: number; hasRecipe: boolean;
};
export type ClassifiedItem = MenuItemPerformance & {
  avgPriceCents: number; unitMarginCents: number; totalMarginCents: number; mixShare: number;
  highPopularity: boolean; highProfit: boolean; quadrant: Quadrant;
};

/**
 * Popularity: an item is popular when its share of units sold reaches 70% of
 * an equal share (0.7 / N). Profitability: its contribution margin per unit
 * reaches the menu's weighted-average margin (total margin ÷ total units).
 */
export function classifyMenu(items: MenuItemPerformance[], popularityFactor = 0.7): {
  items: ClassifiedItem[]; popularityThreshold: number; avgMarginCents: number; totalUnits: number; totalMarginCents: number;
} {
  const sold = items.filter((i) => i.qtySold > 0);
  const totalUnits = sold.reduce((s, i) => s + i.qtySold, 0);
  const n = sold.length;
  const popularityThreshold = n ? popularityFactor / n : 0;
  const withMargin = sold.map((i) => {
    const avgPriceCents = i.revenueCents / i.qtySold;
    const unitMarginCents = avgPriceCents - i.unitCostCents;
    return { ...i, avgPriceCents, unitMarginCents, totalMarginCents: unitMarginCents * i.qtySold };
  });
  const totalMarginCents = withMargin.reduce((s, i) => s + i.totalMarginCents, 0);
  const avgMarginCents = totalUnits ? totalMarginCents / totalUnits : 0;
  const classified = withMargin.map((i) => {
    const mixShare = totalUnits ? i.qtySold / totalUnits : 0;
    const highPopularity = mixShare >= popularityThreshold;
    const highProfit = i.unitMarginCents >= avgMarginCents;
    const quadrant: Quadrant = highPopularity ? (highProfit ? 'star' : 'plowhorse') : highProfit ? 'puzzle' : 'dog';
    return { ...i, mixShare, highPopularity, highProfit, quadrant };
  });
  return { items: classified, popularityThreshold, avgMarginCents, totalUnits, totalMarginCents };
}

function round3(n: number) { return Math.round(n * 1000) / 1000; }
