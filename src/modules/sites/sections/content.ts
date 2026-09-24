import { z } from 'zod';
import type { SectionType } from '../schemas';

/**
 * Per-section content schemas.
 *
 * `site_sections.content` is jsonb. Migration 0057 enforces the parts a
 * direct database write must not get wrong — that it is an object, that its
 * keys are known, and that a hero's ctaHref carries a safe scheme — and this
 * file enforces the rest: lengths, nested shapes, enums and fallbacks, which
 * are presentation tolerances rather than invariants and would only buy
 * schema drift in SQL.
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

/**
 * An image source that cannot become script.
 *
 * `<img src="javascript:...">` does not execute in any modern browser, but
 * this is restricted anyway rather than trusted to that fact: an absolute
 * `https://` URL (a CDN, an image host, or this project's own Supabase
 * Storage bucket once uploads land) or a same-origin `/` path. No `data:`,
 * no `http://`, no `javascript:`.
 */
const safeImageUrl = z
  .string()
  .trim()
  .max(2000)
  .refine((v) => /^https:\/\//.test(v) || (/^\/[^/\\]/.test(v) && !v.startsWith('//')), {
    message: 'unsupported image source',
  });

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

/**
 * A promotional banner: a large image with an optional headline and a link.
 *
 * Presentational, not data-bound — a banner is copy an operator writes for a
 * specific campaign, not something resolved from a table. `imageUrl` is a URL
 * today, the same shape `restaurant_products.image_url` and
 * `branding_settings.logo_url` already take; this project has no file-upload
 * pipeline yet (see the site-features gap note), so this is a direct
 * attachment's address once that pipeline exists, not a step back from it.
 */
export const bannerSchema = z.object({
  title: text(120).default(''),
  subtitle: text(300).default(''),
  imageUrl: safeImageUrl.nullable().catch(null).default(null),
  ctaLabel: text(40).default(''),
  ctaHref: safeHref.nullable().catch(null).default(null),
});


// ===========================================================================
// DATA-BOUND SECTIONS (Phase 3)
//
// These store CONFIGURATION, never data. A menu section says "show the
// organization's menu, these categories, at most this many"; it does not hold
// a dish, a price or a description. The authoritative tables hold those, the
// server-side resolver reads them at render time, and nothing is copied into
// site_sections.content on the way past.
//
// `title` is the only free text, and it is the operator's own heading above
// the section — presentation, exactly like an about section's title. The
// business name, phone, address and opening times are not storable here at
// all: the SQL allow-list in 0059 refuses every key not named below, so a
// direct PostgREST write cannot smuggle one in either.
//
// `source` is a literal rather than an enum with one member on purpose. A
// second value would be a second resolution strategy, and the only plausible
// one is "a snapshot taken at some point", which is the thing this design
// exists to prevent.
// ===========================================================================

const liveSource = z.literal('live');

/** A uuid, the shape every id in this schema takes. */
const idString = z.string().uuid();

export const menuSchema = z.object({
  title: text(120).default(''),
  source: liveSource.catch('live').default('live'),
  // Narrows WHICH of the organization's categories to show. Ids only — and
  // whose category an id names is not decided here: the resolver re-queries
  // them inside the site's own organization, so an id belonging to another
  // tenant matches nothing rather than reaching their menu.
  categoryIds: z.array(idString).max(50).catch([]).default([]),
  limit: z.number().int().min(1).max(200).nullable().catch(null).default(null),
});

export const businessInfoSchema = z.object({
  title: text(120).default(''),
  source: liveSource.catch('live').default('live'),
});

export const hoursSchema = z.object({
  title: text(120).default(''),
  source: liveSource.catch('live').default('live'),
});

export const branchesSchema = z.object({
  title: text(120).default(''),
  source: liveSource.catch('live').default('live'),
});

/**
 * The organization's flagged "best sellers" — the same products
 * restaurant_products already carries, filtered to is_best_seller = true.
 * Flat, not grouped by category: it is a curated highlight list, not a
 * second menu.
 */
export const bestSellersSchema = z.object({
  title: text(120).default(''),
  source: liveSource.catch('live').default('live'),
  limit: z.number().int().min(1).max(50).nullable().catch(null).default(null),
});

/**
 * The organization's bundles/packages — display-only merchandising cards
 * (name, description of contents, image, one price), from
 * restaurant_bundles. Not a sellable POS catalog item: ordering a bundle as
 * a single line is a separate, larger feature this does not attempt.
 */
export const bundlesSchema = z.object({
  title: text(120).default(''),
  source: liveSource.catch('live').default('live'),
  limit: z.number().int().min(1).max(50).nullable().catch(null).default(null),
});

