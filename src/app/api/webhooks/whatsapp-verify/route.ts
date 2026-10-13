import { NextResponse, type NextRequest } from 'next/server';
import { verifyFromWhatsAppWebhook } from '@/modules/restaurant/guest-verification/service';

/**
 * Where the WhatsApp gateway forwards every incoming message it receives on
 * the platform's central number. Built against WasenderApi (a hosted
 * Baileys-based gateway), which signs requests with a literal shared-secret
 * header rather than Meta Cloud API or Twilio — but the payload parsing
 * below also accepts a flatter {sender|phone, message|text} body, so a
 * different or custom gateway script still works without changes here.
 *
 * WasenderApi's own shape (see their webhook docs):
 *   { event: 'messages.received', data: { messages: { key: {...}, messageBody, message: { conversation } } } }
 *   { event: 'messages.upsert',   data: { messages: [ {...} ] } }   // array, incoming + outgoing
 * Any other `event` (session.status, qrcode.updated, messages.update, ...)
 * is acknowledged and ignored.
 *
 * Authorization is a shared secret. WasenderApi sends it as
 * `X-Webhook-Signature` (see their webhook-setup docs — despite the name, it
 * is a literal secret compare, not an HMAC); `x-webhook-secret` and a bearer
 * `Authorization` header are also accepted for a custom gateway script.
 * Without WHATSAPP_WEBHOOK_SECRET set, nothing here can run at all, and a
 * wrong or missing header gets the same 404 an unrelated URL would, so a
 * prober learns nothing about what lives here.
 *
 * The code itself never trusts the sender or message beyond this: matching
 * happens entirely inside restaurant_whatsapp_verify_webhook, against a
 * specific pending_verification order's own stored code, expiry and phone —
 * a forged or stray message that doesn't match one just does nothing.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const LOG_PREFIX = '[whatsapp-verify]';

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

type ParsedIncoming = { phone: string; text: string };

/**
 * One WasenderApi message entry (the shape nested inside `data.messages`,
 * whether that is a single object — messages.received — or an array of them
 * — messages.upsert, which also carries fromMe: true for our own replies).
 */
type WasenderMessage = {
  key?: {
    fromMe?: boolean;
    remoteJid?: string;
    senderPn?: string;
    cleanedSenderPn?: string;
  };
  messageBody?: string;
  message?: { conversation?: string };
};

/** Strips the `@s.whatsapp.net` / `@lid` suffix WhatsApp JIDs carry. */
function phoneFromJid(jid: string | undefined): string {
  if (!jid) return '';
  return jid.split('@')[0] ?? '';
}

function parseWasenderMessage(m: WasenderMessage): ParsedIncoming | null {
  if (m.key?.fromMe) return null; // our own outgoing message, not a customer reply
  const phone = m.key?.cleanedSenderPn || phoneFromJid(m.key?.senderPn) || phoneFromJid(m.key?.remoteJid);
  const text = m.messageBody ?? m.message?.conversation ?? '';
  return { phone, text };
}

/**
 * Normalizes whatever the gateway sent into a flat list of (phone, text)
 * pairs to check for a verification code — WasenderApi's nested `data.
 * messages` (object or array), or the flatter generic shape a custom script
 * might send instead.
 */
function parseIncoming(body: Record<string, unknown>): ParsedIncoming[] {
  const event = typeof body.event === 'string' ? body.event : null;
  const data = body.data as Record<string, unknown> | undefined;

  if (event && data && 'messages' in data) {
    if (event !== 'messages.received' && event !== 'messages.upsert') {
      console.log(`${LOG_PREFIX} ignoring event type`, event);
      return [];
    }
    const raw = data.messages;
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    return list
      .map((m) => parseWasenderMessage(m as WasenderMessage))
      .filter((m): m is ParsedIncoming => m !== null);
  }

  // Flatter shape: { sender|phone, message|text } at the top level.
  const phone = String(body.sender ?? body.phone ?? '').trim();
  const text = String(body.message ?? body.text ?? '').trim();
  return phone || text ? [{ phone, text }] : [];
}

export async function POST(request: NextRequest) {
  const expected = process.env.WHATSAPP_WEBHOOK_SECRET;
  if (!expected) {
    console.log(`${LOG_PREFIX} rejected: WHATSAPP_WEBHOOK_SECRET is not set`);
    return NextResponse.json({ error: 'webhook is not configured' }, { status: 503 });
  }

  const provided =
    request.headers.get('x-webhook-signature') ??
    request.headers.get('x-webhook-secret') ??
    request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
    '';
  if (!secretMatches(provided, expected)) {
    console.log(`${LOG_PREFIX} rejected: secret header missing or mismatched`);
    return new NextResponse(null, { status: 404 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    console.log(`${LOG_PREFIX} rejected: body is not valid JSON`);
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  if (typeof body !== 'object' || body === null) {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const row = body as Record<string, unknown>;
  const candidates = parseIncoming(row);
  console.log(`${LOG_PREFIX} event=%s candidates=%d`, row.event ?? '(none)', candidates.length);

  for (const { phone, text } of candidates) {
    const match = VERIFY_PATTERN.exec(text);
    if (!phone || !match) {
      // Not every forwarded message is a verification code — a greeting, a
      // question, whatever else lands in that WhatsApp number's inbox. Not an
      // error; there is simply nothing for this route to do with it.
      console.log(`${LOG_PREFIX} no code in message`, { phone: phone || '(none)', hasText: Boolean(text) });
      continue;
    }

    const [, branchCodeRaw, code] = match;
    console.log(`${LOG_PREFIX} extracted code`, { phone, branchCode: branchCodeRaw, code });

    try {
      const result = await verifyFromWhatsAppWebhook(branchCodeRaw!, code!, phone);
      console.log(`${LOG_PREFIX} rpc result`, result);
      if (result.matched) {
        return NextResponse.json({ ok: true, matched: true, orderNumber: result.orderNumber });
      }
    } catch (error) {
      console.error(`${LOG_PREFIX} rpc error`, error);
      return NextResponse.json({ error: 'verification failed' }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: true, matched: false });
}
