/**
 * Money is always an integer number of minor units (piastres, cents).
 * Nothing in this codebase may represent an amount as a float.
 */
export type Cents = number;

export function assertCents(value: number, label = 'amount'): Cents {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} must be an integer number of minor units, received ${value}`);
  }
  return value;
}

/** Parses user input such as "12.50" into 1250 without float drift. */
export function parseAmountToCents(input: string | number): Cents {
  const text = String(input).trim().replace(/[,\s]/g, '');
  if (!/^-?\d+(\.\d{0,2})?$/.test(text)) {
    throw new Error(`Invalid amount: ${input}`);
  }
  const negative = text.startsWith('-');
  const [whole = '0', fraction = ''] = text.replace('-', '').split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return negative ? -cents : cents;
}

/**
 * Line total, computed entirely in integers.
 * Quantity may be fractional (1.5 kg), so the product is rounded once, at the
 * end, using half-up — the rule invoices are expected to follow.
 */
export function lineTotalCents(args: {
  unitPriceCents: Cents;
  quantity: number;
  discountCents?: Cents;
  taxRateBp?: number;
}): { netCents: Cents; taxCents: Cents; totalCents: Cents } {
  const { unitPriceCents, quantity, discountCents = 0, taxRateBp = 0 } = args;
  const gross = Math.round(unitPriceCents * quantity);
  const net = Math.max(0, gross - discountCents);
  const tax = Math.round((net * taxRateBp) / 10_000);
  return { netCents: net, taxCents: tax, totalCents: net + tax };
}

export function formatMoney(cents: Cents, currency: string, locale = 'ar-EG'): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(cents / 100);
}
