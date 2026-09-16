import { NextResponse, type NextRequest } from 'next/server';

/**
 * The customer list moved to /admin/customers.
 *
 * Kept as a redirect rather than deleted: an operator may have the old path
 * bookmarked, and the platform calls these records "customers" everywhere
 * else — the route name was the odd one out.
 *
 * A route handler so this is a real 307, and the search term survives it.
 */
export function GET(request: NextRequest) {
  const to = new URL('/admin/customers', request.nextUrl.origin);
  to.search = request.nextUrl.search;
  return NextResponse.redirect(to, 307);
}
