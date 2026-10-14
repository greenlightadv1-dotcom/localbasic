/**
 * WhatsApp offers: turn a stored phone number into a wa.me number, fill a
 * message template with the customer's details, and build the deep link.
 * Pure, so the number handling (the part that is easy to get silently wrong
 * and message the wrong person) is tested.
 */

/** Country calling codes by store currency — where the store's customers live. */
const DIAL_CODE_BY_CURRENCY: Record<string, string> = {
  EGP: '20', SAR: '966', AED: '971', KWD: '965', QAR: '974', BHD: '973',
  OMR: '968', JOD: '962', LBP: '961', IQD: '964', MAD: '212', TND: '216',
  DZD: '213', LYD: '218', SDG: '249', USD: '1',
};

/**
 * "01012345678" → "201012345678" (wa.me wants the full international number,
 * digits only, no "+" or leading zeros). Numbers already written with a "+" or
 * "00" prefix are taken as international. Returns null for anything that cannot
 * be a phone number, so the caller can refuse instead of messaging nobody.
 */
export function toWhatsAppNumber(phone: string, currency = 'EGP'): string | null {
  const raw = phone.trim();
  let digits = raw.replace(/\D/g, '');
  if (digits.length < 7) return null;

  const dial = DIAL_CODE_BY_CURRENCY[currency.toUpperCase()] ?? '20';
  if (raw.startsWith('+')) {
    // already international
  } else if (digits.startsWith('00')) {
    digits = digits.slice(2);
  } else if (digits.startsWith('0')) {
    digits = dial + digits.slice(1);
  } else if (!digits.startsWith(dial) && digits.length <= 10) {
    // A national number written without its leading zero.
    digits = dial + digits;
  }
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

export type OfferTemplate = { id: string; label: string; body: string };

/** Variables a template may use; replaced when the message is built. */
export const OFFER_VARIABLES = [
  { token: '{الاسم}', hint: 'اسم العميل' },
  { token: '{المتجر}', hint: 'اسم المتجر' },
  { token: '{النقاط}', hint: 'رصيد نقاطه' },
  { token: '{الرابط}', hint: 'رابط المتجر أو الكوبون' },
] as const;

export const OFFER_TEMPLATES: OfferTemplate[] = [
  {
    id: 'offer',
    label: 'عرض خاص',
    body: 'أهلاً {الاسم} 👋\nعندنا لك عرض خاص من {المتجر} 🎁\nاطلب الآن: {الرابط}',
  },
  {
    id: 'winback',
    label: 'وحشتنا',
    body: 'أهلاً {الاسم}، وحشتنا في {المتجر} 💚\nجهّزنا لك مفاجأة عند طلبك القادم.\n{الرابط}',
  },
  {
    id: 'points',
    label: 'نقاطك',
    body: 'أهلاً {الاسم} ✨\nرصيدك عندنا {النقاط} نقطة، استبدلها بخصم على طلبك القادم من {المتجر}.\n{الرابط}',
  },
];

export function buildOfferMessage(
  body: string,
  vars: { name: string; store: string; points: number | null; link: string | null },
): string {
  const firstName = vars.name.trim().split(/\s+/)[0] || 'عزيزنا';
  const filled = body
    .split('{الاسم}').join(firstName)
    .split('{المتجر}').join(vars.store)
    .split('{النقاط}').join(vars.points === null ? '' : String(vars.points))
    .split('{الرابط}').join(vars.link ?? '');
  // An unused link variable leaves blank lines behind; tidy them.
  return filled.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** wa.me links break past a few thousand characters; WhatsApp itself caps lower. */
export const MAX_OFFER_LENGTH = 1000;

export function whatsappOfferUrl(phone: string, message: string, currency = 'EGP'): string | null {
  const number = toWhatsAppNumber(phone, currency);
  const text = message.trim();
  if (!number || !text || text.length > MAX_OFFER_LENGTH) return null;
  return `https://wa.me/${number}?text=${encodeURIComponent(text)}`;
}
