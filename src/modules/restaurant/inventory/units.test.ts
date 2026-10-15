import { describe, expect, it } from 'vitest';
import { costPerPurchaseUnit, costToBase, formatQty, toBase, unitFactor } from './units';

// ar-EG prefixes negatives with U+061C (Arabic letter mark) for RTL; strip it to compare.
const ALM = String.fromCharCode(0x61c);
const latin = (s: string) => s.split(ALM).join('').replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/٫/g, '.').replace(/٬/g, ',');

describe('inventory units', () => {
  it('converts what people type into base units', () => {
    expect(toBase(2.5, 'g', 'kg')).toBe(2500);
    expect(toBase(150, 'g', 'g')).toBe(150);
    expect(toBase(1.25, 'ml', 'l')).toBe(1250);
    expect(toBase(3, 'pc', 'pc')).toBe(3);
    expect(toBase(0.0004, 'g', 'kg')).toBe(0.4);
  });

  it('refuses a unit from another dimension', () => {
    expect(() => unitFactor('g', 'l')).toThrow();
    expect(() => unitFactor('pc', 'kg')).toThrow();
  });

  it('shows large quantities in kg / L and keeps the sign', () => {
    expect(latin(formatQty(1500, 'g'))).toBe('1.5 كجم');
    expect(latin(formatQty(150, 'g'))).toBe('150 جرام');
    expect(latin(formatQty(2000, 'ml'))).toBe('2 لتر');
    expect(latin(formatQty(-1300, 'g'))).toBe('-1.3 كجم');
    expect(latin(formatQty(4, 'pc'))).toBe('4 قطعة');
  });

  it('converts costs between base units and purchase units', () => {
    expect(costPerPurchaseUnit(0.5, 'g')).toBe(500);      // 0.5 cents/g = 5 EGP/kg
    expect(costPerPurchaseUnit(300, 'pc')).toBe(300);
    expect(costToBase(5000, 'g', 'kg')).toBe(5);          // 50 EGP/kg = 5 cents/g
    expect(costToBase(300, 'pc', 'pc')).toBe(300);
  });
});
