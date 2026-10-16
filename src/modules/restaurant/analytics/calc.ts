/**
 * Executive analytics — the pure arithmetic, client-safe and unit-tested.
 * The database (0110) aggregates the raw facts; scoring, segmentation and
 * the derived ratios live here, once, so the dashboard and the tests agree.
 */

// ---------------------------------------------------------------------------
// RFM
// ---------------------------------------------------------------------------
export type RfmInput = {
  phoneKey: string; phone: string; name: string | null; lastOrderAt: string; firstOrderAt: string;
  orders: number; monetaryCents: number; deliveryOrders: number; lastContactedAt: string | null;
};
export type Segment = 'vip' | 'loyal' | 'active' | 'new' | 'at_risk' | 'lapsed';
export type RfmCustomer = RfmInput & { recencyDays: number; r: number; f: number; m: number; segment: Segment };

export const SEGMENT_LABELS: Record<Segment, { title: string; hint: string }> = {
  vip:     { title: 'كبار العملاء',  hint: 'يطلبون كثيرًا وينفقون أكثر، وطلبوا مؤخرًا.' },
  loyal:   { title: 'أوفياء',        hint: 'يطلبون كثيرًا وما زالوا نشطين.' },
  active:  { title: 'نشطون',         hint: 'طلبوا مؤخرًا.' },
  new:     { title: 'جدد',           hint: 'طلب واحد مؤخرًا: الطلب الثاني هو الأهم.' },
  at_risk: { title: 'معرضون للفقد',  hint: 'لم يطلبوا منذ فترة الانقطاع: وقت رسالة استرجاع.' },
  lapsed:  { title: 'منقطعون',       hint: 'غابوا طويلًا (3 أضعاف فترة الانقطاع).' },
};
export const SEGMENT_ORDER: Segment[] = ['vip', 'loyal', 'active', 'new', 'at_risk', 'lapsed'];

/**
 * 1–5 by rank among all customers (ties share a score). Higher values score
 * higher unless `lowerIsBetter` (recency: fewer days is better).
 */
export function quintileScores(values: number[], lowerIsBetter = false): number[] {
  const n = values.length;
  if (n === 0) return [];
  return values.map((v) => {
    const atOrWorse = values.filter((x) => (lowerIsBetter ? x >= v : x <= v)).length;
    return Math.min(5, Math.max(1, Math.ceil((atOrWorse / n) * 5)));
  });
}

const DAY = 86_400_000;

/**
 * Segments, first match wins:
 *   lapsed   no order for 3 × lapseDays or more
 *   at_risk  no order for lapseDays or more
 *   vip      frequency and monetary both in the top two quintiles (4–5)
 *   new      exactly one order
 *   loyal    frequency in the top two quintiles
 *   active   everyone else who ordered recently
 * The automatic re-engagement in 0110 targets at_risk and lapsed customers
 * with two or more orders — the same lapseDays.
 */
export function segmentCustomer(c: { recencyDays: number; orders: number; f: number; m: number }, lapseDays: number): Segment {
  if (c.recencyDays >= lapseDays * 3) return 'lapsed';
  if (c.recencyDays >= lapseDays) return 'at_risk';
  if (c.f >= 4 && c.m >= 4 && c.orders >= 2) return 'vip';
  if (c.orders <= 1) return 'new';
  if (c.f >= 4) return 'loyal';
  return 'active';
}

export function scoreRfm(rows: RfmInput[], opts: { asOf: Date; lapseDays: number }): RfmCustomer[] {
  const recency = rows.map((r) => Math.max(0, Math.floor((opts.asOf.getTime() - new Date(r.lastOrderAt).getTime()) / DAY)));
  const rs = quintileScores(recency, true);
  const fs = quintileScores(rows.map((r) => r.orders));
  const ms = quintileScores(rows.map((r) => r.monetaryCents));
  return rows.map((row, i) => {
    const c = { ...row, recencyDays: recency[i]!, r: rs[i]!, f: fs[i]!, m: ms[i]! };
    return { ...c, segment: segmentCustomer(c, opts.lapseDays) };
  });
}

