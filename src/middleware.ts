import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

/**
 * Middleware does three jobs and no more:
 *   1. route custom-domain traffic to the restaurant website
 *   2. refresh the Supabase session cookie so Server Components see a live user
 *   3. attach security headers, including a content security policy
 *
 * Authorization is NOT done here. Middleware cannot be the security boundary —
 * services and RLS are. It only keeps the session fresh and the headers tight.
 */

/**
 * Paths that keep their meaning on every hostname.
 *
 * These carry their own identifiers — an order route names its restaurant and
 * branch, a QR token names its link — so they work unchanged on a custom
 * domain and must not be rewritten into the website subtree.
 */
const HOST_NEUTRAL_PREFIXES = ['/_next', '/api', '/order', '/p/', '/r/', '/account/join'];

/**
 * Is this request arriving on one of LocalBasic's own addresses?
 *
 * Anything else is a candidate custom domain. Deliberately generous: a host we
 * fail to recognise is rewritten to the resolver, which returns not-found for
 * a hostname no restaurant has activated. The cost of a false positive is a
 * 404; the cost of a false negative would be a customer's domain serving the
 * marketing site.
 */
function isPlatformHost(host: string): boolean {
  if (!host) return true;
  const bare = host.split(':')[0]!.toLowerCase();

  if (bare === 'localhost' || bare === '127.0.0.1' || bare === '[::1]') return true;
  if (bare.endsWith('.vercel.app')) return true;

  try {
    const appHost = new URL(process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000').hostname;
    if (bare === appHost.toLowerCase()) return true;
  } catch {
    // A malformed NEXT_PUBLIC_APP_URL should not decide routing; fall through.
  }
  return false;
}
/**
 * The page security policy.
 *
 * No nonce, and deliberately so. A nonce has to be minted per request, but
 * `/` and `/forgot-password` are statically prerendered: their HTML — script
 * tags included — is built once and served from the CDN, so a per-request
 * nonce in the header can never match what is in the document. Combined with
 * 'strict-dynamic', which tells browsers to ignore 'self' entirely, that
 * blocked every Next.js script on exactly those two pages. The pages still
 * rendered, because the markup is server-generated, so nothing looked wrong:
 * the forms simply did nothing when submitted.
 *
 * Making every page dynamic would fix the nonce and cost the marketing site
 * its static delivery. 'unsafe-inline' is the trade the other way: weaker in
 * principle, since it permits an injected inline script, but React escapes
 * interpolated values and nothing here renders raw HTML from user input. The
 * rest of the policy — object-src 'none', base-uri 'self', form-action 'self',
 * frame-ancestors 'none' — still constrains what an injection could do.
 */
function contentSecurityPolicy(isDev: boolean): string {
  return [
    `default-src 'self'`,
    // 'unsafe-eval' is required by the Next.js dev overlay only.
    `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
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
}

export async function middleware(request: NextRequest) {
  const isDev = process.env.NODE_ENV !== 'production';
  const csp = contentSecurityPolicy(isDev);

  const requestHeaders = new Headers(request.headers);

  // ---------------------------------------------------------------------
  // Custom domains.
  //
  // No database work happens here. Middleware runs on the edge, where the
  // local development adapter cannot, and a lookup on every request would
  // cost a round trip just to serve the platform's own traffic. Instead the
  // host — taken from the request, not from anything the page will later
  // read — is written into the rewritten path, and a Node-runtime route
  // resolves it.
  //
  // Putting the host in the path also means the render layer never has to
  // trust a header: the value it reads is one middleware put there.
  //
  // This produces `response` rather than returning early, so custom-domain
  // traffic still gets the session refresh and the security headers below.
  // ---------------------------------------------------------------------
  const host = (request.headers.get('host') ?? request.nextUrl.host).toLowerCase();
  const path = request.nextUrl.pathname;
  const isCustomDomain =
    !isPlatformHost(host)
    && !HOST_NEUTRAL_PREFIXES.some((p) => path === p || path.startsWith(p));

  // ---------------------------------------------------------------------
  // Auth links that land on the site root.
  //
  // Supabase redirects to the project's Site URL — this origin's root — for
  // any link it generates itself, because the Dashboard has nowhere to put a
  // path. When that link uses the PKCE flow the result arrives as `?code=` in
  // the query, which the marketing page silently ignores: the visitor just
  // sees the home page and the link is spent.
  //
  // Forwarding here rather than in the page keeps it server-side and free of
  // JavaScript, and `/callback` remains the only thing that redeems a code.
  // The fragment form of the same link cannot be handled here — browsers never
  // send fragments — so RecoveryLinkHandler covers that case in the client.
  // ---------------------------------------------------------------------
  if (!isCustomDomain && path === '/') {
    const params = request.nextUrl.searchParams;
    if (params.has('code')) {
      const to = request.nextUrl.clone();
      to.pathname = '/callback';
      return NextResponse.redirect(to);
    }
    if (params.has('error') || params.has('error_code')) {
      const to = request.nextUrl.clone();
      to.pathname = '/sign-in';
      to.search = '?error=link_invalid';
      return NextResponse.redirect(to);
    }
  }

  let response: NextResponse;
  if (isCustomDomain) {
    const url = request.nextUrl.clone();
    // Everything else on a custom domain is website traffic. A path that is
    // neither the root nor a branch slug resolves to not-found there, so the
    // marketing site, the sign-in page, the workspace and /admin are simply
    // not served on a customer's domain.
    url.pathname = `/site/${host.split(':')[0]}${path === '/' ? '' : path}`;
    response = NextResponse.rewrite(url, { request: { headers: requestHeaders } });
  } else {
    response = NextResponse.next({ request: { headers: requestHeaders } });
  }

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
