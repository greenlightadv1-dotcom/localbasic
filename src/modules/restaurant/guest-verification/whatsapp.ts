/**
 * The click-to-chat link.
 *
 * The customer taps this, WhatsApp opens with the message already typed
 * against the branch's own number, and they tap send. From there it is
 * automated (0086/0087): a self-hosted gateway running on that number
 * forwards the incoming message to /api/webhooks/whatsapp-verify, which
 * extracts the "VERIFY-<code>" token and advances the matching order. No
 * WhatsApp Business API, no Twilio — the gateway is the only moving part
 * this app does not own, and if it is ever down the cashier's own manual
 * "confirm via WhatsApp" button has the same two effects by hand.
 *
 * `code` already carries its branch tag embedded (e.g. "MAIN-483921"),
 * generated server-side at order-placement time — nothing here needs to
 * know the branch's slug to construct it.
 */
export function buildWhatsAppVerifyUrl(whatsappNumber: string | null, code: string): string | null {
  if (!whatsappNumber) return null;
  const digits = whatsappNumber.replace(/[^\d]/g, '');
  if (!digits) return null;
  const text = `رمز التحقق الخاص بطلبك:\nVERIFY-${code}`;
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}
