import 'server-only';
import { timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { serverEnv } from '@/lib/env';
import { appOrigin, recoveryRedirectUrl } from '@/lib/auth/redirects';

/**
 * Break-glass recovery for the one platform-owner account.
 *
 * Why it exists: every ordinary way back in runs through email, and email can
 * fail in ways nobody controls — a rate limit, a bounced domain, a redirect
 * that lands on the wrong page. When the only platform owner is locked out,
 * the platform is unadministrable.
 *
 * What it does NOT do: it never sets a password, never reads or writes
 * auth.users, and never touches platform_admins. It asks Supabase to *generate*
 * a recovery link — the same link the email would have carried — and returns it
 * in the response instead of mailing it. Supabase still owns the token: single
 * use, short lived, invalidated the moment a password is set.
 *
 * Every gate must pass, and each one fails as a flat 404 so that probing tells
 * an attacker nothing about whether the route exists:
 *   * ADMIN_BOOTSTRAP_SECRET must be configured, and matched in constant time;
 *   * SUPABASE_SERVICE_ROLE_KEY must be configured (server-only, as always);
 *   * the address must be the single hard-coded platform-owner address.
 *
 * The link is returned once, to the caller who already held the secret. It is
 * never logged, never stored, and never rendered into a page.
 */
const PLATFORM_OWNER_EMAIL = 'local.basic.adv@gmail.com';

function notFound() {
  return new NextResponse(null, { status: 404 });
}

function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, which would itself leak.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(request: NextRequest) {
  const env = serverEnv();
  if (!env.ADMIN_BOOTSTRAP_SECRET || !env.SUPABASE_SERVICE_ROLE_KEY) return notFound();

  const provided = request.headers.get('x-bootstrap-secret') ?? '';
  if (!provided || !secretMatches(provided, env.ADMIN_BOOTSTRAP_SECRET)) return notFound();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return notFound();
  }

  const { email } = (body ?? {}) as Record<string, unknown>;
  if (typeof email !== 'string'
      || email.trim().toLowerCase() !== PLATFORM_OWNER_EMAIL) {
    return notFound();
  }

  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.auth.admin.generateLink({
    type: 'recovery',
    email: PLATFORM_OWNER_EMAIL,
    options: { redirectTo: recoveryRedirectUrl('/reset-password', appOrigin()) },
  });

  // Deliberately opaque: the caller learns that it failed, not why.
  if (error || !data?.properties?.action_link) {
    return NextResponse.json({ ok: false }, { status: 502 });
  }

  return NextResponse.json(
    { ok: true, action_link: data.properties.action_link },
    { headers: { 'cache-control': 'no-store' } },
  );
}
