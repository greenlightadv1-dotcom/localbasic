import 'server-only';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { renderNotification } from './templates';
import {
  getProvider, PermanentDeliveryError, type Notification,
} from './provider';

/**
 * The notification delivery worker.
 *
 * Claims a batch from the outbox, delivers each row through the provider for
 * its channel, and reports the outcome back. Everything that makes this safe
 * to run twice at once, or to crash halfway through, is in migration 0050:
 * SKIP LOCKED so two workers never take the same row, a lease so a dead
 * worker's rows come back, and backoff so a broken provider is not hammered.
 *
 * This runs with the SERVICE-ROLE client and is reachable only from the server:
 * the route that calls it checks a shared secret, and the three queue functions
 * are granted to `service_role` alone. No credential of any kind reaches a
 * browser.
 */

export type WorkerReport = {
  claimed: number;
  sent: number;
  failed: number;
  /** Channels that had work but no provider configured in this deployment. */
  unconfigured: string[];
};

function rows<T>(data: unknown): T[] {
  return (Array.isArray(data) ? data : data == null ? [] : [data]) as T[];
}

export async function runNotificationWorker(
  options: { limit?: number; leaseSeconds?: number } = {},
): Promise<WorkerReport> {
  const admin = createSupabaseAdminClient();
  const report: WorkerReport = { claimed: 0, sent: 0, failed: 0, unconfigured: [] };

  const { data, error } = await admin.rpc('notification_claim_batch', {
    p_limit: options.limit ?? 25,
    p_lease_secs: options.leaseSeconds ?? 120,
  });
  if (error) throw new Error(`could not claim notifications: ${error.message}`);

  type Row = {
    out_id: string; out_organization: string; out_channel: string;
    out_template: string; out_recipient: string | null; out_user_id: string | null;
    out_payload: Record<string, unknown> | null; out_attempts: number;
  };

  const claimed = rows<Row>(data);
  report.claimed = claimed.length;

  for (const row of claimed) {
    const notification: Notification = {
      id: row.out_id,
      organizationId: row.out_organization,
      channel: row.out_channel,
      template: row.out_template,
      recipient: row.out_recipient,
      userId: row.out_user_id,
      payload: row.out_payload ?? {},
      attempts: Number(row.out_attempts),
    };

    const provider = getProvider(notification.channel);

    if (!provider) {
      // Not a transient failure: no amount of retrying configures a provider.
      // Recorded as failed with the reason, never as sent.
      if (!report.unconfigured.includes(notification.channel)) {
        report.unconfigured.push(notification.channel);
      }
      await admin.rpc('notification_mark_failed', {
        p_id: notification.id,
        p_error: `no provider configured for channel "${notification.channel}"`,
        p_permanent: true,
      });
      report.failed += 1;
      continue;
    }

    try {
      const body = renderNotification(notification.template, notification.payload);
      const result = await provider.send(notification, body);

      await admin.rpc('notification_mark_sent', {
        p_id: notification.id,
        p_provider: provider.key,
        p_provider_ref: result.providerRef,
      });
      report.sent += 1;
    } catch (error) {
      const permanent = error instanceof PermanentDeliveryError;
      await admin.rpc('notification_mark_failed', {
        p_id: notification.id,
        p_error: error instanceof Error ? error.message : 'delivery failed',
        p_permanent: permanent,
      });
      report.failed += 1;
    }
  }

  return report;
}
