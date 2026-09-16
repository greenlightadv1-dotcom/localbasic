/**
 * Values shared between the server service and the client forms.
 *
 * Separate from service.ts because that module is `server-only`: importing a
 * weekday label from it would drag the Supabase server client into the browser
 * bundle and fail the build.
 */

export type OpeningDay = { closed: boolean; opens?: string; closes?: string };

export const WEEKDAYS_AR = [
  'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت', 'الأحد',
] as const;

/** Formats minor units in the restaurant's own currency, in Arabic numerals. */
export function formatMoney(cents: number, currency: string, locale = 'ar-EG'): string {
  return `${(cents / 100).toLocaleString(locale, {
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })} ${currency}`;
}
