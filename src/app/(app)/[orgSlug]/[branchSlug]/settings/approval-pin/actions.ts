'use server';

import { revalidatePath } from 'next/cache';
import { defineTenantAction } from '@/lib/action';
import { RATE_LIMITS } from '@/lib/rate-limit';
import { setPinSchema } from '@/modules/restaurant/approvals/schema';
import { setPin } from '@/modules/restaurant/approvals/service';

export const setApprovalPinAction = defineTenantAction({
  schema: setPinSchema,
  permission: 'approval.grant',
  rateLimit: RATE_LIMITS.signIn,
  handler: async ({ ctx, input }) => {
    await setPin(ctx, input);
    revalidatePath(`/${ctx.organizationSlug}/${ctx.branchSlug}/settings/approval-pin`);
    return { ok: true };
  },
});
