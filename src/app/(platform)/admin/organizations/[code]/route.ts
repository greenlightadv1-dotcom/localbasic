import { NextResponse, type NextRequest } from 'next/server';

/** See ../route.ts — the customer profile moved to /admin/customers/<code>. */
export function GET(request: NextRequest, { params }: { params: { code: string } }) {
  const to = new URL(
    `/admin/customers/${encodeURIComponent(params.code)}`,
    request.nextUrl.origin,
  );
  to.search = request.nextUrl.search;
  return NextResponse.redirect(to, 307);
}
