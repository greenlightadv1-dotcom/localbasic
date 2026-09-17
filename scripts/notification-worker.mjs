#!/usr/bin/env node
/**
 * Run the notification worker on a loop.
 *
 * For a deployment that has a process to spare rather than a cron service.
 * It calls the application's own worker route, so there is exactly one code
 * path delivering notifications and one place the secret is checked.
 *
 *   NOTIFICATION_WORKER_SECRET=... node scripts/notification-worker.mjs
 *
 * Options via environment:
 *   WORKER_URL       default http://localhost:3000/api/worker/notifications
 *   WORKER_INTERVAL  seconds between passes, default 30
 *   WORKER_LIMIT     rows per pass, default 25
 */
const url = process.env.WORKER_URL ?? 'http://localhost:3000/api/worker/notifications';
const interval = Number(process.env.WORKER_INTERVAL ?? 30) * 1000;
const limit = Number(process.env.WORKER_LIMIT ?? 25);
const secret = process.env.NOTIFICATION_WORKER_SECRET;

if (!secret) {
  console.error('NOTIFICATION_WORKER_SECRET is required.');
  process.exit(1);
}

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  // Finish the pass in flight rather than abandoning claimed rows mid-send.
  process.on(signal, () => { stopping = true; });
}

async function pass() {
  try {
    const response = await fetch(`${url}?limit=${limit}`, {
      method: 'POST',
      headers: { 'x-worker-secret': secret },
    });
    if (!response.ok) {
      console.error(`worker responded ${response.status}`);
      return;
    }
    const report = await response.json();
    if (report.claimed > 0) {
      console.log(
        `claimed ${report.claimed}, sent ${report.sent}, failed ${report.failed}` +
          (report.unconfigured?.length ? ` — no provider for: ${report.unconfigured.join(', ')}` : ''),
      );
    }
  } catch (error) {
    // A pass that cannot reach the app is not fatal: the lease returns the
    // rows to the queue and the next pass picks them up.
    console.error('worker pass failed:', error.message);
  }
}

while (!stopping) {
  await pass();
  if (stopping) break;
  await new Promise((resolve) => setTimeout(resolve, interval));
}
