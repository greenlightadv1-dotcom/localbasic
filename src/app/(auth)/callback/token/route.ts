import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

/**
 * Turns an implicit-flow fragment into the ordinary httpOnly cookie session.
 *
 * A link generated from the Supabase Dashboard cannot use PKCE — there is no
 * code verifier in the recipient's browser — so Supabase returns the tokens in
 * the URL fragment instead of a `?code=` query. Fragments never reach a server,
 * and this application keeps its session in httpOnly cookies that client code
 * deliberately cannot read or write. Without this endpoint the two halves can
 * never meet: the browser holds a valid session the server cannot see.
 *
 * The client posts the tokens here exactly once; setSession() validates them
 * against Supabase and writes the same cookies /callback would have written.
 * From here on every flow is identical.
 *
 * Tokens are never logged and never echoed back.
 */
export async function POST(request: NextRequest) {
  // Same-origin only. Accepting a cross-site post would let one site drop its
  // own tokens into someone else's browser — session fixation, where the
  // victim ends up signed in as the attacker without noticing.
  const origin = request.headers.get('origin');
  if (origin && origin !== request.nextUrl.origin) {
    return NextResponse.json({ ok: false }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const { access_token: accessToken, refresh_token: refreshToken } =
    (body ?? {}) as Record<string, unknown>;

  if (typeof accessToken !== 'string' || typeof refreshToken !== 'string'
      || accessToken.length === 0 || refreshToken.length === 0) {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const supabase = createSupabaseServerClient();
  const { error } = await supabase.auth.setSession({
    access_token: accessToken,
    refresh_token: refreshToken,
  });

  // A rejected token is an expired or already-used link, not a server fault.
  if (error) return NextResponse.json({ ok: false }, { status: 401 });

  return NextResponse.json({ ok: true });
}
