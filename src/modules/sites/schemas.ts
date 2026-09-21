import { z } from 'zod';

/**
 * The section types the renderer can draw.
 *
 * Kept in lockstep with the check constraint on site_sections.section_type in
 * migration 0055. The database refuses anything outside this list, so the
 * renderer never meets a block it has no case for — but the constant lives
 * here too, so TypeScript catches a mismatch before PostgreSQL has to.
 */
export const SECTION_TYPES = [
  'hero',
  'about',
  'services',
  'testimonials',
  'contact',
  'footer',
] as const;

export type SectionType = (typeof SECTION_TYPES)[number];

export const SITE_STATUSES = ['draft', 'published'] as const;
export type SiteStatus = (typeof SITE_STATUSES)[number];

/** Arabic labels for the section types, for the details screen. */
export const SECTION_LABELS: Record<SectionType, string> = {
  hero: 'الواجهة',
  about: 'من نحن',
  services: 'الخدمات',
  testimonials: 'آراء العملاء',
  contact: 'تواصل معنا',
  footer: 'التذييل',
};

/**
 * The slug rule, matching the check constraint on sites.slug exactly.
 * Lowercase, digits and hyphens; no leading or trailing hyphen; 3–50 total.
 */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;

export const createSiteSchema = z.object({
  name: z.string().trim().min(2, 'الاسم حرفان على الأقل').max(120, 'الاسم طويل جدًا'),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(SLUG_RE, 'حروف إنجليزية صغيرة وأرقام وشرطات فقط، من ٣ إلى ٥٠ حرفًا'),
});

export type CreateSiteInput = z.infer<typeof createSiteSchema>;

/** Turns a display name into a candidate slug. Empty when nothing survives. */
export function suggestSiteSlug(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    // Separators become hyphens FIRST. Stripping unsupported characters
    // before this point would delete the underscore in `Cafe_2024` and run
    // the words together as `cafe2024`.
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return SLUG_RE.test(base) ? base : '';
}
