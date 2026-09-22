'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { defineTenantAction } from '@/lib/action';
import {
  createPageSchema,
  renamePageSchema,
  reorderPagesSchema,
  updateSiteSchema,
} from '@/modules/sites/schemas';
import {
  createPage,
  deletePage,
  publishSite,
  renamePage,
  reorderPages,
  rollbackSite,
  unpublishSite,
  updateSite,
} from '@/modules/sites/service';

/**
 * Site and page mutations.
 *
 * Every one goes through defineTenantAction, which resolves the tenant from
 * the SCOPE — the organization and branch slugs in the URL — and checks
 * `site.manage` against it before the schema is even parsed. Authorization is
 * therefore written once, here, and not repeated in any component: a rendered
 * button is not an authorised button, and a form body naming an organization
 * has nowhere to land.
 *
 * The site and page ids travel as form fields because they identify WHICH row
 * to act on, not who may act on it. Each service re-resolves them through the
 * parent chain against the context's organization, so an id from another
 * tenant resolves to a 404 rather than to their data.
 */

type Scope = { orgSlug: string; branchSlug: string };

function scopeOf(formData: FormData): Scope {
  return {
    orgSlug: String(formData.get('orgSlug') ?? ''),
    branchSlug: String(formData.get('branchSlug') ?? ''),
  };
}

function sitePath(scope: Scope, siteId: string, suffix = '') {
  return `/${scope.orgSlug}/${scope.branchSlug}/settings/sites/${siteId}${suffix}`;
}

export type FormState = { error?: string; fieldErrors?: Record<string, string[]> } | undefined;

/** An action that acts on a target id and takes no other input. */
const noInput = z.object({}).strict();

// ── General settings ───────────────────────────────────────────────────────

export async function updateSiteAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const scope = scopeOf(formData);
  const siteId = String(formData.get('siteId') ?? '');

  // The site id is a TARGET, not a field, so it is closed over rather than put
  // in the schema: updateSiteSchema stays exactly the two writable fields, and
  // updateSite() re-resolves the id against the context's organization.
  const run = defineTenantAction({
    schema: updateSiteSchema,
    permission: 'site.manage',
    handler: async ({ ctx, input }) => updateSite(ctx, siteId, input),
  });

  const result = await run(
    { organizationSlug: scope.orgSlug, branchSlug: scope.branchSlug },
    { name: formData.get('name'), status: formData.get('status') },
  );
  if (!result.ok) return { error: result.error, fieldErrors: result.fieldErrors };

  revalidatePath(sitePath(scope, siteId));
  redirect(sitePath(scope, siteId, '?saved=1'));
}

// ── Pages ──────────────────────────────────────────────────────────────────

export async function createPageAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const scope = scopeOf(formData);
  const siteId = String(formData.get('siteId') ?? '');

  const run = defineTenantAction({
    schema: createPageSchema,
    permission: 'site.manage',
    handler: async ({ ctx, input }) => createPage(ctx, siteId, input),
  });

  const result = await run(
    { organizationSlug: scope.orgSlug, branchSlug: scope.branchSlug },
    { title: formData.get('title'), slug: formData.get('slug') },
  );
  if (!result.ok) return { error: result.error, fieldErrors: result.fieldErrors };

  revalidatePath(sitePath(scope, siteId));
  redirect(sitePath(scope, siteId, `/pages/${result.data.pageId}`));
}

export async function renamePageAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const scope = scopeOf(formData);
  const siteId = String(formData.get('siteId') ?? '');
  const pageId = String(formData.get('pageId') ?? '');

  const run = defineTenantAction({
    schema: renamePageSchema,
    permission: 'site.manage',
    handler: async ({ ctx, input }) => renamePage(ctx, pageId, input),
  });

  const result = await run(
    { organizationSlug: scope.orgSlug, branchSlug: scope.branchSlug },
    { title: formData.get('title') },
  );
  if (!result.ok) return { error: result.error, fieldErrors: result.fieldErrors };

  revalidatePath(sitePath(scope, siteId));
  revalidatePath(sitePath(scope, siteId, `/pages/${pageId}`));
  redirect(sitePath(scope, siteId, `/pages/${pageId}?saved=1`));
}

/**
 * Moving a page one place.
 *
 * The client sends the page and a direction; the server reads the current
 * order and submits the COMPLETE permutation, because that is what
 * reorderPages accepts and what makes a partial order unrepresentable. The
 * browser never computes the new order — a stale list in a tab cannot reorder
 * a site behind someone's back.
 */
