import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@/lib/errors';

const h = vi.hoisted(() => {
  const state = {
    rpcError: null as { code?: string; message: string } | null,
    rpcData: { out_transfer_id: 'transfer-1', out_line_count: 1 } as unknown,
  };
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  return { state, calls };
});

// `cache()` lives only in React's react-server build, which Next uses for
// Server Components and which refuses to load outside that environment. It
// memoises per request; here each test is its own request, so identity is the
// right stand-in. Same reason as src/modules/core/tenancy/context.test.ts.
vi.mock('react', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('react')),
  cache: <T>(fn: T) => fn,
}));

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () => ({
    rpc: (fn: string, args: Record<string, unknown>) => {
      h.calls.push({ fn, args });
      return {
        single: async () => ({ data: h.state.rpcData, error: h.state.rpcError }),
      };
    },
  }),
}));

import { transferStock } from './transfers';
import type { TenantContext } from '@/modules/core/tenancy/context';

const BRANCH_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BRANCH_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const VARIANT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const VARIANT2 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function ctx(permissions: string[]): TenantContext {
  return {
    userId: 'user-1',
    fullName: null,
    organizationId: 'org-1',
    organizationSlug: 'shop',
    organizationName: 'Shop',
    currency: 'EGP',
    locale: 'ar',
    branchId: BRANCH_A,
    branchSlug: 'main',
    branchName: 'Main',
    branches: [],
    permissions: new Set(permissions) as TenantContext['permissions'],
    roleKeys: [],
    isOwner: false,
    enabledModules: ['retail'],
    primaryModule: 'retail',
  };
}

const ALLOWED = ctx(['retail.inventory.transfer', 'retail.inventory.read']);

const INPUT = {
  fromBranchId: BRANCH_A,
  toBranchId: BRANCH_B,
  lines: [{ variantId: VARIANT, quantity: 5 }],
};

beforeEach(() => {
  vi.clearAllMocks();
  h.calls.length = 0;
  h.state.rpcError = null;
  h.state.rpcData = { out_transfer_id: 'transfer-1', out_line_count: 1 };
});

describe('transferStock', () => {
  it('moves stock for a user holding the permission', async () => {
    await expect(transferStock(ALLOWED, INPUT)).resolves.toEqual({
      transferId: 'transfer-1',
      lineCount: 1,
    });
    expect(h.calls[0]!.fn).toBe('retail_stock_transfer');
  });

  // Transferring reaches into a second branch's stock, so holding
  // retail.inventory.adjust — which is about your own shelves — is not enough.
  it('refuses a user who only holds retail.inventory.adjust', async () => {
    const keeper = ctx(['retail.inventory.adjust', 'retail.inventory.read']);
    await expect(transferStock(keeper, INPUT)).rejects.toThrow(AppError);
    expect(h.calls).toHaveLength(0);
  });

  // The organization is never taken from the caller's payload.
  it('sends the organization from the tenant context, not the input', async () => {
    await transferStock(ALLOWED, { ...INPUT, organizationId: 'org-999' } as never);
    expect(h.calls[0]!.args.p_org).toBe('org-1');
  });

  it('refuses a transfer to the same branch', async () => {
    await expect(
      transferStock(ALLOWED, { ...INPUT, toBranchId: BRANCH_A }),
    ).rejects.toThrow(AppError);
    expect(h.calls).toHaveLength(0);
  });

  it('refuses the same variant twice in one transfer', async () => {
    await expect(
      transferStock(ALLOWED, {
        ...INPUT,
        lines: [
          { variantId: VARIANT, quantity: 1 },
          { variantId: VARIANT, quantity: 2 },
        ],
      }),
    ).rejects.toThrow(AppError);
    expect(h.calls).toHaveLength(0);
  });

  it('accepts distinct variants in one transfer', async () => {
    await transferStock(ALLOWED, {
      ...INPUT,
      lines: [
        { variantId: VARIANT, quantity: 1 },
        { variantId: VARIANT2, quantity: 2 },
      ],
    });
    expect((h.calls[0]!.args.p_items as unknown[]).length).toBe(2);
  });

  it('refuses a non-positive or absurd quantity', async () => {
    for (const quantity of [0, -5, 2_000_000]) {
      await expect(
        transferStock(ALLOWED, { ...INPUT, lines: [{ variantId: VARIANT, quantity }] }),
      ).rejects.toThrow(AppError);
    }
    expect(h.calls).toHaveLength(0);
  });

  it('refuses an empty transfer', async () => {
    await expect(transferStock(ALLOWED, { ...INPUT, lines: [] })).rejects.toThrow(AppError);
    expect(h.calls).toHaveLength(0);
  });

  it('refuses a branch id that is not a uuid', async () => {
    await expect(
      transferStock(ALLOWED, { ...INPUT, toBranchId: "' or 1=1--" }),
    ).rejects.toThrow(AppError);
    expect(h.calls).toHaveLength(0);
  });

  // The non-negative stock constraint, surfaced in the operator's language.
  it('reports insufficient stock as a conflict', async () => {
    h.state.rpcError = { code: '23514', message: 'retail_stock_non_negative' };
    await expect(transferStock(ALLOWED, INPUT)).rejects.toMatchObject({ code: 'conflict' });
  });

  // The database checks the permission for BOTH branches; a refusal there is
  // the authoritative one and must not be reported as a generic failure.
  it('reports a database permission refusal as forbidden', async () => {
    h.state.rpcError = { code: '42501', message: 'not permitted' };
    await expect(transferStock(ALLOWED, INPUT)).rejects.toMatchObject({ code: 'forbidden' });
  });
});
