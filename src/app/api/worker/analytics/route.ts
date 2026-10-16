import { NextResponse, type NextRequest } from 'next/server';
import { runAnalyticsWorker } from '@/modules/restaurant/analytics/service';

/**
 * The analytics worker's trigger (0110): automatic customer re-engagement for
 * organizations that switched it on, at most once a day each. Meant for a
 * scheduler (a daily cron) and nobody else — no organization in the URL, no
 * session read. Same shared-secret rule as the notification worker: closed
 * until ANALYTICS_WORKER_SECRET (or NOTIFICATION_WORKER_SECRET) is set, 404
 * for a wrong secret. The database function is granted to service_role alone.
 *
 * Margin alerts need no schedule: database triggers raise them the moment an
 * ingredient's cost, a price or a recipe changes.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function secretMatches(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i += 1) diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

async function handle(request: NextRequest) {
  const expected = process.env.ANALYTICS_WORKER_SECRET ?? process.env.NOTIFICATION_WORKER_SECRET;
  if (!expected) return NextResponse.json({ error: 'worker is not configured' }, { status: 503 });
  const provided = request.headers.get('x-worker-secret') ?? request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  if (!secretMatches(provided, expected)) return new NextResponse(null, { status: 404 });
  try {
    const report = await runAnalyticsWorker();
    return NextResponse.json(report, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    console.error('[localbasic] analytics worker', error);
    return NextResponse.json({ error: 'worker failed' }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
