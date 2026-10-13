import { WHATSAPP_NUMBER } from '@/config/site';

/**
 * The click-to-chat link.
 *
 * The customer taps this, WhatsApp opens with the message already typed
 * against the platform's own central gateway number — never a branch's own
 * public contact number (branding_settings.whatsapp, used elsewhere for
 * "chat with us" links) — and they tap send. From there it is automated
 * (0086/0087): a single self-hosted gateway running on this one number,
 * shared by every tenant, forwards the incoming message to
 * /api/webhooks/whatsapp-verify, which extracts the "VERIFY-<code>" token
 * and advances the matching order, whichever branch it belongs to. No
 * WhatsApp Business API, no Twilio — the gateway is the only moving part
 * this app does not own, and if it is ever down the cashier's own manual
 * "confirm via WhatsApp" button has the same two effects by hand.
 *
 * `code` already carries its branch tag embedded (e.g. "MAIN-483921"),
 * generated server-side at order-placement time, which is how one shared
 * gateway number still resolves to the right branch's pending order.
 */
export function buildWhatsAppVerifyUrl(code: string): string {
  const text = `رمز التحقق الخاص بطلبك:\nVERIFY-${code}`;
  return `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(text)}`;
}
