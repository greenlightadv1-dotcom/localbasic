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

/**
 * Editing a site.
 *
 * Deliberately two fields. `id`, `organization_id` and `created_by` are not
 * absent by oversight — they are not writable at all, and 0056's trigger
 * refuses them at the database even if a future caller tried. `slug` is left
 * out too: it is an address, and changing one is a redirect problem rather
 * than a field edit.
 *
 * Both fields are optional so a caller can change one without resending the
 * other, but at least one must be present — an update that changes nothing is
 * a bug in the caller, not a no-op worth writing a row for.
 */
export const updateSiteSchema = z
  .object({
    name: z.string().trim().min(2, 'الاسم حرفان على الأقل').max(120, 'الاسم طويل جدًا').optional(),
    status: z.enum(SITE_STATUSES).optional(),
  })
  .refine((v) => v.name !== undefined || v.status !== undefined, {
    message: 'لا يوجد تغيير',
  });

export type UpdateSiteInput = z.infer<typeof updateSiteSchema>;

/**
 * Editing a section.
 *
 * `content` is `unknown` here on purpose. Its shape depends on the section's
 * type, and the type is read from the stored row rather than accepted from
 * the caller — so the content is validated in the service, once the row has
 * said what it is. A schema here could only check it against a type the
 * client chose, which is no check at all.
 */
export const updateSectionSchema = z
  .object({
    content: z.unknown().optional(),
    isVisible: z.boolean().optional(),
  })
  .refine((v) => v.content !== undefined || v.isVisible !== undefined, {
    message: 'لا يوجد تغيير',
  });

export type UpdateSectionInput = z.infer<typeof updateSectionSchema>;

/**
 * Reordering a page's sections.
 *
 * The full ordered list of the page's section ids. Not a pair of positions:
 * a permutation is verifiable in one statement — every section, each exactly
 * once — where "move section X to slot 3" is only verifiable against state the
 * caller cannot see and the database would have to re-derive.
 */
export const reorderSectionsSchema = z.object({
  sectionIds: z.array(z.string().uuid()).max(64),
});

export type ReorderSectionsInput = z.infer<typeof reorderSectionsSchema>;

/**
 * The page slug rule, matching the check constraint on site_pages.slug.
 * One character, or 2–64 with no leading or trailing hyphen.
 */
const PAGE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$|^[a-z0-9]$/;

/**
 * Creating a page.
 *
 * `.strict()` throughout this group, so a payload carrying `siteId`,
 * `organizationId`, `isHomepage`, `id` or a timestamp is REFUSED rather than
 * quietly stripped. Stripping would be safe — the service builds its own
 * arguments — but a caller sending those fields has misunderstood something,
 * and a silent success teaches them the misunderstanding was right.
 *
 * The site is not in here at all: it is a positional argument to the service,
 * resolved against the TenantContext before anything is written.
 *
 * `isHomepage` is absent by design. A site has a homepage from the moment it
 * is provisioned, so creating a page never means creating the homepage, and
 * site_page_create() writes the flag as false without consulting the caller.
 */
export const createPageSchema = z
  .object({
    title: z.string().trim().min(1, 'العنوان مطلوب').max(200, 'العنوان طويل جدًا'),
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .regex(PAGE_SLUG_RE, 'حروف إنجليزية صغيرة وأرقام وشرطات فقط'),
  })
  .strict();

export type CreatePageInput = z.infer<typeof createPageSchema>;

/**
 * Renaming a page.
 *
 * The column is `title`, not `name`. Only it is editable here.
 *
 * `slug` is excluded for the reason site slugs are excluded from
 * updateSiteSchema: a slug is an address, and changing one is a redirect
 * problem rather than a field edit. `isHomepage` is excluded because changing
 * which page a site opens on is a different operation — one that has to clear
 * the old flag and set the new one in the same transaction — not a side effect
 * of renaming.
 */
export const renamePageSchema = z
  .object({
    title: z.string().trim().min(1, 'العنوان مطلوب').max(200, 'العنوان طويل جدًا'),
  })
  .strict();

export type RenamePageInput = z.infer<typeof renamePageSchema>;

/**
 * Reordering a site's pages.
 *
 * The complete ordered list of the site's page ids, exactly as
 * reorderSectionsSchema does for a page's sections.
 */
export const reorderPagesSchema = z
  .object({
    pageIds: z.array(z.string().uuid()).max(64),
  })
  .strict();

export type ReorderPagesInput = z.infer<typeof reorderPagesSchema>;
