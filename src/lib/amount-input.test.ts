import { describe, expect, it } from 'vitest';
import { fromCents, toCents } from './amount-input';

describe('toCents', () => {
  it('parses amounts', () => {
    expect(toCents('12.5')).toBe(1250);
    expect(toCents('1,200')).toBe(120000);
    expect(toCents('0.05')).toBe(5);
  });
  it('rejects junk and, unless allowed, negatives', () => {
    expect(toCents('')).toBeNull();
    expect(toCents('1.234')).toBeNull();
    expect(toCents('abc')).toBeNull();
    expect(toCents('-5')).toBeNull();
    expect(toCents('-5', { allowNegative: true })).toBe(-500);
  });
  it('round-trips', () => { expect(toCents(fromCents(4321))).toBe(4321); });
});
