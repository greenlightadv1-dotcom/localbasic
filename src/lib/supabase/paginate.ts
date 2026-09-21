import { AppError, toAppError } from '@/lib/errors';

/**
 * Reading EVERY row a report covers, not just the first page of them.
 *
 * PostgREST applies a server-side maximum row count (`db-max-rows`) to any
 * request that does not ask for a range. A plain `.select()` therefore returns
 * a silently truncated list once a branch is busy enough — and because the
 * reports aggregate in JavaScript, truncation does not error: it just reports
 * a smaller number. Under-reporting revenue is the worst possible failure mode
 * for a financial screen, because nothing looks wrong.
 *
 * The cap is a deployment setting and is NOT verifiable from this repository,
 * so the fix cannot be "stay under it". Instead every page is requested
 * explicitly and the loop runs until the exact row count PostgREST reports in
 * Content-Range has been collected. That is correct whatever the cap is, and
 * correct even if the server hands back fewer rows than the page asked for.
 */

/** One page, in the shape a Supabase query resolves to. */
export type PageResult<T> = {
  data: T[] | null;
  error: unknown;
  count?: number | null;
};

/**
 * Builds one page of a query.
 *
 * The factory must produce a FRESH builder each call — a PostgREST builder is
 * single-use — and must apply, in this order:
 *   - `.select(columns, { count: 'exact' })`, so the total is known;
 *   - a deterministic `.order(...)` on a column unique within the filter, so
 *     pages cannot overlap or skip rows;
 *   - `.range(offset, offset + limit - 1)`.
 */
export type PageQuery<T> = (offset: number, limit: number) => PromiseLike<PageResult<T>>;

/** Rows requested per round trip. Comfortably under any plausible cap. */
export const PAGE_SIZE = 1000;

/**
 * Hard ceiling on one report's row scan.
 *
 * Reached only by a custom range far wider than a reporting screen is built
 * for. It raises rather than truncating: a refusal the user can see beats a
 * total that is quietly wrong.
 */
export const MAX_ROWS = 50_000;

const TOO_MANY = 'المدى المطلوب كبير جدًا. اختر فترة أقصر.';

export async function fetchAllRows<T>(
  context: string,
  query: PageQuery<T>,
  options?: { pageSize?: number; maxRows?: number },
): Promise<T[]> {
  const pageSize = options?.pageSize ?? PAGE_SIZE;
  const maxRows = options?.maxRows ?? MAX_ROWS;
  const rows: T[] = [];
  let total: number | null = null;

  for (;;) {
    const { data, error, count } = await query(rows.length, pageSize);
    if (error) throw toAppError(error, context);

    const page = data ?? [];
    rows.push(...page);
    // Number.isFinite, not typeof: postgrest-js builds `count` with
    // parseInt() over the Content-Range header, which yields NaN when
    // PostgREST answers `*/*` instead of a total. NaN would compare false
    // against every bound below and silently disable the ceiling.
    if (total === null && Number.isFinite(count)) total = count as number;

    // Checked before the exit conditions: a scan that has already blown the
    // ceiling must raise, not return the oversized list it happens to hold.
    if (rows.length > maxRows) throw new AppError('validation', TOO_MANY);

    // No progress. Stops the loop dead even if the reported total is wrong.
    if (page.length === 0) break;
    if (total !== null && rows.length >= total) break;
    // Only reachable if the count header was missing, in which case a short
    // page is the best end-of-data signal available.
    if (total === null && page.length < pageSize) break;
  }

  return rows;
}

/** Ids per `.in()` filter, so a long list cannot overflow the request URL. */
export const IN_CHUNK = 200;

/** Splits a list of ids into `.in()`-sized chunks. */
export function chunk<T>(values: T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

/**
 * `fetchAllRows` over an `.in()` list too long to send in one request.
 *
 * Each chunk is paginated independently and the results concatenated. The
 * chunks partition the id list, so no row can be counted twice.
 *
 * Ids are DEDUPLICATED first. A repeated id inside one chunk is harmless —
 * SQL `in` collapses it — but the same id landing in two different chunks
 * would fetch its row twice and double it in the totals. No caller passes
 * duplicates today; this makes that a property of the helper rather than a
 * standing assumption about every future caller.
 */
export async function fetchAllRowsIn<T, Id>(
  context: string,
  ids: Id[],
  query: (ids: Id[], offset: number, limit: number) => PromiseLike<PageResult<T>>,
  options?: { pageSize?: number; maxRows?: number },
): Promise<T[]> {
  const maxRows = options?.maxRows ?? MAX_ROWS;
  const out: T[] = [];
  for (const part of chunk([...new Set(ids)])) {
    // The ceiling is on the whole scan, not on each chunk, so a long id list
    // cannot multiply it.
    const rows = await fetchAllRows<T>(context, (o, l) => query(part, o, l), {
      ...options,
      maxRows: Math.max(0, maxRows - out.length),
    });
    out.push(...rows);
  }
  return out;
}
