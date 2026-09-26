import { z } from 'zod';

/**
 * What a menu import can actually write.
 *
 * Derived from the SCHEMA, not from what a spreadsheet might plausibly hold.
 * restaurant_products has name, description, image_url, sort_order,
 * prep_minutes and a category; restaurant_variants holds the price. Those are
 * the fields, and no speculative column was added to make a wider spreadsheet
 * fit.
 *
 * DELIBERATELY UNSUPPORTED, and why:
 *
 *   sku / external_id  There is no such column on restaurant_products. This is
 *                      the reason the importer creates rather than updates —
 *                      see matching, below.
 *   name_ar / name_en  The catalog stores ONE name. Splitting it is a schema
 *                      change with consequences for every screen that reads a
 *                      product, not an import concern.
 *   is_available       Availability is per BRANCH, in
 *                      restaurant_branch_availability. An organization-scoped
 *                      import has no branch to write it against. `is_active`
 *                      on the product is the nearest thing and is left at its
 *                      default rather than guessed at.
 */

export const IMPORT_FIELDS = [
  'name',
  'description',
  'price',
  'category',
  'image_url',
  'sort_order',
  'prep_minutes',
  'station',
  'best_seller',
] as const;

export type ImportField = (typeof IMPORT_FIELDS)[number];

export const REQUIRED_FIELDS: ImportField[] = ['name', 'price'];

export const FIELD_LABELS: Record<ImportField, string> = {
  name: 'اسم الصنف',
  description: 'الوصف',
  price: 'السعر',
  category: 'التصنيف',
  image_url: 'رابط الصورة',
  sort_order: 'الترتيب',
  prep_minutes: 'زمن التحضير (دقائق)',
  station: 'مطبخ / بار',
  best_seller: 'الأكثر مبيعًا',
};

/**
 * Header names seen in the wild, Arabic and English, for auto-detection.
 *
 * Only a suggestion: the admin confirms every mapping before anything is read,
 * so a wrong guess costs a dropdown change rather than a bad import. Column
 * ORDER is never used — a sheet with the price first maps exactly as well.
 */
const ALIASES: Record<ImportField, string[]> = {
  name: ['name', 'product', 'item', 'title', 'product name', 'item name',
         'الاسم', 'اسم', 'اسم الصنف', 'الصنف', 'المنتج', 'اسم المنتج', 'الوجبة'],
  description: ['description', 'desc', 'details', 'notes',
                'الوصف', 'وصف', 'التفاصيل', 'ملاحظات'],
  price: ['price', 'cost', 'amount', 'unit price', 'selling price',
          'السعر', 'سعر', 'التكلفة', 'سعر البيع', 'الثمن'],
  category: ['category', 'group', 'section', 'type',
             'التصنيف', 'تصنيف', 'الفئة', 'فئة', 'القسم', 'المجموعة'],
  image_url: ['image', 'image url', 'photo', 'picture', 'img',
              'الصورة', 'صورة', 'رابط الصورة'],
  sort_order: ['sort', 'order', 'sort order', 'position',
               'الترتيب', 'ترتيب', 'الموضع'],
  prep_minutes: ['prep', 'prep time', 'preparation', 'preparation time', 'minutes',
                 'زمن التحضير', 'مدة التحضير', 'التحضير', 'دقائق'],
  station: ['station', 'kitchen/bar', 'kitchen or bar', 'route', 'routing',
            'مطبخ او بار', 'مطبخ/بار', 'المحطة', 'التوجيه'],
  best_seller: ['best seller', 'bestseller', 'best_seller', 'featured', 'popular',
                'الأكثر مبيعا', 'الأكثر مبيعًا', 'مميز', 'مميّز'],
};

