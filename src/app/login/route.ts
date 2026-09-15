import { NextResponse, type NextRequest } from 'next/server';

/**
 * `/login` is the address the marketing site advertises; `/sign-in` is where
 * the auth flow lives.
 *
 * A route handler rather than a page calling redirect(): from a page, Next
 * falls back to a `<meta http-equiv="refresh">` once streaming has begun, which
 * flashes the not-found page for a second before moving. This sends a real 307.
 */
export function GET(request: NextRequest) {
  return NextResponse.redirect(new URL('/sign-in', request.nextUrl.origin), 307);
}
