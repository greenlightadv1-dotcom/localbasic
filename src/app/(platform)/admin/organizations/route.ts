import { NextResponse, type NextRequest } from 'next/server';
import { getPlatformContext } from '@/modules/platform/admin/context';

/**
 * The customer list moved to /admin/customers.
 *
 * Kept as a redirect rather than deleted: an operator may have the old path
 * bookmarked, and the platform calls these records "customers" everywhere
 * else — the route name was the odd one out.
 *
 * A route handler so this is a real 307, and the search term survives it.
 *
 * Gated like every other /admin surface. A redirect that fires before the
 * check would answer a stranger differently from the rest of the console —
 * telling them this path exists and where it went — which is exactly what the
 * 404-not-403 rule is there to prevent.
 */
export async function GET(request: NextRequest) {
  if (!(await getPlatformContext())) return new NextResponse(null, { status: 404 });

  const to = new URL('/admin/customers', request.nextUrl.origin);
  to.search = request.nextUrl.search;
  return NextResponse.redirect(to, 307);
}
