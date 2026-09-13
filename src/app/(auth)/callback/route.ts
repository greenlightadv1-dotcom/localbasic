import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

/**
 * Exchanges the email confirmation / magic-link code for a session.
 *
 * The redirect target is validated to be a same-origin relative path, so this
 * endpoint cannot be used as an open redirect to bounce users off-site with a
 * freshly minted session.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const next = searchParams.get('next') ?? '/';
  const safeNext = next.startsWith('/') && !next.startsWith('//') ? next : '/';

  if (!code) return NextResponse.redirect(`${origin}/sign-in`);

  const supabase = createSupabaseServerClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) return NextResponse.redirect(`${origin}/sign-in`);

  return NextResponse.redirect(`${origin}${safeNext}`);
}
