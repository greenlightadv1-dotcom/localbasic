/**
 * The click-to-chat link: no WhatsApp Business API, no webhook, nothing this
 * app calls out to. It just opens the guest's own WhatsApp with a message to
 * the branch's own number already typed in. Whether that message actually
 * arrives is between the guest's phone and the branch's WhatsApp — this app
 * only ever sees it through the cashier, who reads their own WhatsApp and
 * marks the order verified from the review queue.
 */
export function buildWhatsAppVerifyUrl(
  whatsappNumber: string | null,
  code: string,
  organizationName: string,
): string | null {
  if (!whatsappNumber) return null;
  const digits = whatsappNumber.replace(/[^\d]/g, '');
  if (!digits) return null;
  const text = `رمز التحقق: ${code}\nطلب جديد من ${organizationName}`;
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}
