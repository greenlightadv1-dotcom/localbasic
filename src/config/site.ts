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

/**
 * Account creation and owner password recovery both go through the platform's
 * own WhatsApp line (the same number as sales) — there is no self-service
 * sign-up or email reset for restaurants.
 */
export const ACCOUNT_WHATSAPP_MESSAGES = {
  createAccount: 'مرحباً، أريد إنشاء حساب جديد وشراء الخدمة لمنشأتي',
  forgotPassword: (username?: string) =>
    `مرحباً، نسيت كلمة المرور لحساب المطعم الخاص بي. اسم المستخدم: ${username?.trim() || ''}`.trimEnd(),
} as const;

export const WHATSAPP_MESSAGES = {
  general: 'السلام عليكم، أرغب في معرفة المزيد عن Local Basic.',
  restaurant: 'السلام عليكم، مهتم بنظام إدارة المطاعم والكافيهات من Local Basic.',
  demo: 'السلام عليكم، أرغب في حجز عرض توضيحي لنظام Local Basic.',
  restaurantDemo: 'السلام عليكم، أرغب في حجز عرض توضيحي لنظام المطاعم والكافيهات.',
  retail: 'السلام عليكم، مهتم بنظام المتاجر والتجزئة من Local Basic (نقطة بيع، باركود، مخزون).',
  clinic: 'السلام عليكم، مهتم بنظام العيادات من Local Basic (مواعيد، ملف المريض، روشتات).',
} as const;

/** The sector service pages, in the order every menu lists them. */
export const SITE_SERVICES = [
  { href: '/services/restaurant', key: 'restaurant', label: 'المطاعم والكافيهات', description: 'الطاولات، شاشة المطبخ، الدليفري، الإضافات' },
  { href: '/services/retail', key: 'retail', label: 'المتاجر والتجزئة', description: 'باركود وميزان، عروض، تحويل بين الفروع، إعادة الطلب' },
  { href: '/services/clinic', key: 'clinic', label: 'العيادات الطبية', description: 'المواعيد، ملف المريض، الروشتة على واتساب' },
] as const;

export type SiteNavItem = {
  href: string;
  label: string;
  /** A group: shown as a dropdown on desktop and inline on the mobile strip. */
  children?: readonly { href: string; key: string; label: string; description: string }[];
};

export const SITE_NAV: readonly SiteNavItem[] = [
  { href: '/', label: 'الرئيسية' },
  { href: '/services', label: 'الخدمات', children: SITE_SERVICES },
  { href: '/about', label: 'من نحن' },
  { href: '/contact', label: 'تواصل معنا' },
];
