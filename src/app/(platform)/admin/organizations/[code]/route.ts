import { NextResponse, type NextRequest } from 'next/server';
import { getPlatformContext } from '@/modules/platform/admin/context';

/**
 * See ../route.ts — the customer profile moved to /admin/customers/<code>.
 * Gated the same way, so the redirect does not confirm the path to someone who
 * may not see the console.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { code: string } },
) {
  if (!(await getPlatformContext())) return new NextResponse(null, { status: 404 });

  const to = new URL(
    `/admin/customers/${encodeURIComponent(params.code)}`,
    request.nextUrl.origin,
  );
  to.search = request.nextUrl.search;
  return NextResponse.redirect(to, 307);
}
