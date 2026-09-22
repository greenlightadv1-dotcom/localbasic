import { z } from 'zod';
import { SECTION_TYPES } from './schemas';

/**
 * What a published revision contains.
 *
 * Zero imports beyond the section registry and zod, like ./resolved: a
 * snapshot is data, and the module that describes it must not drag a database
 * client anywhere it is read.
 *
 * THE SNAPSHOT IS PARSED, NOT TRUSTED. It is jsonb written by a migration's
 * function, and it will one day be read by a public route serving anonymous
 * traffic. A row written by an older build, or by a future one with different
 * fields, must degrade rather than throw — so this mirrors the read schemas in
 * sections/content.ts: tolerant, total, and falling back rather than failing.
 *
 * A snapshot holds ONLY VISIBLE sections. Hiding a section and publishing is
 * how you take it down; showing it again needs another publish. That is what a
 * draft/live split is for, and it matches what 0042 does.
 */

const sectionSchema = z.object({
  id: z.string(),
  sectionType: z.enum(SECTION_TYPES),
  content: z.record(z.unknown()).catch({}).default({}),
  sortOrder: z.number().int().catch(0).default(0),
});

const pageSchema = z.object({
  id: z.string(),
  title: z.string().catch('').default(''),
  slug: z.string(),
  isHomepage: z.boolean().catch(false).default(false),
  sortOrder: z.number().int().catch(0).default(0),
  // A section whose type this build has no renderer for is dropped rather
  // than rendered as a blank — the same rule getSiteDetail() applies to drafts.
  sections: z.array(sectionSchema.catch(null as never)).catch([]).default([]),
});

export const siteSnapshotSchema = z.object({
  site: z
    .object({
      id: z.string(),
      name: z.string().catch('').default(''),
      slug: z.string().catch('').default(''),
      templateId: z.string().nullable().catch(null).default(null),
    })
    .catch({ id: '', name: '', slug: '', templateId: null }),
  settings: z.record(z.unknown()).catch({}).default({}),
  pages: z.array(pageSchema).catch([]).default([]),
});

export type SiteSnapshot = z.infer<typeof siteSnapshotSchema>;
export type SnapshotPage = SiteSnapshot['pages'][number];
export type SnapshotSection = SnapshotPage['sections'][number];

/**
 * Parses a stored snapshot into something renderable.
 *
 * Never throws. A snapshot that cannot be read at all comes back with no
 * pages, which every caller already has to handle — a site can legitimately
 * have never been published.
 */
export function parseSnapshot(raw: unknown): SiteSnapshot {
  const result = siteSnapshotSchema.safeParse(raw);
  if (result.success) {
    return {
      ...result.data,
      // Sections whose type this build cannot draw are dropped here rather
      // than at render time, so a caller counting sections counts renderable
      // ones.
      pages: result.data.pages.map((p) => ({
        ...p,
        sections: p.sections.filter(Boolean),
      })),
    };
  }
  return { site: { id: '', name: '', slug: '', templateId: null }, settings: {}, pages: [] };
}

export type SiteRevision = {
  id: string;
  siteId: string;
  version: number;
  isLive: boolean;
  publishedAt: string;
  publishedBy: string | null;
  note: string | null;
};

/** A revision with its snapshot parsed, for rendering or inspection. */
export type SiteRevisionDetail = SiteRevision & { snapshot: SiteSnapshot };

/**
 * Whether the draft has moved since a revision was published.
 *
 * Compares the SHAPE a publish would capture — pages, their visible sections,
 * and each section's content — rather than timestamps, because an edit that
 * was saved and then undone should not read as a pending change.
 *
 * A heuristic for a badge, deliberately not a guarantee: it is computed from
 * what the editor already loaded, and the only authority on what is live is
 * the revision itself.
 */
export function draftDiffersFrom(
  snapshot: SiteSnapshot,
  draft: {
    pages: { id: string; title: string; slug: string; isHomepage: boolean }[];
    sections: { id: string; pageId: string; content: Record<string, unknown>; isVisible: boolean }[];
  },
): boolean {
  if (snapshot.pages.length !== draft.pages.length) return true;

  for (const page of draft.pages) {
    const published = snapshot.pages.find((p) => p.id === page.id);
    if (!published) return true;
    if (published.title !== page.title) return true;
    if (published.slug !== page.slug) return true;
    if (published.isHomepage !== page.isHomepage) return true;

    const visible = draft.sections.filter((s) => s.pageId === page.id && s.isVisible);
    if (visible.length !== published.sections.length) return true;

    for (const section of visible) {
      const was = published.sections.find((s) => s.id === section.id);
      if (!was) return true;
      if (JSON.stringify(was.content) !== JSON.stringify(section.content)) return true;
    }
  }

  return false;
}
