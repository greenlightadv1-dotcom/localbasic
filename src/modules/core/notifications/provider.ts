import 'server-only';

/**
 * The notification delivery boundary.
 *
 * LocalBasic's outbox has always been honest that it is only an outbox: four
 * migrations enqueue into it and nothing claimed to deliver. This is where
 * delivery becomes real, and it stays honest in one specific way — a channel
 * with no provider configured is reported as FAILED with the reason, never as
 * sent. A queue that marks unconfigured mail "sent" is worse than one that
 * never ran, because it tells the shop a customer was told something.
 *
 * What a provider may not do:
 *   * report success it did not get. `send` returns a reference the provider
 *     gave, or throws. There is no third answer.
 *   * retry. Backoff belongs to the queue (migration 0050), which knows how
 *     many attempts a row has already had.
 */

export type Notification = {
  id: string;
  organizationId: string;
  channel: string;
  template: string;
  recipient: string | null;
  userId: string | null;
  payload: Record<string, unknown>;
  attempts: number;
};

export type DeliveryResult = {
  /** Whatever the provider calls the message it accepted, for tracing. */
  providerRef: string | null;
};

export class PermanentDeliveryError extends Error {
  readonly permanent = true;
}

export type NotificationProvider = {
  readonly key: string;
  send(notification: Notification, body: RenderedMessage): Promise<DeliveryResult>;
};

export type RenderedMessage = { subject: string; text: string };

/**
 * In-app notifications are delivered by existing.
 *
 * The row is already readable by its recipient through the RLS policy in
 * 0007, so there is nothing to transmit — marking it sent is the truthful
 * record of that. This is not a stub: it is what in-app delivery IS.
 */
export class InAppProvider implements NotificationProvider {
  readonly key = 'inapp';

  async send(notification: Notification): Promise<DeliveryResult> {
    return { providerRef: notification.id };
  }
}

/**
 * Email over Resend's HTTP API.
 *
 * Active only when RESEND_API_KEY and NOTIFICATION_FROM_EMAIL are both set in
 * the SERVER environment. Unset, `getProvider` does not return this at all and
 * the queue records the channel as unconfigured — so a deployment without mail
 * credentials never appears to have sent mail.
 */
export class ResendEmailProvider implements NotificationProvider {
  readonly key = 'email';

  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(notification: Notification, body: RenderedMessage): Promise<DeliveryResult> {
    if (!notification.recipient) {
      // No address will ever appear on this row; retrying cannot help.
      throw new PermanentDeliveryError('the notification has no recipient address');
    }

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: this.from,
        to: [notification.recipient],
        subject: body.subject,
        text: body.text,
      }),
      // A stuck provider must not hold the worker's lease open.
      signal: AbortSignal.timeout(10_000),
    });

    if (response.status === 422 || response.status === 400) {
      // The address or the payload is wrong. Sending it again changes nothing.
      throw new PermanentDeliveryError(`rejected by the mail provider (${response.status})`);
    }
    if (!response.ok) {
      // Rate limits, outages: worth another attempt later.
      throw new Error(`mail provider returned ${response.status}`);
    }

    const data = (await response.json().catch(() => ({}))) as { id?: string };
    return { providerRef: data.id ?? null };
  }
}

/**
 * Which provider handles a channel in THIS deployment.
 *
 * Returns null when nothing is configured, and the worker records that as a
 * permanent failure naming the channel — an operator reading the queue can see
 * exactly what is missing.
 */
export function getProvider(channel: string): NotificationProvider | null {
  if (channel === 'inapp') return new InAppProvider();

  if (channel === 'email') {
    const key = process.env.RESEND_API_KEY;
    const from = process.env.NOTIFICATION_FROM_EMAIL;
    // Both, or neither. A key with no from-address cannot send.
    if (key && from) return new ResendEmailProvider(key, from);
    return null;
  }

  // sms and whatsapp: no provider exists in this codebase, and inventing one
  // that silently succeeds would be a lie the shop acts on.
  return null;
}
