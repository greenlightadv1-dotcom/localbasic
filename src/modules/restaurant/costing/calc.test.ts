import { describe, expect, it } from 'vitest';
import { bomRequirement, classifyMenu, foodCostRatio, pricing, recipeCost, suggestedReorder } from './calc';

describe('recipeCost', () => {
  const costs = [{ itemId: 'tomato', unitCostCents: 2 }, { itemId: 'orange', unitCostCents: 300 }, { itemId: 'oil', unitCostCents: 0.45 }];
  it('sums qty × average cost per base unit', () => {
    // The same salad as SQL test 41: 150 g tomato + 1 orange.
    expect(recipeCost([{ itemId: 'tomato', qty: 150 }, { itemId: 'orange', qty: 1 }], costs)).toEqual({ costCents: 600, missing: [] });
  });
  it('keeps fractional unit costs unrounded', () => {
    expect(recipeCost([{ itemId: 'oil', qty: 15 }], costs).costCents).toBeCloseTo(6.75, 10);
  });
  it('flags lines whose item has no cost yet', () => {
    const r = recipeCost([{ itemId: 'tomato', qty: 100 }, { itemId: 'saffron', qty: 1 }], costs);
    expect(r.costCents).toBe(200);
    expect(r.missing).toEqual(['saffron']);
  });
  it('accepts a map and an empty recipe', () => {
    expect(recipeCost([], new Map()).costCents).toBe(0);
    expect(recipeCost([{ itemId: 'a', qty: 2 }], new Map([['a', 5]])).costCents).toBe(10);
  });
});

describe('pricing', () => {
  it('ratio, margin and the price for a target food cost', () => {
    expect(foodCostRatio(1200, 4000)).toBeCloseTo(0.3);
    expect(foodCostRatio(100, 0)).toBeNull();
    expect(pricing(1200, 4000)).toEqual({ marginCents: 2800, ratio: 0.3, suggestedPriceCents: 4000 });
    expect(pricing(1000, 2500, 0.28).suggestedPriceCents).toBe(3572);
  });
});

describe('bomRequirement (what confirmation deducts)', () => {
  const recipes = {
    salad: [{ itemId: 'tomato', qty: 150 }, { itemId: 'orange', qty: 1 }],
    juice: [{ itemId: 'orange', qty: 3 }],
  };
  it('multiplies each recipe line by the quantity and sums shared items', () => {
    const r = bomRequirement([{ variantId: 'salad', quantity: 2 }, { variantId: 'juice', quantity: 1 }], recipes);
    expect(Object.fromEntries(r)).toEqual({ tomato: 300, orange: 5 });
  });
  it('ignores variants without a recipe and non-positive quantities', () => {
    const r = bomRequirement([{ variantId: 'bread', quantity: 4 }, { variantId: 'salad', quantity: 0 }], recipes);
    expect(r.size).toBe(0);
  });
  it('handles fractional portions without float noise', () => {
    const r = bomRequirement([{ variantId: 'juice', quantity: 0.1 }, { variantId: 'juice', quantity: 0.2 }], recipes);
    expect(r.get('orange')).toBe(0.9);
  });
});

describe('suggestedReorder (the automatic purchase rule)', () => {
  it('refills to twice the minimum when no reorder quantity is set', () => {
    expect(suggestedReorder({ onHand: 4750, minQty: 6000, reorderQty: null })).toBe(7250);
  });
  it('uses the reorder quantity when set', () => {
    expect(suggestedReorder({ onHand: 50, minQty: 100, reorderQty: 200 })).toBe(200);
  });
  it('orders at exactly the minimum, not above it', () => {
    expect(suggestedReorder({ onHand: 100, minQty: 100, reorderQty: 200 })).toBe(200);
    expect(suggestedReorder({ onHand: 101, minQty: 100, reorderQty: 200 })).toBe(0);
  });
  it('does not order what open purchase orders already bring', () => {
    expect(suggestedReorder({ onHand: 50, minQty: 100, reorderQty: 200, openPoQty: 200 })).toBe(0);
    expect(suggestedReorder({ onHand: 20, minQty: 100, reorderQty: null, openPoQty: 30 })).toBe(150);
  });
  it('orders nothing for a zero minimum with nothing on hand', () => {
    expect(suggestedReorder({ onHand: 0, minQty: 0, reorderQty: null })).toBe(0);
  });
});

describe('classifyMenu (Kasavana & Smith)', () => {
  const base = (variantId: string, qtySold: number, price: number, cost: number) =>
    ({ variantId, name: variantId, qtySold, revenueCents: qtySold * price, unitCostCents: cost, hasRecipe: true });

  it('places each item in its quadrant', () => {
    const r = classifyMenu([
      base('star', 100, 5000, 1500),      // popular, margin 3500
      base('plowhorse', 120, 3000, 2000), // popular, margin 1000
      base('puzzle', 10, 8000, 2000),     // unpopular, margin 6000
      base('dog', 5, 2500, 2000),         // unpopular, margin 500
    ]);
    const q = Object.fromEntries(r.items.map((i) => [i.variantId, i.quadrant]));
    expect(q).toEqual({ star: 'star', plowhorse: 'plowhorse', puzzle: 'puzzle', dog: 'dog' });
    expect(r.popularityThreshold).toBeCloseTo(0.7 / 4);
    expect(r.totalUnits).toBe(235);
    // Weighted average margin = Σ margin × units / Σ units.
    expect(r.avgMarginCents).toBeCloseTo((100 * 3500 + 120 * 1000 + 10 * 6000 + 5 * 500) / 235);
  });

  it('uses the average selling price, so discounts on price lower the margin', () => {
    const r = classifyMenu([{ variantId: 'a', name: 'a', qtySold: 4, revenueCents: 10000, unitCostCents: 1000, hasRecipe: true }]);
    expect(r.items[0]!.avgPriceCents).toBe(2500);
    expect(r.items[0]!.unitMarginCents).toBe(1500);
  });

  it('a single item is its own average: popular and profitable', () => {
    expect(classifyMenu([base('only', 3, 1000, 400)]).items[0]!.quadrant).toBe('star');
  });

  it('leaves out items that did not sell and copes with an empty menu', () => {
    expect(classifyMenu([base('x', 0, 1000, 100)]).items).toEqual([]);
    expect(classifyMenu([]).avgMarginCents).toBe(0);
  });
});
