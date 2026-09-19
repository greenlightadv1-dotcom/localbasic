import { z } from 'zod';
import { fontKey, hexColor, pageSlug, plainText, httpsUrl, sectionSchema } from './sections';

/**
 * The Site Definition.
 *
 * A website is this document and nothing else: no template file, no stored
 * markup, no code. Everything that decides what a visitor sees is here, in a
 * shape both the renderer and the database understand, which is what makes it
 * safe to let a model write one.
 *
 * VERSIONED FROM THE FIRST ROW. A reader that does not recognise a version
 * refuses it rather than guessing at the shape, so a future version 2 can
 * change anything it likes without a v1 document being silently misread.
 */
export const SITE_DEFINITION_VERSION = 1 as const;

export const themeSchema = z
  .object({
    colors: z
      .object({
        primary: hexColor,
        secondary: hexColor,
        accent: hexColor,
        background: hexColor,
        text: hexColor,
      })
      .strict(),
    fonts: z.object({ heading: fontKey, body: fontKey }).strict(),
    radius: z.enum(['none', 'small', 'medium', 'large', 'pill']),
    style: z.enum(['minimal', 'classic', 'bold', 'warm']),
  })
  .strict();

export type SiteTheme = z.infer<typeof themeSchema>;

export const seoSchema = z
  .object({
    title: plainText(70).optional(),
    description: plainText(180).optional(),
    noindex: z.boolean().optional(),
  })
  .strict();

export const pageSchema = z
  .object({
    slug: pageSlug,
    title: plainText(120),
    seo: seoSchema.optional(),
    sections: z.array(sectionSchema).max(30),
  })
  .strict();

export type SitePage = z.infer<typeof pageSchema>;

export const siteDefinitionSchema = z
  .object({
    version: z.literal(SITE_DEFINITION_VERSION),
    metadata: z
      .object({
        name: plainText(120),
        description: plainText(300).optional(),
        locale: z.enum(['ar', 'en']),
        direction: z.enum(['rtl', 'ltr']),
        logo_url: httpsUrl.optional(),
        favicon_url: httpsUrl.optional(),
      })
      .strict(),
    theme: themeSchema,
    /** Internal destinations only — see pageSlug. */
    navigation: z.array(z.object({ label: plainText(60), target: pageSlug }).strict()).max(12),
    pages: z.array(pageSchema).min(1).max(20),
    settings: z
      .object({
        show_branding: z.boolean(),
        analytics_enabled: z.boolean(),
      })
      .strict(),
  })
  .strict()
  // Navigation that points nowhere is a broken site, and a model will produce
  // it. Caught here rather than discovered by a visitor.
  .refine(
    (def) => def.navigation.every((n) => def.pages.some((p) => p.slug === n.target)),
    { message: 'كل رابط في القائمة يجب أن يشير إلى صفحة موجودة', path: ['navigation'] },
  )
  .refine((def) => def.pages.some((p) => p.slug === '/'), {
    message: 'الموقع يحتاج صفحة رئيسية على المسار /',
    path: ['pages'],
  })
  .refine(
    (def) => new Set(def.pages.map((p) => p.slug)).size === def.pages.length,
    { message: 'لا يمكن تكرار مسار الصفحة', path: ['pages'] },
  );

export type SiteDefinition = z.infer<typeof siteDefinitionSchema>;

/**
 * Parse an untrusted document into a Site Definition.
 *
 * The one entry point. Everything that did not come out of this function is
 * untrusted — most of all anything a model produced.
 */
export function parseSiteDefinition(
  value: unknown,
): { ok: true; definition: SiteDefinition } | { ok: false; error: string } {
  const parsed = siteDefinitionSchema.safeParse(value);
  if (parsed.success) return { ok: true, definition: parsed.data };

  const issue = parsed.error.issues[0];
  const where = issue?.path.join('.') ?? '';
  return {
    ok: false,
    error: where ? `${where}: ${issue?.message ?? 'قيمة غير صالحة'}` : (issue?.message ?? 'تعريف غير صالح'),
  };
}

export function isSiteDefinition(value: unknown): value is SiteDefinition {
  return siteDefinitionSchema.safeParse(value).success;
}
