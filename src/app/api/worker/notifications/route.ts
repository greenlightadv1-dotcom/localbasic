import { NextResponse, type NextRequest } from 'next/server';
import { runNotificationWorker } from '@/modules/core/notifications/worker';

/**
 * The notification worker's trigger.
 *
 * Meant for a scheduler — a Vercel cron entry, a container's timer, or the
 * `scripts/notification-worker.mjs` loop — and for nobody else. It is not a
 * tenant surface: there is no organization in the URL and no session is read.
 *
 * Authorization is a shared secret compared in constant time, held server-side
 * only. Without NOTIFICATION_WORKER_SECRET set the route refuses every call
 * rather than defaulting open, so a deployment that forgot to configure it has
 * a queue that does not run instead of one anybody can drive.
 *
 * The queue functions this reaches are granted to `service_role` alone, so even
 * a leaked URL cannot be used from a browser session.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Length-safe, branch-free comparison. A === would leak the prefix length. */
function secretMatches(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i += 1) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

async function handle(request: NextRequest) {
  const expected = process.env.NOTIFICATION_WORKER_SECRET;
  if (!expected) {
    // Closed by default. A queue that does not run is recoverable; a queue
    // anyone can drive is not.
    return NextResponse.json({ error: 'worker is not configured' }, { status: 503 });
  }

  const provided =
    request.headers.get('x-worker-secret') ??
    request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
    '';

  if (!secretMatches(provided, expected)) {
    // 404, not 401: an unauthenticated prober learns nothing about what lives
    // here, the same answer the rest of the platform gives.
    return new NextResponse(null, { status: 404 });
  }

  const limit = Number(request.nextUrl.searchParams.get('limit') ?? '25');

  try {
    const report = await runNotificationWorker({
      limit: Number.isFinite(limit) ? limit : 25,
    });
    return NextResponse.json(report, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    console.error('[localbasic] notification worker', error);
    // The reason stays in the server log. A caller holding the secret still
    // does not need the internals of a database error.
    return NextResponse.json({ error: 'worker run failed' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  return handle(request);
}

/** GET as well, because most schedulers only issue one. */
export async function GET(request: NextRequest) {
  return handle(request);
}
