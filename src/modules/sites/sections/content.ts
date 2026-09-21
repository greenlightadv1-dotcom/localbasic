import { z } from 'zod';
import type { SectionType } from '../schemas';

/**
 * Per-section content schemas.
 *
 * `site_sections.content` is jsonb and the database validates only that it is
 * an object. Everything about its SHAPE is enforced here, at the boundary
 * between the row and the renderer — which is the only place that can enforce
 * it, since an editor, an import, or a hand-written SQL update can all put
 * anything in that column.
 *
 * Two rules hold throughout:
 *
 *   1. Every field is optional with a default. A section whose content is `{}`
 *      is not an error — it is a freshly created block that nobody has filled
 *      in yet, and it must render its placeholder rather than disappear.
 *   2. Nothing here accepts a URL scheme that can execute. `href` is
 *      restricted to a relative path, mailto: or tel:, so no amount of
 *      malformed or hostile content can put `javascript:` into the document.
 *      Executable code is never stored in section content.
 */

/**
 * A link target that cannot become script.
 *
 * Anything else — including http(s), which this phase has no use for and which
 * would otherwise be the obvious place to smuggle something — falls back to
 * null and the button renders as plain text.
 */
const safeHref = z
  .string()
  .trim()
  .refine(
    (v) => /^\/[^/\\]/.test(v) || /^mailto:[^\s]+@[^\s]+$/.test(v) || /^tel:\+?[0-9\s-]+$/.test(v),
    { message: 'unsupported link target' },
  );

/** Text with a hard ceiling, so one pasted document cannot break a layout. */
const text = (max: number) => z.string().trim().max(max);

export const heroSchema = z.object({
  title: text(120).default(''),
  subtitle: text(300).default(''),
  ctaLabel: text(40).default(''),
  ctaHref: safeHref.nullable().catch(null).default(null),
  align: z.enum(['center', 'start']).catch('center').default('center'),
});

export const aboutSchema = z.object({
  title: text(120).default(''),
  body: text(2000).default(''),
});

export const servicesSchema = z.object({
  title: text(120).default(''),
  items: z
    .array(
      z.object({
        name: text(80).default(''),
        description: text(300).default(''),
      }),
    )
    // A cap, not a validation failure: a hundred services is a data problem,
    // not a reason to render nothing.
    .max(24)
    .catch([])
    .default([]),
});

export const testimonialsSchema = z.object({
  title: text(120).default(''),
  items: z
    .array(
      z.object({
        quote: text(500).default(''),
        author: text(80).default(''),
      }),
    )
    .max(24)
    .catch([])
    .default([]),
});

export const contactSchema = z.object({
  title: text(120).default(''),
  phone: text(40).default(''),
  email: text(160).default(''),
  address: text(300).default(''),
});

export const footerSchema = z.object({
  text: text(200).default(''),
});

/** The schema for each section type. Total over SectionType by construction. */
export const SECTION_SCHEMAS = {
  hero: heroSchema,
  about: aboutSchema,
  services: servicesSchema,
  testimonials: testimonialsSchema,
  contact: contactSchema,
  footer: footerSchema,
} satisfies Record<SectionType, z.ZodTypeAny>;

export type SectionContent = {
  [K in SectionType]: z.infer<(typeof SECTION_SCHEMAS)[K]>;
};

/**
 * Parses stored content into the shape a renderer can rely on.
 *
 * Never throws and never returns null. Anything unparseable — a string where
 * an object belongs, an array of nulls, a field of the wrong type — collapses
 * to that section's defaults, so a malformed row costs its own content and
 * nothing else on the page.
 */
export function parseSectionContent<K extends SectionType>(
  type: K,
  raw: unknown,
): SectionContent[K] {
  const schema = SECTION_SCHEMAS[type] as z.ZodTypeAny;
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const result = schema.safeParse(source);
  if (result.success) return result.data as SectionContent[K];
  // A field-level failure the per-field .catch() could not absorb — for
  // example a string longer than its ceiling. Fall back to the all-defaults
  // parse, which cannot fail because every field has one.
  return schema.parse({}) as SectionContent[K];
}
