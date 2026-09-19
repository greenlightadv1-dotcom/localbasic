import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { safeNextPath } from '@/lib/auth/redirects';

/**
 * Exchanges the email confirmation / magic-link / recovery code for a session.
 *
 * One endpoint serves all three because they are the same operation: Supabase
 * redirects here with a code, this trades it for a session cookie, and `next`
 * decides where the person lands. Recovery therefore reuses the flow that
 * already existed rather than adding a parallel one.
 *
 * `next` is reduced by safeNextPath() to a same-origin relative path, so this
 * endpoint cannot be used as an open redirect to bounce someone off-site
 * carrying a freshly minted session.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const next = safeNextPath(searchParams.get('next'));

  // Supabase appends ?error=access_denied&error_code=otp_expired when a link
  // has already been used or has aged out. Say so instead of showing a bare
  // sign-in page, which reads as "your password is wrong".
  if (!code || searchParams.get('error')) {
    return NextResponse.redirect(`${origin}/sign-in?error=link_invalid`);
  }

  const supabase = createSupabaseServerClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) return NextResponse.redirect(`${origin}/sign-in?error=link_invalid`);

  return NextResponse.redirect(`${origin}${next}`);
}
