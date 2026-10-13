import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const verifyFromWhatsAppWebhook = vi.fn(
  async (_branchCode: string, _code: string, _phone: string): Promise<{ matched: boolean; orderNumber: string | null }> =>
    ({ matched: false, orderNumber: null }),
);
vi.mock('@/modules/restaurant/guest-verification/service', () => ({
  verifyFromWhatsAppWebhook: (...args: [string, string, string]) => verifyFromWhatsAppWebhook(...args),
}));

import { POST } from './route';

const SECRET = 'wasender-shared-secret';
const ORIGINAL_SECRET = process.env.WHATSAPP_WEBHOOK_SECRET;

function call(body: unknown, headers: Record<string, string> = { 'x-webhook-signature': SECRET }) {
  return POST(
    new NextRequest('https://localbasic.vercel.app/api/webhooks/whatsapp-verify', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.WHATSAPP_WEBHOOK_SECRET = SECRET;
  verifyFromWhatsAppWebhook.mockResolvedValue({ matched: true, orderNumber: '000123' });
});

afterEach(() => {
  process.env.WHATSAPP_WEBHOOK_SECRET = ORIGINAL_SECRET;
});

describe('POST /api/webhooks/whatsapp-verify', () => {
  it('is invisible when the webhook secret is not configured', async () => {
    delete process.env.WHATSAPP_WEBHOOK_SECRET;
    const response = await call({ event: 'messages.received', data: { messages: {} } });
    expect(response.status).toBe(503);
    expect(verifyFromWhatsAppWebhook).not.toHaveBeenCalled();
  });

  it.each([
    ['a wrong secret', { 'x-webhook-signature': 'wrong' }],
    ['no secret header at all', {}],
  ])('refuses %s', async (_label, headers) => {
    const response = await call({ event: 'messages.received', data: { messages: {} } }, headers);
    expect(response.status).toBe(404);
    expect(verifyFromWhatsAppWebhook).not.toHaveBeenCalled();
  });

  it('accepts the secret via x-webhook-secret too, for a custom gateway script', async () => {
    const response = await call(
      { sender: '201099998888', message: 'VERIFY-MAIN-483921' },
      { 'x-webhook-secret': SECRET },
    );
    expect(response.status).toBe(200);
    expect(verifyFromWhatsAppWebhook).toHaveBeenCalledWith('MAIN', '483921', '201099998888');
  });

  it('accepts the secret via a bearer Authorization header too', async () => {
    const response = await call(
      { sender: '201099998888', message: 'VERIFY-MAIN-483921' },
      { authorization: `Bearer ${SECRET}` },
    );
    expect(response.status).toBe(200);
    expect(verifyFromWhatsAppWebhook).toHaveBeenCalledWith('MAIN', '483921', '201099998888');
  });

  it("parses WasenderApi's messages.received payload (single message object)", async () => {
    const response = await call({
      event: 'messages.received',
      data: {
        messages: {
          key: {
            fromMe: false,
            remoteJid: '201099998888@s.whatsapp.net',
            senderPn: '201099998888@s.whatsapp.net',
            cleanedSenderPn: '201099998888',
          },
          messageBody: 'VERIFY-MAIN-483921',
          message: { conversation: 'VERIFY-MAIN-483921' },
        },
      },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, matched: true, orderNumber: '000123' });
    expect(verifyFromWhatsAppWebhook).toHaveBeenCalledWith('MAIN', '483921', '201099998888');
  });

  it("parses WasenderApi's messages.upsert payload (array, skipping fromMe)", async () => {
    const response = await call({
      event: 'messages.upsert',
      data: {
        messages: [
          {
            key: { fromMe: true, remoteJid: '201041165669@s.whatsapp.net' },
            messageBody: 'شكرًا لتواصلكم معنا',
          },
          {
            key: { fromMe: false, cleanedSenderPn: '201099998888', remoteJid: '201099998888@s.whatsapp.net' },
            message: { conversation: 'VERIFY-MAIN-483921' },
          },
        ],
      },
    });
    expect(response.status).toBe(200);
    expect(verifyFromWhatsAppWebhook).toHaveBeenCalledTimes(1);
    expect(verifyFromWhatsAppWebhook).toHaveBeenCalledWith('MAIN', '483921', '201099998888');
  });

  it('falls back to a bare JID when cleanedSenderPn is absent', async () => {
    await call({
      event: 'messages.received',
      data: {
        messages: {
          key: { fromMe: false, remoteJid: '201099998888@s.whatsapp.net' },
          messageBody: 'VERIFY-MAIN-483921',
        },
      },
    });
    expect(verifyFromWhatsAppWebhook).toHaveBeenCalledWith('MAIN', '483921', '201099998888');
  });

  it('ignores a non-message event type without error', async () => {
    const response = await call({ event: 'session.status', data: { status: 'connected' } });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, matched: false });
    expect(verifyFromWhatsAppWebhook).not.toHaveBeenCalled();
  });

  it('reports no match for a message with no verification code', async () => {
    const response = await call({ sender: '201099998888', message: 'هل عندكم توصيل؟' });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, matched: false });
    expect(verifyFromWhatsAppWebhook).not.toHaveBeenCalled();
  });

  it('surfaces an RPC failure as a 500', async () => {
    verifyFromWhatsAppWebhook.mockRejectedValueOnce(new Error('db unreachable'));
    const response = await call({ sender: '201099998888', message: 'VERIFY-MAIN-483921' });
    expect(response.status).toBe(500);
  });

  it('rejects a non-JSON body', async () => {
    const response = await POST(
      new NextRequest('https://localbasic.vercel.app/api/webhooks/whatsapp-verify', {
        method: 'POST',
        headers: { 'x-webhook-signature': SECRET },
        body: 'not json',
      }),
    );
    expect(response.status).toBe(400);
  });
});
