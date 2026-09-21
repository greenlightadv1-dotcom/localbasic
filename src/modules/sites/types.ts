import type { SectionType, SiteStatus } from './schemas';

/**
 * The Site Engine's read models.
 *
 * Deliberately not the raw database rows: the columns are snake_case, and the
 * shape the screens want is not the shape the tables have.
 *
 * `organizationId` is carried so a caller can assert a site belongs to the
 * context it was loaded under. `createdBy` is authorship for display and audit
 * — it authorizes nothing, and is null once that profile is removed.
 */

export type Site = {
  id: string;
  organizationId: string;
  /** Who first created it. Null once that profile is removed. */
  createdBy: string | null;
  name: string;
  slug: string;
  templateId: string | null;
  status: SiteStatus;
  createdAt: string;
  updatedAt: string;
};

export type SitePage = {
  id: string;
  siteId: string;
  title: string;
  slug: string;
  isHomepage: boolean;
  sortOrder: number;
};

export type SiteSection = {
  id: string;
  pageId: string;
  sectionType: SectionType;
  /**
   * Per-type content. Unknown at this layer on purpose: the renderer narrows
   * it per section type, and this phase stores whatever a later editor writes.
   */
  content: Record<string, unknown>;
  sortOrder: number;
  isVisible: boolean;
};

export type SiteSettings = {
  siteId: string;
  settings: Record<string, unknown>;
};

/** A site with everything needed to render or inspect it. */
export type SiteDetail = {
  site: Site;
  pages: SitePage[];
  sections: SiteSection[];
  settings: SiteSettings | null;
};
