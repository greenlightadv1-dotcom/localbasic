/** A typed amount ("12.50", "1,200") to cents, or null when it is not a valid amount. Client-safe. */
export function toCents(text: string, { allowNegative = false } = {}): number | null {
  const clean = text.trim().replace(/[,\s]/g, '');
  const re = allowNegative ? /^-?\d+(\.\d{0,2})?$/ : /^\d+(\.\d{0,2})?$/;
  if (!re.test(clean)) return null;
  const negative = clean.startsWith('-');
  const [whole = '0', fraction = ''] = clean.replace('-', '').split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return negative ? -cents : cents;
}

/** Cents back to an editable amount string ("12.5" → "12.50"). */
export const fromCents = (cents: number) => (cents / 100).toFixed(2);
