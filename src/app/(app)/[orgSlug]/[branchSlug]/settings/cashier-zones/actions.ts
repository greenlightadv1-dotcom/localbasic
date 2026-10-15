'use server';

import { revalidatePath } from 'next/cache';
import { defineTenantAction } from '@/lib/action';
import { zoneSchema } from '@/modules/restaurant/approvals/schema';
import { saveCashierZone } from '@/modules/restaurant/approvals/service';

export const saveCashierZoneAction = defineTenantAction({
  schema: zoneSchema,
  permission: 'member.manage',
  handler: async ({ ctx, input }) => {
    await saveCashierZone(ctx, input);
    revalidatePath(`/${ctx.organizationSlug}/${ctx.branchSlug}/settings/cashier-zones`);
    return { ok: true };
  },
});
