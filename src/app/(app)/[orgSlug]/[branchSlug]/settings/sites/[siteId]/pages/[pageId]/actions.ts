'use server';

import { z } from 'zod';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { defineTenantAction } from '@/lib/action';
import { createSectionSchema, type SectionType } from '@/modules/sites/schemas';
import { SECTION_WRITE_SCHEMAS } from '@/modules/sites/sections/content';
import {
  createSection,
  deleteSection,
  getSiteDetail,
  reorderSections,
  updateSection,
} from '@/modules/sites/service';
import { resolveTenantContext } from '@/modules/core/tenancy/context';

/**
 * Section mutations.
 *
 * Same rule as the site and page actions: defineTenantAction resolves the
 * tenant from the URL scope and checks `site.manage` before anything runs, so
 * authorization is stated once and no component repeats it.
 *
 * The section's TYPE is never taken from the form when editing. updateSection()
 * reads it from the stored row and validates the submitted content against
 * that type's schema — letting the browser name the type would let it choose
 * which schema its content is judged against, which is the whole validation.
 */

type Scope = { orgSlug: string; branchSlug: string };

const noInput = z.object({}).strict();

function scopeOf(formData: FormData): Scope {
  return {
    orgSlug: String(formData.get('orgSlug') ?? ''),
    branchSlug: String(formData.get('branchSlug') ?? ''),
  };
}

function pagePath(scope: Scope, siteId: string, pageId: string, suffix = '') {
  return `/${scope.orgSlug}/${scope.branchSlug}/settings/sites/${siteId}/pages/${pageId}${suffix}`;
}

export type FormState = { error?: string; fieldErrors?: Record<string, string[]> } | undefined;

export async function createSectionAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const scope = scopeOf(formData);
  const siteId = String(formData.get('siteId') ?? '');
  const pageId = String(formData.get('pageId') ?? '');

  const run = defineTenantAction({
    schema: createSectionSchema,
    permission: 'site.manage',
    handler: async ({ ctx, input }) => createSection(ctx, pageId, input),
  });

  // createSectionSchema is z.enum(SECTION_TYPES), so a type the renderer has
  // no case for is refused here before the database's own CHECK sees it.
  const result = await run(
    { organizationSlug: scope.orgSlug, branchSlug: scope.branchSlug },
    { sectionType: formData.get('sectionType') },
  );
  if (!result.ok) return { error: result.error, fieldErrors: result.fieldErrors };

  revalidatePath(pagePath(scope, siteId, pageId));
  redirect(pagePath(scope, siteId, pageId, `?added=${result.data.sectionId}`));
}

/**
 * Saving one section's content.
 *
 * The form carries only the fields its type's schema declares. They are
 * assembled into an object here and handed to updateSection(), which parses
 * them with SECTION_WRITE_SCHEMAS[storedType] — strict, so an unknown field or
 * an unsafe link is refused rather than coerced.
 */
export async function updateSectionAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const scope = scopeOf(formData);
  const siteId = String(formData.get('siteId') ?? '');
  const pageId = String(formData.get('pageId') ?? '');
  const sectionId = String(formData.get('sectionId') ?? '');
  const type = String(formData.get('sectionType') ?? '') as SectionType;

  const schema = SECTION_WRITE_SCHEMAS[type];
  if (!schema) return { error: 'نوع القسم غير مدعوم.' };

  // Only keys the type's own schema declares are read out of the body. A field
  // somebody added to the form has nowhere to go — and updateSection() re-reads
  // the type from the stored row and validates against it regardless, so this
  // is convenience, not the security boundary.
  const content = collect(schema, formData);

  const run = defineTenantAction({
    schema: noInput,
    permission: 'site.manage',
    handler: async ({ ctx }) =>
      updateSection(ctx, sectionId, { content }),
  });

  const result = await run(
    { organizationSlug: scope.orgSlug, branchSlug: scope.branchSlug },
    {},
  );
  if (!result.ok) return { error: result.error, fieldErrors: result.fieldErrors };

  revalidatePath(pagePath(scope, siteId, pageId));
  redirect(pagePath(scope, siteId, pageId, `?saved=${sectionId}`));
}

/**
 * Reads the fields a section type declares out of a form body.
 *
 * A form body is all strings and the schemas are not, so the few shapes this
 * editor actually submits are converted here. Deliberately narrow: anything
 * not named below arrives at the schema exactly as it was typed, so the
 * SCHEMA remains the thing that decides what is acceptable.
 *
 * Fields absent from the body are left out entirely rather than sent as empty
 * strings, because every write schema is `.partial()` — omitting a field means
 * "unchanged", where an empty string would mean "cleared".
 */
