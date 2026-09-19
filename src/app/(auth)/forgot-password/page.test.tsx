import { describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

vi.mock('@/lib/env', () => ({
  clientEnv: {
    NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key-that-is-long-enough',
    NEXT_PUBLIC_APP_URL: 'https://localbasic.vercel.app',
    NEXT_PUBLIC_APP_NAME: 'LocalBasic',
  },
  serverEnv: () => ({}),
}));
vi.mock('@/lib/supabase/server', () => ({ createSupabaseServerClient: () => ({}) }));
vi.mock('@/lib/action', () => ({ getClientIp: () => '203.0.113.1' }));
vi.mock('@/lib/supabase/local/db', () => ({ isLocalDb: () => false }));
vi.mock('next/navigation', () => ({ redirect: () => { throw new Error('unexpected redirect'); } }));

import ForgotPasswordPage from './page';
import { requestPasswordResetAction } from '../actions';

/** Walk the returned element tree without a DOM. */
function find(node: unknown, predicate: (el: ReactElement) => boolean): ReactElement | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, predicate);
      if (hit) return hit;
    }
    return null;
  }
  const el = node as ReactElement;
  if (el.type !== undefined) {
    if (predicate(el)) return el;
    const props = (el.props ?? {}) as { children?: unknown };
    return find(props.children, predicate);
  }
  return null;
}

describe('/forgot-password', () => {
  const tree = ForgotPasswordPage({});

  // The regression this whole investigation ended at: the form used to be a
  // client component driven by useFormState, so with scripts blocked the
  // button did nothing and no request ever left the browser.
  it('binds a real form element directly to the server action', () => {
    const form = find(tree, (el) => el.type === 'form');
    expect(form).not.toBeNull();
    expect((form!.props as { action?: unknown }).action).toBe(requestPasswordResetAction);
  });

  it('submits with a native submit button, not an onClick handler', () => {
    const button = find(tree, (el) => (el.props as { type?: string })?.type === 'submit');
    expect(button).not.toBeNull();
    expect((button!.props as { disabled?: unknown }).disabled).toBeUndefined();
    expect((button!.props as { onClick?: unknown }).onClick).toBeUndefined();
  });

  it('names the email field so FormData carries it', () => {
    // Field renders its control through a render prop, so the input only
    // exists once that function is called.
    const field = find(
      tree,
      (el) => typeof (el.props as { children?: unknown })?.children === 'function',
    );
    expect(field).not.toBeNull();

    const render = (field!.props as { children: (p: { id: string }) => ReactElement }).children;
    const input = render({ id: 'x' });

    expect((input.props as { name?: string }).name).toBe('email');
    expect((input.props as { type?: string }).type).toBe('email');
    expect((input.props as { required?: boolean }).required).toBe(true);
  });

  it('has no nested form', () => {
    const outer = find(tree, (el) => el.type === 'form');
    const inner = find((outer!.props as { children?: unknown }).children, (el) => el.type === 'form');
    expect(inner).toBeNull();
  });

  it('is rendered dynamically, so a CDN copy cannot outlive its headers', async () => {
    const mod = await import('./page');
    expect(mod.dynamic).toBe('force-dynamic');
  });
});
