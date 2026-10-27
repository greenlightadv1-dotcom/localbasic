/**
 * Clinic calendar time in the organization's own timezone. Client-safe.
 *
 * Shifts are stored as local wall-clock times ("09:00" on weekday 0) and
 * appointments as instants. The calendar draws instants on a local grid, and
 * booking turns a local date + time back into an instant, so both directions
 * go through the organization's IANA zone, never the browser's.
 */

export type LocalDate = string; // YYYY-MM-DD

const pad = (n: number) => String(n).padStart(2, '0');

function parts(instant: Date, timeZone: string) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const p = Object.fromEntries(f.formatToParts(instant).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour), min: Number(p.minute), s: Number(p.second) };
}

/** The zone's offset from UTC at that instant, in minutes (Cairo summer = +180). */
function offsetMinutes(instant: Date, timeZone: string): number {
  const p = parts(instant, timeZone);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s);
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60000);
}

/** Local date and minutes-since-midnight of an instant. */
export function toLocal(iso: string | Date, timeZone: string): { date: LocalDate; minutes: number } {
  const p = parts(typeof iso === 'string' ? new Date(iso) : iso, timeZone);
  return { date: `${p.y}-${pad(p.m)}-${pad(p.d)}`, minutes: p.h * 60 + p.min };
}

/** A local wall-clock moment as an instant. Resolves DST by re-checking the offset once. */
export function fromLocal(date: LocalDate, minutes: number, timeZone: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const naive = Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60);
  let guess = new Date(naive - offsetMinutes(new Date(naive), timeZone) * 60000);
  guess = new Date(naive - offsetMinutes(guess, timeZone) * 60000);
  return guess;
}

export function todayIn(timeZone: string, now = new Date()): LocalDate {
  return toLocal(now, timeZone).date;
}

export function addDays(date: LocalDate, days: number): LocalDate {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** 0 = Sunday … 6 = Saturday, as in clinic_doctor_shifts.weekday. */
export function weekdayOf(date: LocalDate): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** The Saturday that starts the clinic week containing `date` (Saturday-first, as in Egypt). */
export function weekStart(date: LocalDate): LocalDate {
  return addDays(date, -((weekdayOf(date) + 1) % 7));
}

export function isLocalDate(value: unknown): value is LocalDate {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** "09:30" → 570 */
export function hmToMinutes(hm: string): number {
  const [h, m] = hm.split(':').map(Number) as [number, number];
  return h * 60 + m;
}

/** 570 → "09:30" */
export function minutesToHm(minutes: number): string {
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

export const WEEKDAYS_AR = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'] as const;
