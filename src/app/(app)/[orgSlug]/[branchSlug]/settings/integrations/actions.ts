'use server';

import { revalidatePath } from 'next/cache';
import { defineTenantAction } from '@/lib/action';
import * as integrations from '@/modules/restaurant/integrations/service';

const path = (ctx: { organizationSlug: string; branchSlug: string }) => `/${ctx.organizationSlug}/${ctx.branchSlug}/settings/integrations`;

/** Returns the raw key once; only its hash is stored. */
export const createIntegrationAction = defineTenantAction({
  schema: integrations.integrationSchema, permission: 'restaurant.integration.manage',
  handler: async ({ ctx, input }) => { const r = await integrations.createIntegration(ctx, input); revalidatePath(path(ctx)); return r; },
});

export const setIntegrationAction = defineTenantAction({
  schema: integrations.integrationSetSchema, permission: 'restaurant.integration.manage',
  handler: async ({ ctx, input }) => { await integrations.setIntegration(ctx, input); revalidatePath(path(ctx)); return { ok: true as const }; },
});
