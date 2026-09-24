import { z } from 'zod';
import { SECTION_TYPES, type SectionType } from '../schemas';

/**
 * A template is configuration, never code.
 *
 * It says which sections a new site starts with, what they say by default, and
 * which colours the renderer paints with. It cannot say HOW to render — that
 * is the section registry's job, and keeping the two apart is what stops a
 * template from ever becoming a place to store executable content.
 */

/** Six hex digits. Anything else falls back rather than reaching the DOM. */
const hexColor = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, 'expected a #rrggbb colour');

export const themeSchema = z.object({
  /** Buttons, accents, links. */
  primary: hexColor.catch('#1e2fc8').default('#1e2fc8'),
  /** Page background behind the sections. */
  background: hexColor.catch('#ffffff').default('#ffffff'),
  /** Body text. */
  foreground: hexColor.catch('#111827').default('#111827'),
  /** Section dividers and card outlines. */
  border: hexColor.catch('#e5e7eb').default('#e5e7eb'),
});

export type SiteTheme = z.infer<typeof themeSchema>;

/**
 * The stored shape of `site_settings.settings`.
 *
 * Parsed with the same tolerance as section content: a settings row written
 * before a field existed, or by hand, must not stop a site rendering.
 */
export const siteSettingsSchema = z.object({
  locale: z.string().trim().max(12).catch('ar').default('ar'),
  direction: z.enum(['rtl', 'ltr']).catch('rtl').default('rtl'),
  templateId: z.enum(['business']).catch('business').default('business'),
  theme: themeSchema.catch(themeSchema.parse({})).default(() => themeSchema.parse({})),
});

export type SiteSettingsConfig = z.infer<typeof siteSettingsSchema>;

/** A section a template starts a new site with. */
export type TemplateSection = {
  type: SectionType;
  /** Seed content, already in the shape that section's schema expects. */
  content: Record<string, unknown>;
};

export type SiteTemplate = {
  id: 'business';
  nameAr: string;
  nameEn: string;
  description: string;
  theme: SiteTheme;
  /** In render order. Every type must be in SECTION_TYPES. */
  sections: TemplateSection[];
};

/** Guards a template's section list against a type the renderer cannot draw. */
export function assertTemplateSections(template: SiteTemplate): void {
  for (const section of template.sections) {
    if (!SECTION_TYPES.includes(section.type)) {
      throw new Error(`template ${template.id} uses unknown section ${section.type}`);
    }
  }
}
