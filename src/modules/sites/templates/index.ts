import { businessTemplate } from './business';
import { assertTemplateSections, type SiteTemplate } from './types';

/**
 * The template registry. Closed, like the section registry.
 *
 * A template id that is not a key here cannot be selected, so a stored
 * `templateId` from a future build — or a hand-edited settings row — resolves
 * to the default rather than to nothing.
 *
 * `template_id` on the sites table is deliberately still an unconstrained
 * uuid with no foreign key: there is no templates TABLE yet, and inventing one
 * to satisfy a column would be the wrong order. Selection runs through
 * site_settings.settings.templateId, which is validated here.
 */
export const TEMPLATES = {
  business: businessTemplate,
} satisfies Record<string, SiteTemplate>;

export type TemplateId = keyof typeof TEMPLATES;

export const DEFAULT_TEMPLATE_ID: TemplateId = 'business';

/** The named template, or the default when the name is not one we ship. */
export function resolveTemplate(id: string | null | undefined): SiteTemplate {
  const template = (TEMPLATES as Record<string, SiteTemplate>)[id ?? ''];
  return template ?? TEMPLATES[DEFAULT_TEMPLATE_ID];
}

// Fails at import time rather than at render time if a template ever lists a
// section the renderer has no case for.
for (const template of Object.values(TEMPLATES)) assertTemplateSections(template);

export { businessTemplate };
export type { SiteTemplate, SiteTheme, TemplateSection } from './types';