export const menuWriteSchema = z
  .object({
    title: text(120),
    source: liveSource,
    categoryIds: z.array(idString).max(50),
    limit: z.number().int().min(1).max(200).nullable(),
  })
  .partial()
  .strict();

export const businessInfoWriteSchema = z
  .object({ title: text(120), source: liveSource })
  .partial()
  .strict();

export const hoursWriteSchema = z
  .object({ title: text(120), source: liveSource })
  .partial()
  .strict();

export const branchesWriteSchema = z
  .object({ title: text(120), source: liveSource })
  .partial()
  .strict();

/** The schema for each section type. Total over SectionType by construction. */
export const SECTION_SCHEMAS = {
  hero: heroSchema,
  about: aboutSchema,
  services: servicesSchema,
  testimonials: testimonialsSchema,
  contact: contactSchema,
  footer: footerSchema,
  banner: bannerSchema,
  menu: menuSchema,
  business_info: businessInfoSchema,
  hours: hoursSchema,
  branches: branchesSchema,
  best_sellers: bestSellersSchema,
  bundles: bundlesSchema,
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

/**
 * Write schemas — strict where the read schemas are forgiving.
 *
 * The asymmetry is the point, and it is not an oversight that these are
 * separate objects rather than a transform of the ones above.
 *
 *   READING a row must never fail. A section stored by an older build, a
 *   hand-written SQL update or a future editor has to render as something, so
 *   every field above carries a default and the hostile ones carry .catch().
 *
 *   WRITING a row must fail loudly. A caller sending an unknown field, a
 *   string past its ceiling or a javascript: link has made a mistake, and
 *   silently storing a coerced value would tell them it worked. `.strict()`
 *   refuses the unknown field rather than dropping it, which is also what the
 *   database's key allow-list does — the two agree by construction, and
 *   drift.test.ts asserts they keep agreeing.
 *
 * Every field is optional: content `{}` is a valid, freshly created section,
 * and an editor saving one field should not have to resend the other four.
 */

export const heroWriteSchema = z
  .object({
    title: text(120),
    subtitle: text(300),
    ctaLabel: text(40),
    ctaHref: safeHref.nullable(),
    align: z.enum(['center', 'start']),
  })
  .partial()
  .strict();

export const aboutWriteSchema = z
  .object({ title: text(120), body: text(2000) })
  .partial()
  .strict();

export const servicesWriteSchema = z
  .object({
    title: text(120),
    items: z
      .array(z.object({ name: text(80), description: text(300) }).partial().strict())
      .max(24),
  })
  .partial()
  .strict();

export const testimonialsWriteSchema = z
  .object({
    title: text(120),
    items: z
      .array(z.object({ quote: text(500), author: text(80) }).partial().strict())
      .max(24),
  })
  .partial()
  .strict();

export const contactWriteSchema = z
  .object({
    title: text(120),
    phone: text(40),
    email: text(160),
    address: text(300),
  })
  .partial()
  .strict();

export const footerWriteSchema = z.object({ text: text(200) }).partial().strict();

export const bannerWriteSchema = z
  .object({
    title: text(120),
    subtitle: text(300),
    imageUrl: safeImageUrl.nullable(),
    ctaLabel: text(40),
    ctaHref: safeHref.nullable(),
  })
  .partial()
  .strict();

export const bestSellersWriteSchema = z
  .object({
    title: text(120),
    source: liveSource,
    limit: z.number().int().min(1).max(50).nullable(),
  })
  .partial()
  .strict();

export const bundlesWriteSchema = z
  .object({
    title: text(120),
    source: liveSource,
    limit: z.number().int().min(1).max(50).nullable(),
  })
  .partial()
  .strict();

/** The write schema for each section type. Total over SectionType. */
export const SECTION_WRITE_SCHEMAS = {
  hero: heroWriteSchema,
  about: aboutWriteSchema,
  services: servicesWriteSchema,
  testimonials: testimonialsWriteSchema,
  contact: contactWriteSchema,
  footer: footerWriteSchema,
  banner: bannerWriteSchema,
  menu: menuWriteSchema,
  business_info: businessInfoWriteSchema,
  hours: hoursWriteSchema,
  branches: branchesWriteSchema,
  best_sellers: bestSellersWriteSchema,
  bundles: bundlesWriteSchema,
} satisfies Record<SectionType, z.ZodTypeAny>;

/**
 * Validates content on its way INTO the database.
 *
 * Returns the parsed object, or throws the Zod error. The section type comes
 * from the stored row, never from the caller: letting a client name the type
 * would let it pick which schema its content is judged against, which is the
 * whole validation.
 */
export function parseSectionContentForWrite(
  type: SectionType,
  raw: unknown,
): Record<string, unknown> {
  const schema = SECTION_WRITE_SCHEMAS[type] as z.ZodTypeAny;
  return schema.parse(raw) as Record<string, unknown>;
}