function collect(
  schema: (typeof SECTION_WRITE_SCHEMAS)[SectionType],
  formData: FormData,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const key of Object.keys(schema.shape)) {
    if (key === 'categoryIds') {
      // A multi-select posts one entry per choice, and the "any category"
      // option posts an empty value that must not become an id.
      const chosen = formData.getAll(key).map(String).filter((v) => v.trim() !== '');
      out[key] = chosen;
      continue;
    }
    if (!formData.has(key)) continue;

    const value = String(formData.get(key) ?? '');
    if (key === 'ctaHref') {
      // An empty optional link is "no link", not an empty string.
      out[key] = value.trim() === '' ? null : value;
    } else if (key === 'limit') {
      out[key] = value.trim() === '' ? null : Number(value);
    } else {
      out[key] = value;
    }
  }

  return out;
}

/** Visibility. One field, one call, no content touched. */
export async function toggleSectionAction(formData: FormData): Promise<void> {
  const scope = scopeOf(formData);
  const siteId = String(formData.get('siteId') ?? '');
  const pageId = String(formData.get('pageId') ?? '');
  const sectionId = String(formData.get('sectionId') ?? '');
  const isVisible = formData.get('isVisible') === 'true';

  const run = defineTenantAction({
    schema: noInput,
    permission: 'site.manage',
    handler: async ({ ctx }) => updateSection(ctx, sectionId, { isVisible }),
  });

  const result = await run(
    { organizationSlug: scope.orgSlug, branchSlug: scope.branchSlug },
    {},
  );

  revalidatePath(pagePath(scope, siteId, pageId));
  redirect(
    result.ok
      ? pagePath(scope, siteId, pageId)
      : pagePath(scope, siteId, pageId, `?error=${encodeURIComponent(result.error)}`),
  );
}

/**
 * Moving a section one place.
 *
 * The server reads the page's authoritative order and submits the complete
 * permutation, exactly as page reordering does. The browser sends a direction,
 * never an order — a stale tab cannot rearrange a page.
 */
export async function moveSectionAction(formData: FormData): Promise<void> {
  const scope = scopeOf(formData);
  const siteId = String(formData.get('siteId') ?? '');
  const pageId = String(formData.get('pageId') ?? '');
  const sectionId = String(formData.get('sectionId') ?? '');
  const direction = formData.get('direction') === 'up' ? -1 : 1;

  const ctx = await resolveTenantContext(scope.orgSlug, scope.branchSlug);
  const detail = await getSiteDetail(ctx, siteId);
  if (!detail) redirect(pagePath(scope, siteId, pageId));

  const ids = detail.sections.filter((s) => s.pageId === pageId).map((s) => s.id);
  const from = ids.indexOf(sectionId);
  const to = from + direction;
  if (from === -1 || to < 0 || to >= ids.length) {
    revalidatePath(pagePath(scope, siteId, pageId));
    redirect(pagePath(scope, siteId, pageId));
  }
  [ids[from], ids[to]] = [ids[to]!, ids[from]!];

  const run = defineTenantAction({
    schema: noInput,
    permission: 'site.manage',
    handler: async ({ ctx: c }) => reorderSections(c, pageId, { sectionIds: ids }),
  });

  const result = await run(
    { organizationSlug: scope.orgSlug, branchSlug: scope.branchSlug },
    {},
  );

  revalidatePath(pagePath(scope, siteId, pageId));
  redirect(
    result.ok
      ? pagePath(scope, siteId, pageId)
      : pagePath(scope, siteId, pageId, `?error=${encodeURIComponent(result.error)}`),
  );
}

export async function deleteSectionAction(formData: FormData): Promise<void> {
  const scope = scopeOf(formData);
  const siteId = String(formData.get('siteId') ?? '');
  const pageId = String(formData.get('pageId') ?? '');
  const sectionId = String(formData.get('sectionId') ?? '');

  const run = defineTenantAction({
    schema: noInput,
    permission: 'site.manage',
    handler: async ({ ctx }) => deleteSection(ctx, sectionId),
  });

  const result = await run(
    { organizationSlug: scope.orgSlug, branchSlug: scope.branchSlug },
    {},
  );

  // A page with no sections is a valid page; nothing cascades from here.
  revalidatePath(pagePath(scope, siteId, pageId));
  redirect(
    result.ok
      ? pagePath(scope, siteId, pageId, '?deleted=1')
      : pagePath(scope, siteId, pageId, `?error=${encodeURIComponent(result.error)}`),
  );
}
