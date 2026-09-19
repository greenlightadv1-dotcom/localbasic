import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

/**
 * The address a password-recovery email returns to.
 *
 * A dedicated path rather than `/callback?next=/reset-password`, because the
 * redirect target has to survive Supabase's allow-list. That list is matched
 * against the whole URL, so an entry of `…/callback` does not cover
 * `…/callback?next=%2Freset-password`; when the match fails Supabase says
 * nothing and quietly falls back to the Site URL, which lands the visitor on
 * the marketing page with a spent link. A bare path with no query is either
 * allow-listed or it is not, with no third possibility to debug.
 *
 * It is a route handler, not a page, because exchanging the code writes the
 * session cookie and only a handler or an action may set cookies.
 *
 * Recovery is the destination regardless of what else the URL carries: the
 * person holding this link cannot sign in, so the workspace is the one place
 * they must not be sent.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');

  if (!code || searchParams.get('error')) {
    return NextResponse.redirect(`${origin}/sign-in?error=link_invalid`);
  }

  const supabase = createSupabaseServerClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) return NextResponse.redirect(`${origin}/sign-in?error=link_invalid`);

  return NextResponse.redirect(`${origin}/reset-password`);
}
