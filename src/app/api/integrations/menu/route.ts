import { NextResponse, type NextRequest } from 'next/server';
import { intakeMenu } from '@/modules/restaurant/integrations/service';
import { bearerKey, throttled, unauthorized } from '../_auth';

/** GET /api/integrations/menu — the sellable variants (ids and prices) for the key's branch. */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const key = bearerKey(req);
  if (!key) return unauthorized();
  const limited = throttled(key, 30);
  if (limited) return limited;
  const r = await intakeMenu(key);
  return NextResponse.json(r.body, { status: r.status, headers: { 'cache-control': 'no-store' } });
}
