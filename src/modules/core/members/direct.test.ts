import { beforeEach, expect, it, vi } from 'vitest';

/**
 * createMemberDirect(), at the boundary.
 *
 * The SQL side (role/branch ownership, app.role_grantable()) is the same
 * guard set invitation_accept() already carries and is proven by the RBAC
 * escalation-guard suite. This proves what the TypeScript layer owns: the
 * permission check runs before any identity is created, a duplicate email
 * becomes a friendly message rather than a raw Admin API error, and a
 * workspace-half failure deletes the auth account it just created rather
 * than leaving a working login with no membership anywhere.
 */

const h = vi.hoisted(() => {
  const state = {
    hasPermission: true,
    provisioningAvailable: true,
    createUserError: null as { message: string } | null,
    createdUserId: 'user-1',
    rpcError: null as { message: string } | null,
    rpcMemberId: 'member-1' as string | null,
  };
  const calls: { createUser: number; deleteUser: string[]; rpc: { fn: string; args: Record<string, unknown> }[] } = {
    createUser: 0,
    deleteUser: [],
    rpc: [],
  };
  return { state, calls };
});

vi.mock('@/modules/core/tenancy/context', () => ({
  requirePermission: (ctx: unknown, permission: string) => {
    if (!h.state.hasPermission) {
      throw new Error('not permitted');
    }
    return permission;
  },
}));

vi.mock('@/modules/platform/onboarding/service', () => ({
  ownerProvisioningAvailable: () => h.state.provisioningAvailable,
  SERVICE_ROLE_ENV: 'SUPABASE_SERVICE_ROLE_KEY',
}));

vi.mock('@/lib/supabase/admin', () => ({
  createSupabaseAdminClient: () => ({
    auth: {
      admin: {
        createUser: async () => {
          h.calls.createUser += 1;
          if (h.state.createUserError) return { data: { user: null }, error: h.state.createUserError };
          return { data: { user: { id: h.state.createdUserId } }, error: null };
        },
        deleteUser: async (id: string) => {
          h.calls.deleteUser.push(id);
          return { data: {}, error: null };
        },
      },
    },
  }),
}));

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      h.calls.rpc.push({ fn, args });
      if (h.state.rpcError) return { data: null, error: h.state.rpcError };
      return { data: h.state.rpcMemberId, error: null };
    },
  }),
}));

import { createMemberDirect } from './direct';

const CTX = { organizationId: 'org-1', organizationSlug: 'org', branchSlug: 'main' } as never;

const VALID_INPUT = {
  email: 'cashier@test.local',
  password: 'a-strong-password',
  fullName: 'Cashier One',
  roleIds: ['role-1'],
  branchIds: [] as string[],
  allBranches: true,
};

beforeEach(() => {
  h.state.hasPermission = true;
  h.state.provisioningAvailable = true;
  h.state.createUserError = null;
  h.state.createdUserId = 'user-1';
  h.state.rpcError = null;
  h.state.rpcMemberId = 'member-1';
  h.calls.createUser = 0;
  h.calls.deleteUser = [];
  h.calls.rpc = [];
});

it('refuses before creating any account when the caller lacks member.manage', async () => {
  h.state.hasPermission = false;
  await expect(createMemberDirect(CTX, VALID_INPUT)).rejects.toThrow();
  expect(h.calls.createUser).toBe(0);
});

it('creates the auth account and attaches it to the organization', async () => {
  const result = await createMemberDirect(CTX, VALID_INPUT);
  expect(result).toEqual({ memberId: 'member-1' });
  expect(h.calls.createUser).toBe(1);
  expect(h.calls.rpc).toEqual([
    {
      fn: 'member_provision_direct',
      args: {
        p_org: 'org-1',
        p_user: 'user-1',
        p_full_name: 'Cashier One',
        p_role_ids: ['role-1'],
        p_branch_ids: [],
        p_all_branches: true,
      },
    },
  ]);
});

it('turns a duplicate-email error into a message pointing at the invite flow', async () => {
  h.state.createUserError = { message: 'A user with this email address has already been registered' };
  await expect(createMemberDirect(CTX, VALID_INPUT)).rejects.toMatchObject({
    message: expect.stringContaining('دعوة موظف'),
  });
  expect(h.calls.rpc).toHaveLength(0);
});

it('deletes the just-created auth account when the workspace half fails', async () => {
  h.state.rpcError = { message: 'that role does not belong to this organization' };
  await expect(createMemberDirect(CTX, VALID_INPUT)).rejects.toThrow();
  expect(h.calls.deleteUser).toEqual(['user-1']);
});

it('refuses when the server has no service role key configured', async () => {
  h.state.provisioningAvailable = false;
  await expect(createMemberDirect(CTX, VALID_INPUT)).rejects.toThrow();
  expect(h.calls.createUser).toBe(0);
});
