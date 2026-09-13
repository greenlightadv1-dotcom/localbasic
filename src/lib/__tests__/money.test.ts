import { describe, it, expect } from 'vitest';
import { parseAmountToCents, lineTotalCents, assertCents } from '@/lib/money';

describe('parseAmountToCents', () => {
  it('parses whole and fractional amounts exactly', () => {
    expect(parseAmountToCents('100')).toBe(10000);
    expect(parseAmountToCents('12.5')).toBe(1250);
    expect(parseAmountToCents('12.50')).toBe(1250);
    expect(parseAmountToCents('0.01')).toBe(1);
    expect(parseAmountToCents('-3.20')).toBe(-320);
  });

  it('parses the amounts that float arithmetic gets wrong', () => {
    // 0.1 + 0.2 === 0.30000000000000004 in floating point. Going through
    // integers, these are exact.
    expect(parseAmountToCents('0.10') + parseAmountToCents('0.20')).toBe(30);
    expect(parseAmountToCents('19.99') * 3).toBe(5997);
  });

  it('tolerates thousands separators and surrounding space', () => {
    expect(parseAmountToCents(' 1,234.56 ')).toBe(123456);
  });

  it('rejects anything that is not a plain amount', () => {
    for (const bad of ['abc', '1.234', '', '1.2.3', '1e5', '--5']) {
      expect(() => parseAmountToCents(bad)).toThrow();
    }
  });
});

describe('lineTotalCents', () => {
  it('applies the discount before tax', () => {
    // 2 × 100.00 = 200.00, less 20.00 discount = 180.00, +14% VAT = 205.20
    expect(
      lineTotalCents({ unitPriceCents: 10000, quantity: 2, discountCents: 2000, taxRateBp: 1400 }),
    ).toEqual({ netCents: 18000, taxCents: 2520, totalCents: 20520 });
  });

  it('handles fractional quantities with a single rounding', () => {
    // 1.5 kg at 33.33 → 49.995, rounded once to 50.00
    expect(lineTotalCents({ unitPriceCents: 3333, quantity: 1.5 })).toEqual({
      netCents: 5000,
      taxCents: 0,
      totalCents: 5000,
    });
  });

  it('never produces a negative net from an oversized discount', () => {
    expect(
      lineTotalCents({ unitPriceCents: 1000, quantity: 1, discountCents: 99999 }).netCents,
    ).toBe(0);
  });

  it('returns integers for every field', () => {
    const result = lineTotalCents({ unitPriceCents: 999, quantity: 7, taxRateBp: 1400 });
    expect(Number.isInteger(result.netCents)).toBe(true);
    expect(Number.isInteger(result.taxCents)).toBe(true);
    expect(Number.isInteger(result.totalCents)).toBe(true);
  });
});

describe('assertCents', () => {
  it('rejects a non-integer amount, which is how float money leaks in', () => {
    expect(() => assertCents(10.5)).toThrow();
    expect(assertCents(1050)).toBe(1050);
  });
});
