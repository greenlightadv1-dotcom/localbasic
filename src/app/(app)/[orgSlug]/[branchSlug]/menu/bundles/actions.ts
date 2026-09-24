'use server';

import { revalidatePath } from 'next/cache';
import { defineTenantAction } from '@/lib/action';
import { bundleSchema, toggleBundleActiveSchema } from '@/modules/restaurant/bundles/schemas';
import { createBundle, setBundleActive } from '@/modules/restaurant/bundles/service';

export const createBundleAction = defineTenantAction({
  schema: bundleSchema,
  permission: 'restaurant.menu.manage',
  handler: async ({ ctx, input }) => {
    const id = await createBundle(ctx, input);
    revalidatePath(`/${ctx.organizationSlug}/${ctx.branchSlug}/menu/bundles`);
    return { id };
  },
});

export const toggleBundleActiveAction = defineTenantAction({
  schema: toggleBundleActiveSchema,
  permission: 'restaurant.menu.manage',
  handler: async ({ ctx, input }) => {
    await setBundleActive(ctx, input.bundleId, input.isActive);
    revalidatePath(`/${ctx.organizationSlug}/${ctx.branchSlug}/menu/bundles`);
    return { ok: true };
  },
});
