import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * createMemberDirect() / resetMemberPassword(), at the boundary.
 *
 * The SQL side (role/branch ownership, app.role_grantable()) is the same
 * guard set invitation_accept() already carries and is proven by the RBAC
 * escalation-guard suite. This proves what the TypeScript layer owns: the
 * permission check runs before any identity is created, the login address is
 * derived from the username (staff have no email), a duplicate username becomes
 * a friendly message, a workspace-half failure deletes the auth account it just
 * created, and a password reset only reaches the Admin API after the database
 * authorizes it.
 */

const h = vi.hoisted(() => {
  const state = {
    hasPermission: true,
    provisioningAvailable: true,
    createUserError: null as { message: string } | null,
    createdUserId: 'user-1',
    profileError: null as { message: string } | null,
    updateUserError: null as { message: string } | null,
    rpcError: null as { message: string } | null,
    rpcMemberId: 'member-1' as string | null,
    authorizedTarget: 'target-user' as string | null,
  };
  const calls: {
    createUser: number;
    createUserEmails: string[];
    deleteUser: string[];
    profileUpdates: Record<string, unknown>[];
    passwordUpdates: { id: string; password: string }[];
    rpc: { fn: string; args: Record<string, unknown> }[];
  } = {
    createUser: 0,
    createUserEmails: [],
    deleteUser: [],
    profileUpdates: [],
    passwordUpdates: [],
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

vi.mock('@/lib/env', () => ({
  serverEnv: () => ({ SUPABASE_SERVICE_ROLE_KEY: h.state.provisioningAvailable ? 'service-key' : undefined }),
}));

vi.mock('@/lib/supabase/admin', () => ({
  createSupabaseAdminClient: () => ({
    auth: {
      admin: {
        createUser: async ({ email }: { email: string }) => {
          h.calls.createUser += 1;
          h.calls.createUserEmails.push(email);
          if (h.state.createUserError) return { data: { user: null }, error: h.state.createUserError };
          return { data: { user: { id: h.state.createdUserId } }, error: null };
        },
        updateUserById: async (id: string, attrs: { password: string }) => {
          h.calls.passwordUpdates.push({ id, password: attrs.password });
          return { data: {}, error: h.state.updateUserError };
        },
        deleteUser: async (id: string) => {
          h.calls.deleteUser.push(id);
          return { data: {}, error: null };
        },
      },
    },
    from: () => ({
      update: (values: Record<string, unknown>) => ({
        eq: async () => {
          h.calls.profileUpdates.push(values);
          return { error: h.state.profileError };
        },
      }),
    }),
  }),
}));

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      h.calls.rpc.push({ fn, args });
      if (h.state.rpcError) return { data: null, error: h.state.rpcError };
      if (fn === 'member_reset_password_authorize') return { data: h.state.authorizedTarget, error: null };
      return { data: h.state.rpcMemberId, error: null };
    },
  }),
}));

import { createMemberDirect, resetMemberPassword } from './direct';

const CTX = { organizationId: 'org-1', organizationSlug: 'org', branchSlug: 'main' } as never;

const VALID_INPUT = {
  username: 'cashier.one',
  password: '123456',
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
  h.state.profileError = null;
  h.state.updateUserError = null;
  h.state.rpcError = null;
  h.state.rpcMemberId = 'member-1';
  h.state.authorizedTarget = 'target-user';
  h.calls.createUser = 0;
  h.calls.createUserEmails = [];
  h.calls.deleteUser = [];
  h.calls.profileUpdates = [];
  h.calls.passwordUpdates = [];
  h.calls.rpc = [];
});

it('refuses before creating any account when the caller lacks member.manage', async () => {
  h.state.hasPermission = false;
  await expect(createMemberDirect(CTX, VALID_INPUT)).rejects.toThrow();
  expect(h.calls.createUser).toBe(0);
});

it('signs the account up under an address derived from the username and attaches it to the organization', async () => {
  const result = await createMemberDirect(CTX, VALID_INPUT);
  expect(result).toEqual({ memberId: 'member-1', username: 'cashier.one' });
  expect(h.calls.createUserEmails).toEqual(['cashier.one@login.localbasic.internal']);
  // Staff cannot change a password, so they are never forced to.
  expect(h.calls.profileUpdates).toEqual([{ username: 'cashier.one', must_change_password: false }]);
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

it('passes the chosen branches through when not all-branches', async () => {
  await createMemberDirect(CTX, { ...VALID_INPUT, allBranches: false, branchIds: ['b-1', 'b-2'] });
  expect(h.calls.rpc[0]!.args).toMatchObject({ p_branch_ids: ['b-1', 'b-2'], p_all_branches: false });
});

it('requires at least one branch unless all branches is chosen', async () => {
  await expect(
    createMemberDirect(CTX, { ...VALID_INPUT, allBranches: false, branchIds: [] }),
  ).rejects.toThrow();
  expect(h.calls.createUser).toBe(0);
});

it('turns a duplicate username into a clear message', async () => {
  h.state.createUserError = { message: 'A user with this email address has already been registered' };
  await expect(createMemberDirect(CTX, VALID_INPUT)).rejects.toMatchObject({
    message: expect.stringContaining('اسم المستخدم مستخدم'),
  });
  expect(h.calls.rpc).toHaveLength(0);
});

it('deletes the just-created auth account when the workspace half fails', async () => {
  h.state.rpcError = { message: 'that role does not belong to this organization' };
  await expect(createMemberDirect(CTX, VALID_INPUT)).rejects.toThrow();
  expect(h.calls.deleteUser).toEqual(['user-1']);
});

it('deletes the account when the username cannot be stamped on its profile', async () => {
  h.state.profileError = { message: 'boom' };
  await expect(createMemberDirect(CTX, VALID_INPUT)).rejects.toThrow();
  expect(h.calls.deleteUser).toEqual(['user-1']);
  expect(h.calls.rpc).toHaveLength(0);
});

it('refuses when the server has no service role key configured', async () => {
  h.state.provisioningAvailable = false;
  await expect(createMemberDirect(CTX, VALID_INPUT)).rejects.toThrow();
  expect(h.calls.createUser).toBe(0);
});

describe('resetMemberPassword', () => {
  it('asks the database to authorize, then sets the password without forcing a change', async () => {
    await resetMemberPassword(CTX, 'member-9', 'newpin1');
    expect(h.calls.rpc).toEqual([
      { fn: 'member_reset_password_authorize', args: { p_org: 'org-1', p_member: 'member-9' } },
    ]);
    expect(h.calls.passwordUpdates).toEqual([{ id: 'target-user', password: 'newpin1' }]);
    expect(h.calls.profileUpdates).toEqual([{ must_change_password: false }]);
  });

  it('never reaches the Admin API when the database refuses (owner, higher role, other org)', async () => {
    h.state.rpcError = { message: 'لا يمكن تغيير كلمة مرور مالك المنشأة من هنا' };
    await expect(resetMemberPassword(CTX, 'member-9', 'newpin1')).rejects.toThrow();
    expect(h.calls.passwordUpdates).toHaveLength(0);
  });

  it('refuses without member.manage before touching the database', async () => {
    h.state.hasPermission = false;
    await expect(resetMemberPassword(CTX, 'member-9', 'newpin1')).rejects.toThrow();
    expect(h.calls.rpc).toHaveLength(0);
  });

  it('rejects a too-short password', async () => {
    await expect(resetMemberPassword(CTX, 'member-9', '123')).rejects.toThrow();
    expect(h.calls.rpc).toHaveLength(0);
  });
});
