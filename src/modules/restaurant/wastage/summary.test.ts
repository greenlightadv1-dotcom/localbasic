import { describe, expect, it } from 'vitest';
import { summarizeWastage } from './summary';

const e = (itemId: string, reason: string, costCents: number, qty = 1) => ({ itemId, itemName: itemId, reason, costCents, qty, unit: 'g' as const });

describe('summarizeWastage', () => {
  it('totals by reason (costliest first) and ranks items', () => {
    const s = summarizeWastage([e('tomato', 'burnt', 400, 200), e('tomato', 'tasting', 100, 50), e('milk', 'spoiled', 900, 500), e('bread', 'burnt', 50)]);
    expect(s.totalCents).toBe(1450);
    expect(s.byReason).toEqual([
      { reason: 'spoiled', costCents: 900, count: 1 },
      { reason: 'burnt', costCents: 450, count: 2 },
      { reason: 'tasting', costCents: 100, count: 1 },
    ]);
    expect(s.topItems.map((i) => [i.itemId, i.costCents, i.qty])).toEqual([['milk', 900, 500], ['tomato', 500, 250], ['bread', 50, 1]]);
  });
  it('keeps the five costliest items and handles nothing', () => {
    const many = Array.from({ length: 8 }, (_, i) => e(`i${i}`, 'dropped', i * 10));
    expect(summarizeWastage(many).topItems.map((i) => i.itemId)).toEqual(['i7', 'i6', 'i5', 'i4', 'i3']);
    expect(summarizeWastage([])).toEqual({ totalCents: 0, byReason: [], topItems: [] });
  });
});
