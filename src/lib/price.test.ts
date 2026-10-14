import { describe, expect, it } from 'vitest';
import { formatPrice } from './price';

describe('formatPrice', () => {
  it('drops trailing zeros on whole amounts', () => {
    expect(formatPrice(10500, 'EGP')).toBe('105 EGP');
    expect(formatPrice(0, 'EGP')).toBe('0 EGP');
  });
  it('keeps two decimals otherwise', () => {
    expect(formatPrice(10550, 'EGP')).toBe('105.50 EGP');
    expect(formatPrice(5, 'EGP')).toBe('0.05 EGP');
    expect(formatPrice(9990, 'SAR')).toBe('99.90 SAR');
  });
  it('does not group thousands', () => {
    expect(formatPrice(1234500, 'EGP')).toBe('12345 EGP');
  });
});