/** Case- and punctuation-insensitive, and tolerant of Arabic diacritics. */
function normalise(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[ً-ٰٟ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[_\-./\\()[\]]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A first guess at which column is which.
 *
 * Returns a map of field → column index. A column matched to one field is not
 * offered to another, so two headers that both look like a name do not both
 * become the name.
 */
export function suggestMapping(headers: string[]): Partial<Record<ImportField, number>> {
  const normalised = headers.map(normalise);
  const taken = new Set<number>();
  const out: Partial<Record<ImportField, number>> = {};

  // Exact alias matches first, so 'price' wins over a column merely containing
  // the word.
  for (const pass of ['exact', 'partial'] as const) {
    for (const field of IMPORT_FIELDS) {
      if (out[field] !== undefined) continue;
      const aliases = ALIASES[field].map(normalise);

      const index = normalised.findIndex((header, i) => {
        if (taken.has(i) || header === '') return false;
        return pass === 'exact'
          ? aliases.includes(header)
          : aliases.some((a) => header.includes(a) || a.includes(header));
      });

      if (index !== -1) {
        out[field] = index;
        taken.add(index);
      }
    }
  }

  return out;
}

/**
 * Money, from whatever a spreadsheet put in the cell.
 *
 * Accepts Arabic-Indic digits, a comma or an Arabic decimal separator, and
 * stray currency text, because all three are what real sheets contain. Returns
 * MINOR UNITS, because that is what the column stores — never a float.
 */
export function parsePrice(raw: string): number | null {
  const western = raw
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, '.')
    .replace(/٬/g, '')
    .replace(/,/g, '');

  const match = /-?\d+(\.\d+)?/.exec(western);
  if (!match) return null;

  const value = Number(match[0]);
  if (!Number.isFinite(value)) return null;

  const cents = Math.round(value * 100);
  // Negative prices and absurd ones are rejected rather than clamped: a
  // spreadsheet that says -5 is wrong, and quietly storing 0 hides it.
  if (cents < 0 || cents > 100_000_000) return null;
  return cents;
}

function parseWholeNumber(raw: string, max: number): number | null {
  const western = raw.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
  const match = /-?\d+/.exec(western);
  if (!match) return null;
  const value = Number(match[0]);
  if (!Number.isInteger(value) || value < 0 || value > max) return null;
  return value;
}

/** https only, matching the rule the restaurant website already applies. */
const imageUrl = z
  .string()
  .trim()
  .max(500)
  .refine((v) => v === '' || /^https:\/\/[^\s<>"]+$/.test(v), {
    message: 'رابط الصورة يجب أن يبدأ بـ https://',
  });

export type ImportRowValues = {
  name: string;
  description: string | null;
  priceCents: number;
  category: string | null;
  imageUrl: string | null;
  sortOrder: number | null;
  prepMinutes: number | null;
  /** null = leave the category's own default alone (see commitImport). */
  stationKind: 'kitchen' | 'bar' | null;
  bestSeller: boolean;
};

const TRUE_WORDS = new Set(['1', 'true', 'yes', 'y', 'نعم', 'صح', 'أيوه', 'ايوه']);
const KITCHEN_WORDS = new Set(['kitchen', 'مطبخ']);
const BAR_WORDS = new Set(['bar', 'بار']);

export type RowIssue = { field: ImportField | 'row'; message: string };

/**
 * Validates one spreadsheet row against the catalog's own rules.
 *
 * Returns either the values a writer can use or the reasons it cannot. Nothing
 * is coerced silently: a price that cannot be read is an error on that row, not
 * a zero.
 */
export function validateRow(
  cells: Record<ImportField, string>,
): { ok: true; values: ImportRowValues } | { ok: false; issues: RowIssue[] } {
  const issues: RowIssue[] = [];

  const name = cells.name.trim();
  if (name === '') issues.push({ field: 'name', message: 'الاسم مطلوب' });
  else if (name.length > 200) issues.push({ field: 'name', message: 'الاسم طويل جدًا' });

  const priceRaw = cells.price.trim();
  let priceCents: number | null = null;
  if (priceRaw === '') {
    issues.push({ field: 'price', message: 'السعر مطلوب' });
  } else {
    priceCents = parsePrice(priceRaw);
    if (priceCents === null) issues.push({ field: 'price', message: 'السعر غير صالح' });
  }

  const description = cells.description.trim();

  const imageRaw = cells.image_url.trim();
  const image = imageUrl.safeParse(imageRaw);
  if (!image.success) {
    issues.push({ field: 'image_url', message: image.error.issues[0]!.message });
  }

  const sortRaw = cells.sort_order.trim();
  let sortOrder: number | null = null;
  if (sortRaw !== '') {
    sortOrder = parseWholeNumber(sortRaw, 100_000);
    if (sortOrder === null) issues.push({ field: 'sort_order', message: 'الترتيب غير صالح' });
  }

  const prepRaw = cells.prep_minutes.trim();
  let prepMinutes: number | null = null;
  if (prepRaw !== '') {
    prepMinutes = parseWholeNumber(prepRaw, 600);
    if (prepMinutes === null) {
      issues.push({ field: 'prep_minutes', message: 'زمن التحضير يجب أن يكون بين ٠ و٦٠٠ دقيقة' });
    }
  }

  const category = cells.category.trim();
  if (category.length > 120) {
    issues.push({ field: 'category', message: 'اسم التصنيف طويل جدًا' });
  }

  const stationRaw = normalise(cells.station.trim());
  let stationKind: 'kitchen' | 'bar' | null = null;
  if (stationRaw !== '') {
    if (KITCHEN_WORDS.has(stationRaw)) stationKind = 'kitchen';
    else if (BAR_WORDS.has(stationRaw)) stationKind = 'bar';
    else issues.push({ field: 'station', message: 'القيمة يجب أن تكون "مطبخ" أو "بار"' });
  }

  const bestSeller = TRUE_WORDS.has(normalise(cells.best_seller.trim()));

  if (issues.length) return { ok: false, issues };

  return {
    ok: true,
    values: {
      name,
      description: description === '' ? null : description.slice(0, 2000),
      priceCents: priceCents!,
      category: category === '' ? null : category,
      imageUrl: imageRaw === '' ? null : imageRaw,
      sortOrder,
      prepMinutes,
      stationKind,
      bestSeller,
    },
  };
}