export function summarizeSegments(customers: RfmCustomer[]) {
  return SEGMENT_ORDER.map((segment) => {
    const list = customers.filter((c) => c.segment === segment);
    const monetaryCents = list.reduce((s, c) => s + c.monetaryCents, 0);
    return {
      segment, count: list.length, monetaryCents,
      avgOrders: list.length ? list.reduce((s, c) => s + c.orders, 0) / list.length : 0,
      avgRecencyDays: list.length ? list.reduce((s, c) => s + c.recencyDays, 0) / list.length : 0,
      share: customers.length ? list.length / customers.length : 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Market basket
// ---------------------------------------------------------------------------
export type BasketPair = {
  aId: string; aName: string; bId: string; bName: string; together: number; aOrders: number; bOrders: number;
  totalOrders: number; support: number; confAB: number; confBA: number; lift: number;
};

/** The reference computation the SQL function mirrors (support, confidence, lift). */
export function basketPairs(baskets: string[][], minTogether = 2): Omit<BasketPair, 'aName' | 'bName'>[] {
  const sets = baskets.map((b) => [...new Set(b)].sort());
  const total = sets.length;
  const single = new Map<string, number>();
  const pairs = new Map<string, number>();
  for (const s of sets) {
    for (const x of s) single.set(x, (single.get(x) ?? 0) + 1);
    for (let i = 0; i < s.length; i++) for (let j = i + 1; j < s.length; j++) {
      const k = `${s[i]}\u0000${s[j]}`;
      pairs.set(k, (pairs.get(k) ?? 0) + 1);
    }
  }
  return [...pairs.entries()].filter(([, n]) => n >= minTogether).map(([k, n]) => {
    const [a, b] = k.split('\u0000') as [string, string];
    const na = single.get(a)!; const nb = single.get(b)!;
    return { aId: a, bId: b, together: n, aOrders: na, bOrders: nb, totalOrders: total,
             support: n / total, confAB: n / na, confBA: n / nb, lift: (n * total) / (na * nb) };
  }).sort((x, y) => y.lift - x.lift || y.together - x.together);
}

export type CrossSell = { forId: string; forName: string; suggestId: string; suggestName: string; confidence: number; lift: number; together: number };

/**
 * One suggestion per item: when a guest orders X, offer the partner most
 * likely to be added (highest confidence X→Y), among pairs that really go
 * together (lift above 1) and were seen together often enough.
 */
export function crossSellSuggestions(pairs: BasketPair[], opts: { minLift?: number; minConfidence?: number } = {}): CrossSell[] {
  const minLift = opts.minLift ?? 1.1; const minConf = opts.minConfidence ?? 0.15;
  const best = new Map<string, CrossSell>();
  for (const p of pairs) {
    if (p.lift < minLift) continue;
    for (const [forId, forName, suggestId, suggestName, confidence] of [
      [p.aId, p.aName, p.bId, p.bName, p.confAB], [p.bId, p.bName, p.aId, p.aName, p.confBA],
    ] as const) {
      if (confidence < minConf) continue;
      const cur = best.get(forId);
      if (!cur || confidence > cur.confidence || (confidence === cur.confidence && p.lift > cur.lift)) {
        best.set(forId, { forId, forName, suggestId, suggestName, confidence, lift: p.lift, together: p.together });
      }
    }
  }
  return [...best.values()].sort((a, b) => b.confidence * b.together - a.confidence * a.together);
}

// ---------------------------------------------------------------------------
// Speed of service
// ---------------------------------------------------------------------------
export type SosStage = 'accept' | 'queue' | 'cook' | 'handoff' | 'delivery' | 'total';
export const SOS_STAGE_LABELS: Record<SosStage, string> = {
  accept: 'قبول الطلب', queue: 'انتظار المطبخ', cook: 'التحضير', handoff: 'التسليم / الخروج', delivery: 'التوصيل', total: 'الإجمالي',
};
export type SosRow = { type: string; stage: SosStage; n: number; avgS: number; p50S: number; p90S: number };

/** The slowest stage (by p90) of an order type, and its share of the time to done. */
export function sosBottleneck(rows: SosRow[], type: string): { stage: SosStage; p90S: number; share: number } | null {
  const own = rows.filter((r) => r.type === type && r.stage !== 'total' && r.n > 0);
  if (!own.length) return null;
  const worst = own.reduce((a, b) => (b.p90S > a.p90S ? b : a));
  const sum = own.reduce((s, r) => s + r.avgS, 0);
  return { stage: worst.stage, p90S: worst.p90S, share: sum > 0 ? worst.avgS / sum : 0 };
}

/** 75 → "1:15", 3725 → "1:02:05". */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

// ---------------------------------------------------------------------------
// Executive KPIs
// ---------------------------------------------------------------------------
export type RawKpis = {
  orders: number; netRevenueCents: number; cogsCents: number; wasteCents: number; wasteManualCents: number;
  laborCents: number; opexCents: number; inventoryNowCents: number; inventoryStartCents: number; days: number;
};

/**
 * Gross profit = net revenue − ingredients consumed (COGS).
 * Net profit   = gross − manual waste (stock lost outside an order) − labour − other operating costs.
 * Inventory turnover = COGS ÷ average inventory value; days on hand = average ÷ daily COGS.
 */
export function deriveKpis(k: RawKpis) {
  const grossProfitCents = k.netRevenueCents - k.cogsCents;
  const netProfitCents = grossProfitCents - k.wasteManualCents - k.laborCents - k.opexCents;
  const avgInventory = (k.inventoryNowCents + k.inventoryStartCents) / 2;
  const dailyCogs = k.days > 0 ? k.cogsCents / k.days : 0;
  const ratio = (a: number, b: number) => (b > 0 ? a / b : null);
  return {
    grossProfitCents, netProfitCents,
    avgTicketCents: k.orders ? k.netRevenueCents / k.orders : 0,
    foodCostRatio: ratio(k.cogsCents, k.netRevenueCents),
    laborRatio: ratio(k.laborCents, k.netRevenueCents),
    netMargin: ratio(netProfitCents, k.netRevenueCents),
    wasteOfSales: ratio(k.wasteCents, k.netRevenueCents),
    wasteOfFoodCost: ratio(k.wasteCents, k.cogsCents + k.wasteManualCents),
    inventoryTurnover: ratio(k.cogsCents, avgInventory),
    daysOnHand: dailyCogs > 0 ? avgInventory / dailyCogs : null,
  };
}

/** Margin of a dish at a cost, as a fraction of its price. */
export const marginAt = (priceCents: number, costCents: number) => (priceCents > 0 ? (priceCents - costCents) / priceCents : null);

// ---------------------------------------------------------------------------
// Click-to-chat (works today, with no SMS/WhatsApp provider configured)
// ---------------------------------------------------------------------------
/** "010 1234 5678", "+20 10…" or "0020…" → international digits for wa.me ("201012345678"); null when not a usable number. */
export function toWhatsAppNumber(phone: string, defaultCountry = '20'): string | null {
  let d = phone.replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('0')) d = defaultCountry + d.slice(1);
  return d.length >= 10 && d.length <= 15 ? d : null;
}

export function whatsAppLink(phone: string, text: string): string | null {
  const n = toWhatsAppNumber(phone);
  return n ? `https://wa.me/${n}?text=${encodeURIComponent(text)}` : null;
}

/** A segment as CSV (Excel-safe UTF-8 BOM), for an SMS gateway or a call list. */
export function segmentCsv(rows: { name: string | null; phone: string; orders: number; monetaryCents: number; recencyDays: number; segment: string }[]): string {
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = rows.map((r) => [r.name ?? '', r.phone, r.orders, (r.monetaryCents / 100).toFixed(2), r.recencyDays, r.segment].map((v) => esc(String(v))).join(','));
  return '﻿' + ['name,phone,orders,spend,days_since_last_order,segment', ...lines].join('\n');
}
