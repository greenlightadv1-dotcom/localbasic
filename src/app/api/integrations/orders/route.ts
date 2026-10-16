import { NextResponse, type NextRequest } from 'next/server';
import { intakeOrder, intakeOrderSchema } from '@/modules/restaurant/integrations/service';
import { bearerKey, throttled, unauthorized } from '../_auth';

/**
 * Standard order intake for web/app channels and aggregators.
 *
 *   POST /api/integrations/orders
 *   Authorization: Bearer lbk_…
 *   { external_id, type, customer{name,phone}, delivery{address,…}, items[{variant_id,quantity,modifier_ids?,note?}], note?, paid?, total_cents? }
 *
 * Prices come from this restaurant's menu, never from the payload; the
 * sender's total is kept for reconciliation. Re-sending the same external_id
 * returns the first order (duplicate: true) instead of cooking it twice.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const key = bearerKey(req);
  if (!key) return unauthorized();
  const limited = throttled(key, 120);
  if (limited) return limited;

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid json' }, { status: 400 }); }

  const parsed = intakeOrderSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid payload', issues: parsed.error.flatten().fieldErrors }, { status: 422 });
  }
  const r = await intakeOrder(key, parsed.data);
  return NextResponse.json(r.body, { status: r.status });
}
