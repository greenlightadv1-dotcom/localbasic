/**
 * Public marketing site configuration.
 *
 * Contact details live here rather than scattered through the pages so a sales
 * number or address changes in one place. Nothing here is a secret — every
 * value is rendered into the public HTML.
 */

/**
 * Sales WhatsApp number in international format, digits only — no `+`, no
 * spaces, no leading zero. wa.me rejects anything else, so the formatting is
 * enforced here rather than at each of the seven call sites.
 *
 * +20 104 116 5669  →  201041165669
 */
export const WHATSAPP_NUMBER = process.env.NEXT_PUBLIC_WHATSAPP_NUMBER ?? '201041165669';

export const CONTACT_EMAIL =
  process.env.NEXT_PUBLIC_CONTACT_EMAIL ?? 'local.basic@greenlightadvs.com';

/** The number as a human reads it, for display next to the link. */
export const WHATSAPP_DISPLAY = '+20 104 116 5669';

/** Builds a wa.me link with a prefilled Arabic message. */
export function whatsappLink(message: string): string {
  return `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(message)}`;
}

export const WHATSAPP_MESSAGES = {
  general: 'السلام عليكم، أرغب في معرفة المزيد عن Local Basic.',
  restaurant: 'السلام عليكم، مهتم بنظام إدارة المطاعم والكافيهات من Local Basic.',
  demo: 'السلام عليكم، أرغب في حجز عرض توضيحي لنظام المطاعم.',
} as const;

export const SITE_NAV = [
  { href: '/', label: 'الرئيسية' },
  { href: '/services', label: 'الخدمات' },
  { href: '/services/restaurant', label: 'المطاعم والكافيهات' },
  { href: '/about', label: 'من نحن' },
  { href: '/contact', label: 'تواصل معنا' },
] as const;
