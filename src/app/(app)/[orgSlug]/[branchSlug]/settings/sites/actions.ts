'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { defineTenantAction } from '@/lib/action';
import { RATE_LIMITS } from '@/lib/rate-limit';
import { createSiteSchema } from '@/modules/sites/schemas';
import { createSite } from '@/modules/sites/service';

/**
 * Creating a site.
 *
 * defineTenantAction, so the organization and branch come from the URL-derived
 * context and `site.manage` is checked server-side before the handler runs. A
 * forged organization id in the form body cannot reach the database.
 *
 * Rate limited on the provisioning bucket: each call writes three rows, so it
 * is cheap to fire and not free to absorb.
 */
const create = defineTenantAction({
  schema: createSiteSchema,
  permission: 'site.manage',
  rateLimit: RATE_LIMITS.provisionWorkspace,
  handler: async ({ ctx, input }) => createSite(ctx, input),
});

export type CreateSiteState =
  | { error?: string; fieldErrors?: Record<string, string[]> }
  | undefined;

export async function createSiteAction(
  _prev: CreateSiteState,
  formData: FormData,
): Promise<CreateSiteState> {
  const orgSlug = String(formData.get('orgSlug') ?? '');
  const branchSlug = String(formData.get('branchSlug') ?? '');

  // Scope first, then input: the wrapper resolves the context from the scope
  // and checks site.manage against it before the schema is even parsed.
  const result = await create(
    { organizationSlug: orgSlug, branchSlug },
    { name: formData.get('name'), slug: formData.get('slug') },
  );

  if (!result.ok) {
    return { error: result.error, fieldErrors: result.fieldErrors };
  }

  const base = `/${orgSlug}/${branchSlug}/settings/sites`;
  revalidatePath(base);
  redirect(`${base}/${result.data.siteId}`);
}
