/**
 * Calendar arithmetic in a named IANA timezone.
 *
 * Reports ask "what happened today?", and "today" is a calendar day where the
 * business stands — not where the server happens to run. A Cairo restaurant
 * closing at 01:00 has not started a new day; a Node process at UTC thinks it
 * has, because UTC midnight arrived three hours earlier.
 *
 * Everything here works from Intl.DateTimeFormat, which carries the real IANA
 * rules, so daylight saving is handled by the same tables the operating system
 * uses rather than by an offset somebody typed in. There are no hard-coded
 * zones and no arithmetic on process.env.TZ.
 *
 * These functions describe CALENDAR days. A business day that runs past
 * midnight is a different concept and is deliberately not modelled here.
 */

type Parts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

/** An instant broken into the wall-clock fields a given zone would show. */
function partsInZone(instant: Date, timeZone: string): Parts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const found: Record<string, string> = {};
  for (const part of formatter.formatToParts(instant)) {
    if (part.type !== 'literal') found[part.type] = part.value;
  }

  return {
    year: Number(found.year),
    month: Number(found.month),
    day: Number(found.day),
    // Some ICU versions render midnight as hour 24 under hour12: false.
    hour: Number(found.hour) % 24,
    minute: Number(found.minute),
    second: Number(found.second),
  };
}

/** How far ahead of UTC the zone is at this instant, in milliseconds. */
function offsetMsAt(instant: Date, timeZone: string): number {
  const p = partsInZone(instant, timeZone);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // Seconds resolution is all formatToParts gives; drop the sub-second part of
  // the instant so the difference is the offset and not the milliseconds.
  return asIfUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * The absolute instant at which a wall-clock time occurs in a zone.
 *
 * Resolved in two passes. The first guesses using the offset in force at the
 * UTC instant with the same digits; on a day when the offset changes, that
 * guess can land on the wrong side of the transition, so the second pass
 * recomputes using the offset actually in force at the guess. Two passes are
 * enough for every real zone, where transitions are hours apart at minimum.
 */
function instantOfWallClock(
  timeZone: string,
  year: number,
  month: number,
  day: number,
): Date {
  const naive = Date.UTC(year, month - 1, day, 0, 0, 0);
  const firstGuess = naive - offsetMsAt(new Date(naive), timeZone);
  const refined = naive - offsetMsAt(new Date(firstGuess), timeZone);
  return new Date(refined);
}

/** Midnight beginning the calendar day that `instant` falls on, in `timeZone`. */
export function startOfDayInZone(instant: Date, timeZone: string): Date {
  const p = partsInZone(instant, timeZone);
  return instantOfWallClock(timeZone, p.year, p.month, p.day);
}

/**
 * Midnight beginning the calendar day `days` away, in `timeZone`.
 *
 * The day is stepped on the CALENDAR, not by adding 24 hours: across a
 * daylight-saving change a day is 23 or 25 hours long, and "yesterday" still
 * means yesterday's date.
 */
export function startOfDayInZoneOffset(instant: Date, timeZone: string, days: number): Date {
  const p = partsInZone(instant, timeZone);
  // Date.UTC normalises overflow, so day 0 is the last day of the previous
  // month and day 32 rolls into the next one.
  const stepped = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return instantOfWallClock(
    timeZone,
    stepped.getUTCFullYear(),
    stepped.getUTCMonth() + 1,
    stepped.getUTCDate(),
  );
}

/** Midnight beginning the first day of the month `instant` falls in. */
export function startOfMonthInZone(instant: Date, timeZone: string): Date {
  const p = partsInZone(instant, timeZone);
  return instantOfWallClock(timeZone, p.year, p.month, 1);
}

/**
 * Local midnight for a bare calendar date, e.g. '2026-01-15'.
 *
 * Needed because `new Date('2026-01-15')` is UTC midnight, and in a zone
 * behind UTC that instant still belongs to the PREVIOUS local date — New York
 * would read it as 19:00 on the 14th. An operator typing a date into a report
 * means that date where the business is, so the digits are used directly
 * rather than being routed through a UTC instant.
 *
 * Returns null for anything that is not exactly YYYY-MM-DD, so the caller can
 * fall back to instant parsing.
 */
export function startOfCalendarDateInZone(isoDate: string, timeZone: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate.trim());
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const at = instantOfWallClock(timeZone, year, month, day);
  // Rejects a date that does not exist, such as 2026-02-30, which would
  // otherwise roll silently into March.
  const back = partsInZone(at, timeZone);
  if (back.year !== year || back.month !== month || back.day !== day) return null;

  return at;
}

/** The calendar date in `timeZone`, as YYYY-MM-DD. For assertions and labels. */
export function calendarDateInZone(instant: Date, timeZone: string): string {
  const p = partsInZone(instant, timeZone);
  return `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/**
 * Is this a timezone this runtime understands?
 *
 * The value comes from the organization row rather than a request, so it is
 * trusted — but a row written before a zone was renamed would otherwise throw
 * RangeError deep inside a report.
 */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}
