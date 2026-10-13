import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ resolves: true, calls: [] as string[] }));
vi.mock('./service', () => ({
  getPublicContext: async (code: string) => {
    h.calls.push(code);
    if (!h.resolves) throw new Error('not found');
    return {};
  },
}));

import { resolveTableCode } from './table-entry';

const CODE = 'A'.repeat(22);

beforeEach(() => { h.resolves = true; h.calls = []; });

describe('resolveTableCode', () => {
  it('accepts a code that resolves to a table', async () => {
    expect(await resolveTableCode(CODE)).toBe(CODE);
  });

  it('takes the first of a repeated parameter', async () => {
    expect(await resolveTableCode([CODE, 'other'])).toBe(CODE);
  });

  it('never looks up a bare table number, or anything that is not a code', async () => {
    for (const bad of ['5', '12', '', '../etc', 'a b', 'x'.repeat(100), undefined]) {
      expect(await resolveTableCode(bad)).toBeNull();
    }
    expect(h.calls).toEqual([]);
  });

  it('returns null for a revoked, expired or unknown code, so the ordinary menu shows', async () => {
    h.resolves = false;
    expect(await resolveTableCode(CODE)).toBeNull();
  });
});
