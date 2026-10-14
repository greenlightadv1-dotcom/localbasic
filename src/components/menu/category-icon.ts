import {
  Beef, CakeSlice, Coffee, Croissant, CupSoda, Drumstick, EggFried, Fish, Flame, IceCream,
  Pizza, Salad, Sandwich, Soup, UtensilsCrossed, type LucideIcon,
} from 'lucide-react';

/**
 * The placeholder icon for an item or category with no photo, chosen from the
 * category's name — Arabic or English — so a pizza section gets a pizza and a
 * coffee section gets a cup instead of the same plate everywhere.
 *
 * Pure and dependency-light (icons only), so server and client share it. The
 * first matching rule wins, so more specific rules come first; anything that
 * matches nothing gets the generic plate.
 */

/** Lowercase, and fold the Arabic spellings that vary (hamza forms, ta marbuta, yaa, diacritics). */
export function normalizeArabic(text: string): string {
  return text
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/[ىئ]/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ة/g, 'ه')
    .trim();
}

// Latin words are matched on boundaries so "tea" never matches inside "steak"
// and "ice" never matches inside "juice".
const RULES: [RegExp, LucideIcon][] = [
  [/pizza|بيتزا|فطيره|فطاير/, Pizza],
  [/ice\s*cream|icecream|gelato|ايس\s*كريم|اسكريم|جيلاتو|ايس/, IceCream],
  [/dessert|cake|waffle|crepe|sweet|كيك|حلو|كنافه|وافل|كريب|بسبوسه|قطايف|تشيز/, CakeSlice],
  [/coffee|espresso|latte|cappuccino|\btea\b|nescafe|قهوه|اسبريسو|لاتيه|كابتشينو|شاي|نسكافيه|مشروبات\s*ساخنه|ساخن/, Coffee],
  [/drink|beverage|juice|soda|shake|smoothie|water|cold|mojito|مشروب|عصير|عصاير|ميلك\s*شيك|سموذي|مياه|بارد|موهيتو|ليمون|مثلج/, CupSoda],
  [/burger|sandwich|shawarma|wrap|sub\b|hotdog|برجر|ساندوتش|سندوتش|ساندويتش|شاورما|راب|هوت\s*دوج/, Sandwich],
  [/grill|bbq|kebab|kofta|mixed\s*grill|مشاوي|مشويات|شواء|كباب|كفته|فحم|مشوي/, Flame],
  [/chicken|fried|broast|wings|nugget|دجاج|فراخ|بروستد|بروست|كنتاكي|ويجز|ناجتس|كريسبي/, Drumstick],
  [/steak|beef|meat|lamb|ribs|ستيك|لحم|لحوم|ضاني|كندوز/, Beef],
  [/fish|seafood|shrimp|prawn|سمك|اسماك|بحري|جمبري|ميجو|مأكولات\s*بحريه/, Fish],
  [/salad|سلطه|سلطات|سلاطات|مقبلات\s*باردة/, Salad],
  [/soup|شوربه|شوربات/, Soup],
  [/breakfast|brunch|egg|فطار|افطار|بيض|فول|فلافل/, EggFried],
  [/bakery|pastry|croissant|bread|مخبوزات|معجنات|كرواسون|عيش|خبز|مخبز/, Croissant],
];

export function iconForCategory(name: string | null | undefined): LucideIcon {
  if (!name) return UtensilsCrossed;
  const text = normalizeArabic(name);
  for (const [pattern, icon] of RULES) if (pattern.test(text)) return icon;
  return UtensilsCrossed;
}