export async function movePageAction(formData: FormData): Promise<void> {
  const scope = scopeOf(formData);
  const siteId = String(formData.get('siteId') ?? '');
  const pageId = String(formData.get('pageId') ?? '');
  const direction = formData.get('direction') === 'up' ? -1 : 1;

  const run = defineTenantAction({
    schema: reorderPagesSchema,
    permission: 'site.manage',
    handler: async ({ ctx, input }) => reorderPages(ctx, siteId, input),
  });

  // Read the authoritative order first, from the same authorized path.
  const { getSiteDetail } = await import('@/modules/sites/service');
  const { resolveTenantContext } = await import('@/modules/core/tenancy/context');
  const ctx = await resolveTenantContext(scope.orgSlug, scope.branchSlug);
  const detail = await getSiteDetail(ctx, siteId);
  if (!detail) redirect(sitePath(scope, siteId));

  const ids = detail.pages.map((p) => p.id);
  const from = ids.indexOf(pageId);
  const to = from + direction;
  // Out of range is a no-op rather than an error: the button was disabled, so
  // arriving here means the list moved under the operator.
  if (from === -1 || to < 0 || to >= ids.length) {
    revalidatePath(sitePath(scope, siteId));
    redirect(sitePath(scope, siteId));
  }
  [ids[from], ids[to]] = [ids[to]!, ids[from]!];

  const result = await run(
    { organizationSlug: scope.orgSlug, branchSlug: scope.branchSlug },
    { pageIds: ids },
  );

  revalidatePath(sitePath(scope, siteId));
  redirect(
    result.ok
      ? sitePath(scope, siteId)
      : sitePath(scope, siteId, `?error=${encodeURIComponent(result.error)}`),
  );
}

/**
 * Deleting a page.
 *
 * The SERVER decides what happens: a non-homepage page is removed, deleting
 * the homepage promotes the next page by (sort_order, id), and deleting the
 * only page is refused. None of that is re-implemented here or in the browser
 * — site_page_delete() owns it, and this reports what it said.
 */
export async function deletePageAction(formData: FormData): Promise<void> {
  const scope = scopeOf(formData);
  const siteId = String(formData.get('siteId') ?? '');
  const pageId = String(formData.get('pageId') ?? '');

  const run = defineTenantAction({
    schema: noInput,
    permission: 'site.manage',
    handler: async ({ ctx }) => deletePage(ctx, pageId),
  });

  const result = await run(
    { organizationSlug: scope.orgSlug, branchSlug: scope.branchSlug },
    {},
  );

  revalidatePath(sitePath(scope, siteId));
  redirect(
    result.ok
      ? sitePath(scope, siteId, '?deleted=1')
      : sitePath(scope, siteId, `?error=${encodeURIComponent(result.error)}`),
  );
}

// ── Publishing ─────────────────────────────────────────────────────────────

/**
 * Publishing, rolling back and taking down.
 *
 * Same wrapper as every other mutation: the tenant comes from the URL scope
 * and `site.manage` is checked before anything runs. The database functions
 * behind these re-check it too, against the organization on the site row.
 */
export async function publishSiteAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const scope = scopeOf(formData);
  const siteId = String(formData.get('siteId') ?? '');
  const note = String(formData.get('note') ?? '');

  const run = defineTenantAction({
    schema: noInput,
    permission: 'site.manage',
    handler: async ({ ctx }) => publishSite(ctx, siteId, note.trim() || null),
  });

  const result = await run(
    { organizationSlug: scope.orgSlug, branchSlug: scope.branchSlug },
    {},
  );
  if (!result.ok) return { error: result.error };

  revalidatePath(sitePath(scope, siteId));
  redirect(sitePath(scope, siteId, `?published=${result.data.version}`));
}

export async function rollbackSiteAction(formData: FormData): Promise<void> {
  const scope = scopeOf(formData);
  const siteId = String(formData.get('siteId') ?? '');
  const revisionId = String(formData.get('revisionId') ?? '');

  const run = defineTenantAction({
    schema: noInput,
    permission: 'site.manage',
    handler: async ({ ctx }) => rollbackSite(ctx, siteId, revisionId),
  });

  const result = await run(
    { organizationSlug: scope.orgSlug, branchSlug: scope.branchSlug },
    {},
  );

  revalidatePath(sitePath(scope, siteId));
  redirect(
    result.ok
      ? sitePath(scope, siteId, `?restored=${result.data.version}`)
      : sitePath(scope, siteId, `?error=${encodeURIComponent(result.error)}`),
  );
}

export async function unpublishSiteAction(formData: FormData): Promise<void> {
  const scope = scopeOf(formData);
  const siteId = String(formData.get('siteId') ?? '');

  const run = defineTenantAction({
    schema: noInput,
    permission: 'site.manage',
    handler: async ({ ctx }) => unpublishSite(ctx, siteId),
  });

  const result = await run(
    { organizationSlug: scope.orgSlug, branchSlug: scope.branchSlug },
    {},
  );

  revalidatePath(sitePath(scope, siteId));
  redirect(
    result.ok
      ? sitePath(scope, siteId, '?unpublished=1')
      : sitePath(scope, siteId, `?error=${encodeURIComponent(result.error)}`),
  );
}
