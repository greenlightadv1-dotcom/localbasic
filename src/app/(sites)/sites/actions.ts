'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { defineUserAction } from '@/lib/action';
import { RATE_LIMITS } from '@/lib/rate-limit';
import { createSiteSchema } from '@/modules/sites/schemas';
import { createSite } from '@/modules/sites/service';

/**
 * Creating a site.
 *
 * defineUserAction, not defineTenantAction: a site belongs to a person rather
 * than to a workspace, so there is no organization to resolve and no
 * permission to check beyond being signed in. The wrapper still gives the
 * session, the rate limit and the Zod parse.
 *
 * Rate limited on the provisioning bucket: each call writes three rows, so it
 * is cheap to fire and not free to absorb.
 */
const create = defineUserAction({
  schema: createSiteSchema,
  rateLimit: RATE_LIMITS.provisionWorkspace,
  handler: async ({ input }) => createSite(input),
});

export type CreateSiteState =
  | { error?: string; fieldErrors?: Record<string, string[]> }
  | undefined;

export async function createSiteAction(
  _prev: CreateSiteState,
  formData: FormData,
): Promise<CreateSiteState> {
  const result = await create({
    name: formData.get('name'),
    slug: formData.get('slug'),
  });

  if (!result.ok) {
    return { error: result.error, fieldErrors: result.fieldErrors };
  }

  // The list is server-rendered and dynamic, but revalidating is what makes a
  // back-navigation show the new site rather than a cached page without it.
  revalidatePath('/sites');
  redirect(`/sites/${result.data.siteId}`);
}
