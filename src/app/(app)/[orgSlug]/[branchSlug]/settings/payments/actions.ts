'use server';

import { revalidatePath } from 'next/cache';
import { defineTenantAction } from '@/lib/action';
import { savePaymentSettings, savePaymentSettingsSchema } from '@/modules/restaurant/payments/service';

export const savePaymentSettingsAction = defineTenantAction({
  schema: savePaymentSettingsSchema,
  permission: 'settings.manage',
  handler: async ({ ctx, input }) => {
    await savePaymentSettings(ctx, input);
    revalidatePath(`/${ctx.organizationSlug}/${ctx.branchSlug}/settings/payments`);
    return { ok: true };
  },
});
