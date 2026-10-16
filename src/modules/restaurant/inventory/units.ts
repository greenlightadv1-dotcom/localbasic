/**
 * Units for raw materials. The database stores every quantity in the item's
 * BASE unit — grams, millilitres or pieces — so a recipe line of "150" grams
 * and a delivery of "5 kg" are the same kind of number. These helpers are
 * the only place a kilo or a litre exists: screens convert on the way in and
 * on the way out.
 */
export type BaseUnit = 'g' | 'ml' | 'pc';
export type InputUnit = 'g' | 'kg' | 'ml' | 'l' | 'pc';

export const BASE_UNIT_LABELS: Record<BaseUnit, string> = { g: 'جرام', ml: 'مل', pc: 'قطعة' };

export const INPUT_UNITS: Record<BaseUnit, { key: InputUnit; label: string; factor: number }[]> = {
  g: [
    { key: 'kg', label: 'كجم', factor: 1000 },
    { key: 'g', label: 'جرام', factor: 1 },
  ],
  ml: [
    { key: 'l', label: 'لتر', factor: 1000 },
    { key: 'ml', label: 'مل', factor: 1 },
  ],
  pc: [{ key: 'pc', label: 'قطعة', factor: 1 }],
};

export function unitFactor(base: BaseUnit, input: InputUnit): number {
  const u = INPUT_UNITS[base].find((x) => x.key === input);
  if (!u) throw new Error(`unit ${input} does not apply to ${base}`);
  return u.factor;
}

/** "2.5" kg → 2500 g. Rounded to the database's 3 decimal places. */
export function toBase(value: number, base: BaseUnit, input: InputUnit): number {
  return Math.round(value * unitFactor(base, input) * 1000) / 1000;
}

const fmt = (n: number) => n.toLocaleString('ar-EG', { maximumFractionDigits: 3 });

/** 1500 g → "1.5 كجم"; 150 g → "150 جرام"; 4 pc → "4 قطعة". Negative stays negative. */
export function formatQty(qty: number, base: BaseUnit): string {
  if ((base === 'g' || base === 'ml') && Math.abs(qty) >= 1000) {
    return `${fmt(qty / 1000)} ${base === 'g' ? 'كجم' : 'لتر'}`;
  }
  return `${fmt(qty)} ${BASE_UNIT_LABELS[base]}`;
}

/** Cost per base unit (cents) → money per the unit people buy in (cents per kg / L / piece). */
export function costPerPurchaseUnit(centsPerBase: number, base: BaseUnit): number {
  return base === 'pc' ? centsPerBase : centsPerBase * 1000;
}

/** The reverse: "50 EGP per kg" → cents per gram. */
export function costToBase(centsPerUnit: number, base: BaseUnit, input: InputUnit): number {
  return centsPerUnit / unitFactor(base, input);
}

export const LOCATION_LABELS: Record<string, string> = {
  warehouse: 'المخزن',
  kitchen: 'المطبخ',
  bar: 'البار',
  transit: 'في الطريق',
  waste: 'الهالك',
};

export const WASTE_REASONS: { key: string; label: string }[] = [
  { key: 'spoiled', label: 'تالف' },
  { key: 'burnt', label: 'محروق' },
  { key: 'dropped', label: 'وقع / انسكب' },
  { key: 'tasting', label: 'تذوق' },
  { key: 'expired', label: 'منتهي الصلاحية' },
  { key: 'overcooked', label: 'خطأ تحضير' },
  { key: 'returned_by_guest', label: 'مرتجع من العميل' },
  { key: 'staff_meal', label: 'وجبة موظفين' },
  { key: 'other', label: 'سبب آخر' },
];

export const WASTE_REASON_LABELS: Record<string, string> = {
  ...Object.fromEntries(WASTE_REASONS.map((r) => [r.key, r.label])),
  order_cancelled: 'طلب أُلغي أثناء التحضير',
  transit_loss: 'فقد أثناء التحويل',
};

export const TRANSFER_STATUS_LABELS: Record<string, string> = {
  issued: 'بانتظار الاستلام',
  received: 'تم الاستلام',
  disputed: 'فرق في الاستلام',
  resolved: 'تمت التسوية',
  cancelled: 'ملغي',
};
