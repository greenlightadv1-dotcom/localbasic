'use server';

import { revalidatePath } from 'next/cache';
import { defineTenantAction } from '@/lib/action';
import { createBranch, createBranchInput } from '@/modules/core/branches/service';

export const createBranchAction = defineTenantAction({
  schema: createBranchInput,
  permission: 'branch.create',
  handler: async ({ ctx, input }) => {
    const result = await createBranch(ctx, input);
    revalidatePath(`/${ctx.organizationSlug}/${ctx.branchSlug}/settings/branches`);
    return result;
  },
});
