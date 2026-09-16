import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

/**
 * Middleware does two jobs and no more:
 *   1. refresh the Supabase session cookie so Server Components see a live user
 *   2. attach security headers, including a nonce-based CSP
 *
 * Authorization is NOT done here. Middleware cannot be the security boundary —
 * services and RLS are. It only keeps the session fresh and the headers tight.
 */
export async function middleware(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);

  let response = NextResponse.next({ request: { headers: requestHeaders } });

  // The local development adapter has no Supabase session to refresh; security
  // headers below still apply. Never active in production.
  const localDb =
    process.env.LOCALBASIC_LOCAL_DB === '1' && process.env.NODE_ENV !== 'production';

  // The demo sign-in at /dev hands out a session as any seeded staff member.
  // It is meaningless against a real Supabase project and must not exist there,
  // so it is refused before the route — and its pg-backed module — ever loads.
  if (!localDb && request.nextUrl.pathname === '/dev') {
    return new NextResponse(null, { status: 404 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  // Without usable credentials there is no session to refresh. Returning the
  // response with its security headers beats throwing, which would turn every
  // route — including the sign-in page that explains the problem — into a 500.
  const configured = Boolean(supabaseUrl && supabaseKey);

  const supabase = localDb || !configured ? null : createServerClient(
    supabaseUrl!,
    supabaseKey!,
    {
      cookies: {
        get: (name: string) => request.cookies.get(name)?.value,
        set: (name: string, value: string, options: CookieOptions) => {
          response.cookies.set({
            name,
            value,
            ...options,
            httpOnly: true,
            sameSite: 'lax',
            secure: process.env.NODE_ENV === 'production',
          });
        },
        remove: (name: string, options: CookieOptions) => {
          response.cookies.set({ name, value: '', ...options, maxAge: 0 });
        },
      },
    },
  );

  // Refreshes the access token when it is close to expiry and rewrites the
  // cookie on `response`. Without this call Server Components can observe a
  // stale session.
  if (supabase) await supabase.auth.getUser();

  const isDev = process.env.NODE_ENV !== 'production';
  const csp = [
    `default-src 'self'`,
    // 'unsafe-eval' is required by the Next.js dev overlay only.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`,
    `img-src 'self' data: blob: https:`,
    `font-src 'self' data: https://fonts.gstatic.com`,
    `connect-src 'self' https://*.supabase.co wss://*.supabase.co`,
    `frame-ancestors 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `object-src 'none'`,
    ...(isDev ? [] : ['upgrade-insecure-requests']),
  ].join('; ');

  response.headers.set('Content-Security-Policy', csp);
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set(
    'Permissions-Policy',
    'camera=(self), microphone=(), geolocation=(), payment=()',
  );
  if (!isDev) {
    response.headers.set(
      'Strict-Transport-Security',
      'max-age=63072000; includeSubDomains; preload',
    );
  }

  return response;
}

export const config = {
  matcher: [
    // Everything except static assets and image optimisation.
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
