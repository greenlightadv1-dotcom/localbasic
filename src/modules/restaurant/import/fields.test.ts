import { describe, expect, it } from 'vitest';
import {
  FIELD_LABELS,
  IMPORT_FIELDS,
  REQUIRED_FIELDS,
  parsePrice,
  suggestMapping,
  validateRow,
  type ImportField,
} from './fields';

function cells(over: Partial<Record<ImportField, string>> = {}) {
  const base = {} as Record<ImportField, string>;
  for (const f of IMPORT_FIELDS) base[f] = '';
  return { ...base, name: 'لاتيه', price: '65', ...over };
}

describe('column detection', () => {
  it('maps English headers', () => {
    const m = suggestMapping(['Name', 'Description', 'Price', 'Category']);
    expect(m).toEqual({ name: 0, description: 1, price: 2, category: 3 });
  });

  it('maps Arabic headers', () => {
    const m = suggestMapping(['الاسم', 'الوصف', 'السعر', 'التصنيف']);
    expect(m).toEqual({ name: 0, description: 1, price: 2, category: 3 });
  });

  it('ignores column order entirely', () => {
    const m = suggestMapping(['السعر', 'التصنيف', 'الاسم']);
    expect(m.price).toBe(0);
    expect(m.category).toBe(1);
    expect(m.name).toBe(2);
  });

  it('tolerates spacing, case, punctuation and Arabic spelling variants', () => {
    expect(suggestMapping(['  PRICE  ']).price).toBe(0);
    expect(suggestMapping(['sort_order']).sort_order).toBe(0);
    // إسم with hamza, and ة vs ه.
    expect(suggestMapping(['إسم الصنف']).name).toBe(0);
    expect(suggestMapping(['الفئه']).category).toBe(0);
  });

  it('never assigns one column to two fields', () => {
    const m = suggestMapping(['name', 'product name']);
    const used = Object.values(m);
    expect(new Set(used).size).toBe(used.length);
  });

  it('leaves an unrecognised column unmapped', () => {
    const m = suggestMapping(['الاسم', 'شيء غير معروف']);
    expect(m.name).toBe(0);
    expect(Object.values(m)).not.toContain(1);
  });

  it('labels every field, so no dropdown can render undefined', () => {
    for (const f of IMPORT_FIELDS) expect(FIELD_LABELS[f]).toBeTruthy();
  });
});

describe('prices', () => {
  it('reads plain and decimal values as minor units', () => {
    expect(parsePrice('65')).toBe(6500);
    expect(parsePrice('65.5')).toBe(6550);
    expect(parsePrice('1,250')).toBe(125000);
  });

  it('reads Arabic-Indic digits and separators', () => {
    expect(parsePrice('٦٥')).toBe(6500);
    expect(parsePrice('٦٥٫٥')).toBe(6550);
  });

  it('ignores currency text around the number', () => {
    expect(parsePrice('65 EGP')).toBe(6500);
    expect(parsePrice('ج.م ٦٥')).toBe(6500);
  });

  it('refuses a negative, an absurd or an unreadable price', () => {
    expect(parsePrice('-5')).toBeNull();
    expect(parsePrice('999999999')).toBeNull();
    expect(parsePrice('مجانًا')).toBeNull();
    expect(parsePrice('')).toBeNull();
  });
});

describe('row validation', () => {
  it('accepts a minimal valid row', () => {
    const r = validateRow(cells());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.values.name).toBe('لاتيه');
    expect(r.values.priceCents).toBe(6500);
  });

  it('requires exactly the required fields', () => {
    expect(REQUIRED_FIELDS).toEqual(['name', 'price']);
    const noName = validateRow(cells({ name: '  ' }));
    expect(noName.ok).toBe(false);
    if (!noName.ok) expect(noName.issues[0]!.field).toBe('name');

    const noPrice = validateRow(cells({ price: '' }));
    expect(noPrice.ok).toBe(false);
    if (!noPrice.ok) expect(noPrice.issues[0]!.field).toBe('price');
  });

  it('reports every problem at once rather than the first', () => {
    const r = validateRow(cells({ name: '', price: 'x', prep_minutes: '999' }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.map((i) => i.field).sort()).toEqual(['name', 'prep_minutes', 'price']);
  });

  it('refuses a non-https image and accepts an https one', () => {
    for (const bad of ['http://x/i.png', 'javascript:alert(1)', 'data:image/png;base64,AA']) {
      expect(validateRow(cells({ image_url: bad })).ok).toBe(false);
    }
    expect(validateRow(cells({ image_url: 'https://x/i.png' })).ok).toBe(true);
  });

  it('never coerces a bad price to zero', () => {
    const r = validateRow(cells({ price: 'مجانًا' }));
    expect(r.ok).toBe(false);
  });

  it('normalises blanks to null rather than empty strings', () => {
    const r = validateRow(cells());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.values.description).toBeNull();
    expect(r.values.category).toBeNull();
    expect(r.values.imageUrl).toBeNull();
    expect(r.values.sortOrder).toBeNull();
    expect(r.values.prepMinutes).toBeNull();
  });

  it('bounds preparation time to what the column accepts', () => {
    expect(validateRow(cells({ prep_minutes: '600' })).ok).toBe(true);
    expect(validateRow(cells({ prep_minutes: '601' })).ok).toBe(false);
  });
});
