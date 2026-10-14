'use server';

import { revalidatePath } from 'next/cache';
import { defineTenantAction } from '@/lib/action';
import { receiptSettingsSchema } from '@/modules/restaurant/receipt/schema';
import { saveReceiptSettings } from '@/modules/restaurant/receipt/service';

export const saveReceiptSettingsAction = defineTenantAction({
  schema: receiptSettingsSchema,
  permission: 'settings.manage',
  handler: async ({ ctx, input }) => {
    await saveReceiptSettings(ctx, input);
    revalidatePath(`/${ctx.organizationSlug}/${ctx.branchSlug}/settings/receipt`);
    return { ok: true };
  },
});
