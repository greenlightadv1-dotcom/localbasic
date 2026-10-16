import { describe, expect, it } from 'vitest';
import {
  basketPairs, crossSellSuggestions, deriveKpis, formatDuration, marginAt, quintileScores, scoreRfm, segmentCustomer,
  sosBottleneck, summarizeSegments, type BasketPair, type RfmInput, type SosRow,
} from './calc';

const asOf = new Date('2026-10-16T12:00:00Z');
const daysAgo = (d: number) => new Date(asOf.getTime() - d * 86_400_000).toISOString();
const cust = (key: string, lastDays: number, orders: number, monetary: number): RfmInput => ({
  phoneKey: key, phone: key, name: key, lastOrderAt: daysAgo(lastDays), firstOrderAt: daysAgo(lastDays + 30),
  orders, monetaryCents: monetary, deliveryOrders: 0, lastContactedAt: null,
});

describe('quintileScores', () => {
  it('ranks 1–5, highest values best', () => {
    expect(quintileScores([10, 20, 30, 40, 50])).toEqual([1, 2, 3, 4, 5]);
  });
  it('lower is better for recency', () => {
    expect(quintileScores([1, 5, 10, 30, 90], true)).toEqual([5, 4, 3, 2, 1]);
  });
  it('ties share a score, a single customer is top', () => {
    expect(quintileScores([7, 7, 7])).toEqual([5, 5, 5]);
    expect(quintileScores([3])).toEqual([5]);
    expect(quintileScores([])).toEqual([]);
  });
});

describe('segmentCustomer', () => {
  const lapse = 14;
  it('recency decides first: at risk from the lapse period, lapsed at three times it', () => {
    expect(segmentCustomer({ recencyDays: 14, orders: 9, f: 5, m: 5 }, lapse)).toBe('at_risk');
    expect(segmentCustomer({ recencyDays: 41, orders: 9, f: 5, m: 5 }, lapse)).toBe('at_risk');
    expect(segmentCustomer({ recencyDays: 42, orders: 9, f: 5, m: 5 }, lapse)).toBe('lapsed');
  });
  it('recent customers: vip, new, loyal, active', () => {
    expect(segmentCustomer({ recencyDays: 2, orders: 8, f: 5, m: 4 }, lapse)).toBe('vip');
    expect(segmentCustomer({ recencyDays: 2, orders: 1, f: 5, m: 5 }, lapse)).toBe('new');
    expect(segmentCustomer({ recencyDays: 2, orders: 6, f: 4, m: 2 }, lapse)).toBe('loyal');
    expect(segmentCustomer({ recencyDays: 13, orders: 2, f: 2, m: 3 }, lapse)).toBe('active');
  });
});

describe('scoreRfm', () => {
  const rows = [
    cust('whale', 1, 20, 500_000),
    cust('regular', 5, 6, 90_000),
    cust('newbie', 3, 1, 8_000),
    cust('fading', 20, 5, 60_000),
    cust('gone', 120, 3, 30_000),
  ];
  const scored = scoreRfm(rows, { asOf, lapseDays: 14 });
  const by = Object.fromEntries(scored.map((c) => [c.phoneKey, c]));
  it('computes recency in days and the three scores', () => {
    expect(by.whale!.recencyDays).toBe(1);
    expect([by.whale!.r, by.whale!.f, by.whale!.m]).toEqual([5, 5, 5]);
    expect([by.gone!.r, by.newbie!.f]).toEqual([1, 1]);
  });
  it('assigns segments', () => {
    expect(Object.fromEntries(scored.map((c) => [c.phoneKey, c.segment]))).toEqual({
      whale: 'vip', regular: 'vip', newbie: 'new', fading: 'at_risk', gone: 'lapsed',
    });
  });
  it('summarizes every segment, in display order, with shares that add up', () => {
    const s = summarizeSegments(scored);
    expect(s.map((x) => x.segment)).toEqual(['vip', 'loyal', 'active', 'new', 'at_risk', 'lapsed']);
    expect(s.find((x) => x.segment === 'vip')!.count).toBe(2);
    expect(s.reduce((a, x) => a + x.share, 0)).toBeCloseTo(1);
    expect(s.find((x) => x.segment === 'loyal')!.avgOrders).toBe(0);
  });
});

describe('basketPairs (the SQL formula)', () => {
  // The same four orders as SQL test 42.
  const baskets = [['burger', 'fries'], ['burger', 'fries', 'cola'], ['burger'], ['cola']];
  it('support, confidence and lift', () => {
    const [p] = basketPairs(baskets, 2);
    expect(p).toMatchObject({ aId: 'burger', bId: 'fries', together: 2, aOrders: 3, bOrders: 2, totalOrders: 4 });
    expect(p!.support).toBe(0.5);
    expect(p!.confAB).toBeCloseTo(2 / 3);
    expect(p!.confBA).toBe(1);
    expect(p!.lift).toBeCloseTo((2 * 4) / (3 * 2));
  });
  it('drops pairs seen fewer times than the minimum and ignores duplicates in a basket', () => {
    expect(basketPairs(baskets, 2)).toHaveLength(1);
    expect(basketPairs([['a', 'a', 'b'], ['a', 'b']], 2)[0]!.together).toBe(2);
  });
});

