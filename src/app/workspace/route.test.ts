import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => {
  const state = {
    user: null as { id: string } | null,
    platform: null as { role: 'owner' | 'staff' } | null,
    workspaces: [] as { slug: string; name: string; moduleKey: string }[],
  };
  return {
    state,
    getPlatformContext: vi.fn(async () => state.platform),
    listMyWorkspaces: vi.fn(async () => state.workspaces),
  };
});

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: h.state.user }, error: null }) },
  }),
}));

vi.mock('@/modules/platform/admin/context', () => ({
  getPlatformContext: h.getPlatformContext,
}));
vi.mock('@/modules/core/tenancy/service', () => ({ listMyWorkspaces: h.listMyWorkspaces }));

import { GET } from './route';

const ORIGIN = 'https://localbasic.vercel.app';

async function visit(): Promise<string> {
  const response = await GET(new NextRequest(`${ORIGIN}/workspace`));
  return response.headers.get('location') ?? '';
}

beforeEach(() => {
  vi.clearAllMocks();
  h.state.user = { id: 'user-1' };
  h.state.platform = null;
  h.state.workspaces = [];
});

describe('GET /workspace', () => {
  it('sends a signed-out visitor to sign-in', async () => {
    h.state.user = null;
    expect(await visit()).toBe(`${ORIGIN}/sign-in`);
  });

  // The console is the platform admin's home. Landing them in a tenant
  // workspace is what put an operator in front of "you have no permissions".
  it('sends a platform admin to the console', async () => {
    h.state.platform = { role: 'owner' };
    expect(await visit()).toBe(`${ORIGIN}/admin`);
    expect(h.listMyWorkspaces).not.toHaveBeenCalled();
  });

  // Platform authorization wins: operating the SaaS is why they signed in.
  // They can still open their own workspace by its own URL.
  it('sends a platform admin who is also a tenant member to the console', async () => {
    h.state.platform = { role: 'owner' };
    h.state.workspaces = [{ slug: 'lavechi', name: 'Lavechi', moduleKey: 'restaurant' }];
    expect(await visit()).toBe(`${ORIGIN}/admin`);
  });

  it('sends a tenant member to their workspace', async () => {
    h.state.workspaces = [{ slug: 'lavechi', name: 'Lavechi', moduleKey: 'restaurant' }];
    expect(await visit()).toBe(`${ORIGIN}/lavechi`);
  });

  it('sends a member of nothing to onboarding', async () => {
    expect(await visit()).toBe(`${ORIGIN}/onboarding`);
  });
});
