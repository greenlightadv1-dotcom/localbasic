import { describe, expect, it } from 'vitest';
import { AppError } from '@/lib/errors';
import { PAGE_SIZE, chunk, fetchAllRows, fetchAllRowsIn } from './paginate';

/**
 * PostgREST truncates an unranged .select() at db-max-rows and says nothing
 * about it in the body. Reports sum their rows in JavaScript, so truncation
 * does not raise — it just returns a smaller, wrong total.
 *
 * The cap is a deployment setting, so these tests do not assume a value for
 * it. They assert the property that makes the value irrelevant: the loop
 * collects exactly the row count the server reports, whatever page size the
 * server actually honours.
 */

type Row = { id: number };

/**
 * A server holding `total` rows that never returns more than `serverCap` of
 * them at a time — the cap the caller cannot see or configure.
 */
function fakeTable(total: number, serverCap = PAGE_SIZE) {
  const calls: { offset: number; limit: number }[] = [];
  const rows: Row[] = Array.from({ length: total }, (_, i) => ({ id: i }));
  const query = (offset: number, limit: number) => {
    calls.push({ offset, limit });
    const size = Math.min(limit, serverCap);
    return Promise.resolve({
      data: rows.slice(offset, offset + size),
      error: null,
      count: total,
    });
  };
  return { calls, query };
}

describe('fetchAllRows', () => {
  it('returns every row when the result fits in one page', async () => {
    const t = fakeTable(10);
    const rows = await fetchAllRows<Row>('test', t.query);
    expect(rows).toHaveLength(10);
    expect(t.calls).toHaveLength(1);
  });

  it('returns an empty list for an empty result without looping', async () => {
    const t = fakeTable(0);
    expect(await fetchAllRows<Row>('test', t.query)).toEqual([]);
    expect(t.calls).toHaveLength(1);
  });

  it('collects a large result across pages', async () => {
    const t = fakeTable(4501);
    const rows = await fetchAllRows<Row>('test', t.query);
    expect(rows).toHaveLength(4501);
    expect(t.calls.length).toBeGreaterThan(1);
  });

  it('never returns a row twice and never skips one', async () => {
    const rows = await fetchAllRows<Row>('test', fakeTable(2500).query);
    const ids = rows.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(ids[0]).toBe(0);
    expect(ids.at(-1)).toBe(2499);
  });

  it('requests contiguous, non-overlapping windows', async () => {
    const t = fakeTable(2500);
    await fetchAllRows<Row>('test', t.query);
    let expected = 0;
    for (const call of t.calls) {
      expect(call.offset).toBe(expected);
      expected += Math.min(call.limit, PAGE_SIZE);
    }
  });

  // The point of the whole exercise: the server's cap is unknown, and a page
  // shorter than the one asked for must not be read as end-of-data.
  it.each([1, 7, 100, 999])(
    'still collects every row when the server caps pages at %i',
    async (serverCap) => {
      const t = fakeTable(1234, serverCap);
      const rows = await fetchAllRows<Row>('test', t.query);
      expect(rows).toHaveLength(1234);
      expect(new Set(rows.map((r) => r.id)).size).toBe(1234);
    },
  );

  it('stops rather than looping forever when the count is wrong', async () => {
    // A count larger than the rows that exist would spin a naive loop.
    const query = (offset: number, limit: number) =>
      Promise.resolve({
        data: offset === 0 ? [{ id: 1 }] : [],
        error: null,
        count: 999_999,
      });
    expect(await fetchAllRows<Row>('test', query)).toHaveLength(1);
  });

  it('falls back to a short page as end-of-data when no count is reported', async () => {
    const query = (offset: number) =>
      Promise.resolve({ data: offset === 0 ? [{ id: 1 }] : [], error: null, count: null });
    expect(await fetchAllRows<Row>('test', query)).toHaveLength(1);
  });

  it('raises instead of truncating when the scan exceeds the ceiling', async () => {
    const t = fakeTable(5000);
    await expect(fetchAllRows<Row>('test', t.query, { maxRows: 1500 })).rejects.toBeInstanceOf(
      AppError,
    );
  });

  it('surfaces a query error rather than returning a short list', async () => {
    const query = () => Promise.resolve({ data: null, error: { message: 'boom' }, count: null });
    await expect(fetchAllRows<Row>('test', query)).rejects.toBeInstanceOf(AppError);
  });
});

describe('chunk', () => {
  it('partitions ids exactly once each', () => {
    const ids = Array.from({ length: 450 }, (_, i) => i);
    const parts = chunk(ids, 200);
    expect(parts).toHaveLength(3);
    expect(parts.flat()).toEqual(ids);
  });

  it('is empty for an empty list', () => {
    expect(chunk([])).toEqual([]);
  });
});

describe('fetchAllRowsIn', () => {
  it('covers every id without duplicating a row across chunks', async () => {
    const ids = Array.from({ length: 500 }, (_, i) => `id-${i}`);
    const seen: string[][] = [];
    const rows = await fetchAllRowsIn<{ id: string }, string>(
      'test',
      ids,
      (part, offset, limit) => {
        if (offset === 0) seen.push(part);
        const page = part.slice(offset, offset + limit).map((id) => ({ id }));
        return Promise.resolve({ data: page, error: null, count: part.length });
      },
    );
    expect(rows.map((r) => r.id)).toEqual(ids);
    expect(seen.flat()).toEqual(ids);
    expect(new Set(rows.map((r) => r.id)).size).toBe(ids.length);
  });

  it('does not query at all for an empty id list', async () => {
    let called = 0;
    const rows = await fetchAllRowsIn<{ id: string }, string>('test', [], () => {
      called += 1;
      return Promise.resolve({ data: [], error: null, count: 0 });
    });
    expect(rows).toEqual([]);
    expect(called).toBe(0);
  });

  it('applies the row ceiling across chunks, not per chunk', async () => {
    const ids = Array.from({ length: 1000 }, (_, i) => `id-${i}`);
    await expect(
      fetchAllRowsIn<{ id: string }, string>(
        'test',
        ids,
        (part, offset, limit) => {
          const page = part
            .slice(offset, offset + limit)
            .flatMap((id) => Array.from({ length: 50 }, (_, k) => ({ id: `${id}-${k}` })));
          return Promise.resolve({ data: page, error: null, count: part.length * 50 });
        },
        { maxRows: 500 },
      ),
    ).rejects.toBeInstanceOf(AppError);
  });
});
