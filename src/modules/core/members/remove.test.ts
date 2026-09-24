import { beforeEach, expect, it, vi } from 'vitest';

/**
 * removeMember(), at the boundary.
 *
 * The SQL side (owner protection, cascade cleanup, audit) is member_remove()
 * (0064). This proves the TypeScript layer's own job: member.manage is
 * checked before any RPC runs, the member id is passed straight through, and
 * a SQL refusal (owner protection, not-found) becomes an AppError rather
 * than a raw error reaching a screen.
 */

const h = vi.hoisted(() => {
  const state = {
    hasPermission: true,
    rpcError: null as { message: string } | null,
  };
  const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];
  return { state, rpcCalls };
});

vi.mock('@/modules/core/tenancy/context', () => ({
  requirePermission: (ctx: unknown, permission: string) => {
    if (!h.state.hasPermission) throw new Error('not permitted');
    return permission;
  },
}));

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      h.rpcCalls.push({ fn, args });
      if (h.state.rpcError) return { data: null, error: h.state.rpcError };
      return { data: null, error: null };
    },
  }),
}));

import { removeMember } from './remove';

const CTX = { organizationId: 'org-1' } as never;

beforeEach(() => {
  h.state.hasPermission = true;
  h.state.rpcError = null;
  h.rpcCalls.length = 0;
});

it('refuses before any RPC runs when the caller lacks member.manage', async () => {
  h.state.hasPermission = false;
  await expect(removeMember(CTX, 'member-1')).rejects.toThrow();
  expect(h.rpcCalls).toHaveLength(0);
});

it('passes the organization and member id straight through', async () => {
  await removeMember(CTX, 'member-1');
  expect(h.rpcCalls).toEqual([
    { fn: 'member_remove', args: { p_org: 'org-1', p_member: 'member-1' } },
  ]);
});

it('turns a SQL refusal (e.g. removing the owner) into an AppError', async () => {
  h.state.rpcError = { message: 'لا يمكن حذف مالك المنشأة' };
  await expect(removeMember(CTX, 'member-1')).rejects.toMatchObject({
    code: 'validation',
    message: 'لا يمكن حذف مالك المنشأة',
  });
});
