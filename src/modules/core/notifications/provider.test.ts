import { describe, it, expect, afterEach } from 'vitest';
import { getProvider, InAppProvider, ResendEmailProvider } from './provider';

/**
 * Which channels this deployment can actually honour.
 *
 * The rule the whole outbox rests on: a channel with no provider returns null,
 * and the worker records that as a failure naming the channel. It must never
 * fall back to something that reports success — a queue that marks
 * unconfigured mail "sent" tells a shop a customer was informed when nobody
 * was.
 */
const env = process.env as Record<string, string | undefined>;
const saved = { key: env.RESEND_API_KEY, from: env.NOTIFICATION_FROM_EMAIL };

afterEach(() => {
  if (saved.key === undefined) delete env.RESEND_API_KEY;
  else env.RESEND_API_KEY = saved.key;
  if (saved.from === undefined) delete env.NOTIFICATION_FROM_EMAIL;
  else env.NOTIFICATION_FROM_EMAIL = saved.from;
});

describe('getProvider', () => {
  it('delivers in-app notifications, which need no transport', () => {
    expect(getProvider('inapp')).toBeInstanceOf(InAppProvider);
  });

  it('has no email provider until one is configured', () => {
    delete env.RESEND_API_KEY;
    delete env.NOTIFICATION_FROM_EMAIL;
    expect(getProvider('email')).toBeNull();
  });

  it('needs both the key and the from-address, not one of them', () => {
    env.RESEND_API_KEY = 'test-key';
    delete env.NOTIFICATION_FROM_EMAIL;
    expect(getProvider('email')).toBeNull();

    delete env.RESEND_API_KEY;
    env.NOTIFICATION_FROM_EMAIL = 'shop@example.test';
    expect(getProvider('email')).toBeNull();
  });

  it('uses the real mail provider once both are set', () => {
    env.RESEND_API_KEY = 'test-key';
    env.NOTIFICATION_FROM_EMAIL = 'shop@example.test';
    expect(getProvider('email')).toBeInstanceOf(ResendEmailProvider);
  });

  it('has no provider for channels this codebase does not implement', () => {
    // Returning something that silently succeeded would be a lie the shop acts
    // on, so sms and whatsapp have nothing rather than a pretend sender.
    expect(getProvider('sms')).toBeNull();
    expect(getProvider('whatsapp')).toBeNull();
    expect(getProvider('carrier-pigeon')).toBeNull();
  });
});

describe('InAppProvider', () => {
  it('reports the notification itself as the reference', async () => {
    const result = await new InAppProvider().send({
      id: 'abc',
      organizationId: 'org',
      channel: 'inapp',
      template: 'test',
      recipient: null,
      userId: null,
      payload: {},
      attempts: 1,
    });
    expect(result.providerRef).toBe('abc');
  });
});
