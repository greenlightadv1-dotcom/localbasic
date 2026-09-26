'use server';

import { revalidatePath } from 'next/cache';
import { defineTenantAction } from '@/lib/action';
import { updateBrandingSchema, updateBranding } from '@/modules/core/branding/service';

export const updateBrandingAction = defineTenantAction({
  schema: updateBrandingSchema,
  permission: 'branding.manage',
  handler: async ({ ctx, input }) => {
    await updateBranding(ctx, input);
    revalidatePath(`/${ctx.organizationSlug}/${ctx.branchSlug}/settings/branding`);
    return { ok: true };
  },
});
