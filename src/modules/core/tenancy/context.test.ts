import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@/lib/errors';

type Row = Record<string, unknown>;

const h = vi.hoisted(() => {
  const state = {
    user: null as { id: string } | null,
    /** What the membership lookup returns — null stands for "not a member". */
    membership: null as Row | null,
    memberships: [] as Row[],
    branches: [] as Row[],
    memberBranches: [] as Row[],
    modules: [] as Row[],
    grants: [] as Row[],
  };
  const queries: { table: string; filters: [string, unknown][] }[] = [];

  function build(table: string) {
    const entry = { table, filters: [] as [string, unknown][] };
    queries.push(entry);
    const rows = (): Row[] =>
      ({
        organization_members: state.memberships,
        branches: state.branches,
        member_branches: state.memberBranches,
        organization_modules: state.modules,
        user_roles: state.grants,
      })[table] ?? [];

    const b: Record<string, unknown> = {
      select: () => b,
      eq: (c: string, v: unknown) => {
        entry.filters.push([c, v]);
        return b;
      },
      is: (c: string, v: unknown) => {
        entry.filters.push([c, v]);
        return b;
      },
      order: () => b,
      maybeSingle: async () => ({ data: state.membership, error: null }),
      // Thenable, so `await query` resolves like a PostgREST builder does.
      then: (resolve: (r: unknown) => unknown) => resolve({ data: rows(), error: null }),
    };
    return b;
  }

  return { state, queries, build };
});

// `cache()` lives only in React's react-server build, which Next uses for
// Server Components and which refuses to load outside that environment. It
// memoises per request; here each test is its own request, so identity is the
// right stand-in and keeps the module importable.
vi.mock('react', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('react')),
  cache: <T>(fn: T) => fn,
}));

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () => ({
    auth: {
      getUser: async () => ({
        data: { user: h.state.user },
        error: h.state.user ? null : { message: 'no session' },
      }),
    },
    from: (table: string) => h.build(table),
  }),
}));

import { resolveTenantContext, can } from './context';
import { listMyWorkspaces } from './service';

const ORG = {
  id: 'org-1',
  slug: 'lavechi',
  name: 'Lavechi',
  currency: 'EGP',
  default_locale: 'ar',
  primary_module: 'restaurant',
};

const MAIN = { id: 'branch-main', slug: 'main', name: 'الفرع الرئيسي' };
const SECOND = { id: 'branch-2', slug: 'downtown', name: 'وسط البلد' };

/** A grant carrying one permission, shaped as the embedded select returns it. */
const OWNER_GRANT = {
  branch_id: null,
  roles: {
    key: 'owner',
    is_owner: true,
    role_permissions: [{ permission_key: 'restaurant.order.read' }],
  },
};

function memberOf(overrides: Row = {}) {
  return { id: 'member-1', all_branches: true, organizations: ORG, ...overrides };
}

async function status(fn: () => Promise<unknown>): Promise<number> {
  try {
    await fn();
    return 200;
  } catch (error) {
    return error instanceof AppError ? error.status : -1;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  h.queries.length = 0;
  Object.assign(h.state, {
    user: { id: 'user-1' },
    membership: null,
    memberships: [],
    // Deliberately populated in every test: the platform read policies make
    // these rows visible to an operator, and visibility must not be access.
    branches: [MAIN, SECOND],
    memberBranches: [],
    modules: [{ module_key: 'restaurant' }],
    grants: [],
  });
});

describe('resolveTenantContext', () => {
  // The bug this replaces: membership was inferred from whether RLS returned
  // the organization row, and the platform console's read policies return it
  // for every tenant. Branches and modules are visible below and still must
  // not let an operator in.
  it('is 404 for a platform admin with no membership', async () => {
    h.state.membership = null;
    // Everything else the resolver reads is present and permissive, so the
    // only thing that can refuse this request is the membership gate itself.
    h.state.memberBranches = [{ branch_id: MAIN.id }, { branch_id: SECOND.id }];
    h.state.grants = [OWNER_GRANT];
    expect(await status(() => resolveTenantContext('lavechi'))).toBe(404);
    expect(await status(() => resolveTenantContext('lavechi', 'main'))).toBe(404);
  });

  it('looks membership up by the signed-in user, never by RLS alone', async () => {
    h.state.membership = memberOf();
    h.state.grants = [OWNER_GRANT];
    await resolveTenantContext('lavechi');

    const lookup = h.queries.find((q) => q.table === 'organization_members');
    expect(lookup?.filters).toContainEqual(['user_id', 'user-1']);
    expect(lookup?.filters).toContainEqual(['status', 'active']);
    expect(lookup?.filters).toContainEqual(['organizations.slug', 'lavechi']);
  });

  it('resolves a tenant member and carries only their granted permissions', async () => {
    h.state.membership = memberOf();
    h.state.grants = [OWNER_GRANT];

    const ctx = await resolveTenantContext('lavechi', 'main');
    expect(ctx.organizationSlug).toBe('lavechi');
    expect(ctx.branchSlug).toBe('main');
    expect(ctx.isOwner).toBe(true);
    expect(can(ctx, 'restaurant.order.read')).toBe(true);
    expect(can(ctx, 'member.read')).toBe(false);
  });

  // A membership is a membership. Holding a platform role as well neither
  // adds a tenant permission nor takes one away.
  it('lets a platform admin who is genuinely a member in', async () => {
    h.state.membership = memberOf();
    h.state.grants = [OWNER_GRANT];

    const ctx = await resolveTenantContext('lavechi', 'main');
    expect(ctx.branchSlug).toBe('main');
    expect(can(ctx, 'restaurant.order.read')).toBe(true);
  });

  it('admits a member with no permissions, and grants them nothing', async () => {
    h.state.membership = memberOf();
    h.state.grants = [];

    const ctx = await resolveTenantContext('lavechi', 'main');
    expect(ctx.permissions.size).toBe(0);
    expect(can(ctx, 'restaurant.order.read')).toBe(false);
  });

  // The platform read policy on branches is not scoped to a branch
  // assignment, so the scope has to come from the membership itself.
  it('limits branches to the ones the membership assigns', async () => {
    h.state.membership = memberOf({ all_branches: false });
    h.state.memberBranches = [{ branch_id: SECOND.id }];
    h.state.grants = [OWNER_GRANT];

    const ctx = await resolveTenantContext('lavechi');
    expect(ctx.branches.map((b) => b.slug)).toEqual(['downtown']);
    expect(await status(() => resolveTenantContext('lavechi', 'main'))).toBe(404);
  });

  it('is 401 when there is no session at all', async () => {
    h.state.user = null;
    expect(await status(() => resolveTenantContext('lavechi'))).toBe(401);
  });
});

describe('listMyWorkspaces', () => {
  it('filters by the signed-in user rather than trusting RLS for identity', async () => {
    h.state.memberships = [
      { organization_id: 'org-1', status: 'active', organizations: { ...ORG, status: 'active' } },
    ];

    const workspaces = await listMyWorkspaces();
    expect(workspaces).toEqual([{ slug: 'lavechi', name: 'Lavechi', moduleKey: 'restaurant' }]);

    const lookup = h.queries.find((q) => q.table === 'organization_members');
    expect(lookup?.filters).toContainEqual(['user_id', 'user-1']);
    expect(lookup?.filters).toContainEqual(['status', 'active']);
  });

  it('drops organizations that are not active', async () => {
    h.state.memberships = [
      { organization_id: 'org-1', status: 'active', organizations: { ...ORG, status: 'suspended' } },
    ];
    expect(await listMyWorkspaces()).toEqual([]);
  });
});
