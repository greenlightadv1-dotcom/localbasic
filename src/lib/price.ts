/**
 * Compact price for storefront cards and bars: "105 EGP", "105.50 EGP".
 * Whole amounts drop the ".00"; anything else keeps two decimals. Latin
 * digits on purpose — prices scan faster in a column of cards that way, and
 * the currency code is the one the store is configured with.
 */
export function formatPrice(cents: number, currency: string): string {
  const whole = cents % 100 === 0;
  const n = (cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
    useGrouping: false,
  });
  return `${n} ${currency}`;
}
