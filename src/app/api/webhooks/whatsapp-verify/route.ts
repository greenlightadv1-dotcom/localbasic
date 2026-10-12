import { NextResponse, type NextRequest } from 'next/server';
import { verifyFromWhatsAppWebhook } from '@/modules/restaurant/guest-verification/service';

/**
 * Where a self-hosted WhatsApp gateway (Evolution API / Baileys, linked by
 * QR code to the branch's own number) forwards every incoming message it
 * receives. No Meta Cloud API, no Twilio — this route is the only thing
 * that has to agree with whatever script runs the gateway, and the contract
 * is deliberately small: a JSON body naming a sender and a message.
 *
 * Authorization is a shared secret, the same constant-time-compare /
 * closed-by-default pattern the notification worker's trigger route already
 * uses — without WHATSAPP_WEBHOOK_SECRET set, nothing here can run at all,
 * and a wrong or missing header gets the same 404 an unrelated URL would,
 * so a prober learns nothing about what lives here.
 *
 * The code itself never trusts the sender or message beyond this: matching
 * happens entirely inside restaurant_whatsapp_verify_webhook, against a
 * specific pending_verification order's own stored code, expiry and phone —
 * a forged or stray message that doesn't match one just does nothing.
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

/** VERIFY-<branch code>-<numeric code>, case-insensitive, wherever it sits in the text. */
const VERIFY_PATTERN = /VERIFY-([A-Za-z0-9]+)-(\d{4,10})/i;

export async function POST(request: NextRequest) {
  const expected = process.env.WHATSAPP_WEBHOOK_SECRET;
  if (!expected) {
    return NextResponse.json({ error: 'webhook is not configured' }, { status: 503 });
  }

  const provided =
    request.headers.get('x-webhook-secret') ??
    request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
    '';
  if (!secretMatches(provided, expected)) {
    return new NextResponse(null, { status: 404 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  if (typeof body !== 'object' || body === null) {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const row = body as Record<string, unknown>;
  const phone = String(row.sender ?? row.phone ?? '').trim();
  const text = String(row.message ?? row.text ?? '').trim();

  const match = VERIFY_PATTERN.exec(text);
  if (!phone || !match) {
    // Not every forwarded message is a verification code — a greeting, a
    // question, whatever else lands in that WhatsApp number's inbox. Not an
    // error; there is simply nothing for this route to do with it.
    return NextResponse.json({ ok: true, matched: false });
  }

  const [, branchCodeRaw, code] = match;

  try {
    const result = await verifyFromWhatsAppWebhook(branchCodeRaw!, code!, phone);
    return NextResponse.json({ ok: true, matched: result.matched, orderNumber: result.orderNumber });
  } catch (error) {
    console.error('[localbasic] whatsapp-verify webhook', error);
    return NextResponse.json({ error: 'verification failed' }, { status: 500 });
  }
}
