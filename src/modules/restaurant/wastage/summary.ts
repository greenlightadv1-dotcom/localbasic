import type { BaseUnit } from '@/modules/restaurant/inventory/units';

/** Wastage totals: by reason, and the costliest items. Pure; client-safe. */
export type WastageSummary = {
  totalCents: number;
  byReason: { reason: string; costCents: number; count: number }[];
  topItems: { itemId: string; name: string; costCents: number; qty: number; unit: BaseUnit }[];
};

/** Totals by reason and the costliest items. */
export function summarizeWastage(entries: { reason: string; costCents: number; itemId: string; itemName: string; qty: number; unit: BaseUnit }[]): WastageSummary {
  const reasons = new Map<string, { costCents: number; count: number }>();
  const items = new Map<string, { itemId: string; name: string; costCents: number; qty: number; unit: BaseUnit }>();
  let totalCents = 0;
  for (const e of entries) {
    totalCents += e.costCents;
    const r = reasons.get(e.reason) ?? { costCents: 0, count: 0 };
    r.costCents += e.costCents; r.count += 1; reasons.set(e.reason, r);
    const it = items.get(e.itemId) ?? { itemId: e.itemId, name: e.itemName, costCents: 0, qty: 0, unit: e.unit };
    it.costCents += e.costCents; it.qty += e.qty; items.set(e.itemId, it);
  }
  return {
    totalCents,
    byReason: [...reasons.entries()].map(([reason, v]) => ({ reason, ...v })).sort((a, b) => b.costCents - a.costCents),
    topItems: [...items.values()].sort((a, b) => b.costCents - a.costCents).slice(0, 5),
  };
}
