import type { SiteDefinition } from '../definition';
import type { BusinessProfile } from '../business';
import type { ThemeOverride } from '../theme';

/**
 * The AI provider boundary.
 *
 * Everything above this line is LocalBasic's own model of a website; everything
 * below it is somebody's API. Keeping the seam here is what lets Claude,
 * OpenAI or anything else be swapped without a single route, service or
 * renderer changing — and, more importantly, what guarantees there is exactly
 * one place where model output crosses into the application, so validation has
 * one door to guard rather than many.
 *
 * A provider is given structured input and returns a candidate document. It is
 * NOT given database access, and what it returns is `unknown` on purpose: a
 * provider cannot assert that its own output is a SiteDefinition. Only
 * WebsiteAIService, by parsing it, can.
 */

export type WebsiteBrief = {
  /** Free-form instructions from the operator, in their own words. */
  notes: string;
  audience?: string;
  tone?: string;
  /** Pages the operator wants to exist, as titles. */
  requestedPages?: string[];
  /** Section types the operator explicitly wants. */
  requestedSections?: string[];
  seoKeywords?: string[];
  restrictions?: string;
};

export type GenerateSiteInput = {
  siteType: string;
  locale: 'ar' | 'en';
  business: BusinessProfile;
  brief: WebsiteBrief;
  theme?: ThemeOverride;
};

export type ReviseSiteInput = {
  current: SiteDefinition;
  /** What the operator asked to change, in their own words. */
  instruction: string;
  business: BusinessProfile;
};

/**
 * A candidate document. Deliberately `unknown`: it has not been validated yet,
 * and the type system should not let anyone forget that.
 */
export type ProviderResult = { raw: unknown; provider: string; model?: string };

export interface WebsiteAIProvider {
  readonly name: string;
  generateSite(input: GenerateSiteInput): Promise<ProviderResult>;
  reviseSite(input: ReviseSiteInput): Promise<ProviderResult>;
}