describe('crossSellSuggestions', () => {
  const pair = (a: string, b: string, confAB: number, confBA: number, lift: number, together = 10): BasketPair => ({
    aId: a, aName: a, bId: b, bName: b, together, aOrders: 0, bOrders: 0, totalOrders: 0, support: 0, confAB, confBA, lift,
  });
  it('one best partner per item, by confidence, among pairs with lift', () => {
    const s = crossSellSuggestions([pair('burger', 'fries', 0.6, 0.9, 1.4), pair('burger', 'cola', 0.4, 0.5, 1.2), pair('salad', 'water', 0.9, 0.9, 0.8)]);
    const m = Object.fromEntries(s.map((x) => [x.forId, x.suggestId]));
    expect(m).toEqual({ burger: 'fries', fries: 'burger', cola: 'burger' });
  });
  it('skips weak confidence', () => {
    expect(crossSellSuggestions([pair('a', 'b', 0.05, 0.1, 3)])).toEqual([]);
  });
});

describe('sosBottleneck and formatDuration', () => {
  const rows: SosRow[] = [
    { type: 'delivery', stage: 'accept', n: 10, avgS: 60, p50S: 50, p90S: 120 },
    { type: 'delivery', stage: 'cook', n: 10, avgS: 600, p50S: 540, p90S: 900 },
    { type: 'delivery', stage: 'delivery', n: 10, avgS: 1500, p50S: 1400, p90S: 2400 },
    { type: 'delivery', stage: 'total', n: 10, avgS: 2200, p50S: 2000, p90S: 3300 },
  ];
  it('finds the slowest stage by p90 and its share of the time', () => {
    const b = sosBottleneck(rows, 'delivery')!;
    expect(b.stage).toBe('delivery');
    expect(b.share).toBeCloseTo(1500 / 2160);
    expect(sosBottleneck(rows, 'dine_in')).toBeNull();
  });
  it('formats seconds', () => {
    expect(formatDuration(75)).toBe('1:15');
    expect(formatDuration(3725)).toBe('1:02:05');
    expect(formatDuration(null)).toBe('—');
  });
});

describe('deriveKpis', () => {
  const k = deriveKpis({
    orders: 100, netRevenueCents: 1_000_000, cogsCents: 300_000, wasteCents: 20_000, wasteManualCents: 15_000,
    laborCents: 250_000, opexCents: 100_000, inventoryNowCents: 120_000, inventoryStartCents: 80_000, days: 30,
  });
  it('profit after ingredients, waste, labour and operating costs', () => {
    expect(k.grossProfitCents).toBe(700_000);
    expect(k.netProfitCents).toBe(700_000 - 15_000 - 250_000 - 100_000);
    expect(k.netMargin).toBeCloseTo(0.335);
    expect(k.foodCostRatio).toBeCloseTo(0.3);
    expect(k.laborRatio).toBeCloseTo(0.25);
    expect(k.avgTicketCents).toBe(10_000);
  });
  it('waste ratios and inventory turnover', () => {
    expect(k.wasteOfSales).toBeCloseTo(0.02);
    expect(k.wasteOfFoodCost).toBeCloseTo(20_000 / 315_000);
    expect(k.inventoryTurnover).toBeCloseTo(3);          // 300k ÷ avg 100k
    expect(k.daysOnHand).toBeCloseTo(100_000 / 10_000);  // 10 days
  });
  it('no sales: ratios are absent, not infinite', () => {
    const z = deriveKpis({ orders: 0, netRevenueCents: 0, cogsCents: 0, wasteCents: 0, wasteManualCents: 0, laborCents: 0, opexCents: 0, inventoryNowCents: 0, inventoryStartCents: 0, days: 7 });
    expect([z.foodCostRatio, z.netMargin, z.inventoryTurnover, z.daysOnHand]).toEqual([null, null, null, null]);
  });
  it('marginAt', () => {
    expect(marginAt(5000, 750)).toBeCloseTo(0.85);
    expect(marginAt(0, 10)).toBeNull();
  });
});

describe('click-to-chat and export', () => {
  it('normalizes Egyptian numbers for wa.me', async () => {
    const { toWhatsAppNumber, whatsAppLink } = await import('./calc');
    expect(toWhatsAppNumber('010 1234 5678')).toBe('201012345678');
    expect(toWhatsAppNumber('+20 101 234 5678')).toBe('201012345678');
    expect(toWhatsAppNumber('0020 1012345678')).toBe('201012345678');
    expect(toWhatsAppNumber('123')).toBeNull();
    expect(whatsAppLink('01012345678', 'خصم 10%')).toBe('https://wa.me/201012345678?text=%D8%AE%D8%B5%D9%85%2010%25');
  });
  it('exports CSV with escaping', async () => {
    const { segmentCsv } = await import('./calc');
    const csv = segmentCsv([{ name: 'أحمد, "الكبير"', phone: '010', orders: 3, monetaryCents: 12345, recencyDays: 20, segment: 'at_risk' }]);
    expect(csv.startsWith('﻿name,phone')).toBe(true);
    expect(csv).toContain('"أحمد, ""الكبير""",010,3,123.45,20,at_risk');
  });
});
