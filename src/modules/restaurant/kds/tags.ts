/**
 * How a modifier or note reads on the kitchen display. Removals and allergies
 * are the expensive mistakes, so they get the loudest tag; additions come
 * next; anything else is a plain option.
 */
export type TagKind = 'allergy' | 'without' | 'extra' | 'option';

const ALLERGY = /(حساسي|allerg|gluten|جلوتين|nut|مكسرات|فول سوداني|peanut|lactose|لاكتوز)/i;
const WITHOUT = /(^|\s|[(\-–—])(بدون|بلا|من غير|مش عايز|no|without|hold|minus)(\s|$)|^لا\s/i;
const EXTRA = /(زيادة|زياده|اكسترا|إكسترا|إضافي|اضافي|إضافة|اضافة|دبل|مضاعف|extra|double|add|more)/i;

export function classifyTag(text: string): TagKind {
  const t = text.trim();
  if (ALLERGY.test(t)) return 'allergy';
  if (WITHOUT.test(t)) return 'without';
  if (EXTRA.test(t)) return 'extra';
  return 'option';
}

/** A free-text note can carry several instructions: "بدون بصل، زيادة صوص". */
export function splitNote(note: string): string[] {
  return note
    .split(/[،,;\n؛]+|\s+و(?=بدون|زيادة|بلا|من غير)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export const TAG_STYLE: Record<TagKind, string> = {
  allergy: 'border-red-700 bg-red-600 text-white',
  without: 'border-red-600 bg-red-50 text-red-700',
  extra: 'border-amber-500 bg-amber-50 text-amber-800',
  option: 'border-line bg-surface text-fg',
};
