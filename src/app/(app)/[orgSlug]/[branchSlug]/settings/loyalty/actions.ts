'use server';

import { revalidatePath } from 'next/cache';
import { defineTenantAction } from '@/lib/action';
import { saveLoyaltySettings, saveLoyaltySchema } from '@/modules/restaurant/loyalty/service';

export const saveLoyaltyAction = defineTenantAction({
  schema: saveLoyaltySchema,
  permission: 'settings.manage',
  handler: async ({ ctx, input }) => {
    await saveLoyaltySettings(ctx, input);
    revalidatePath(`/${ctx.organizationSlug}/${ctx.branchSlug}/settings/loyalty`);
    return { ok: true };
  },
});
