'use server';

import { revalidatePath } from 'next/cache';
import { defineTenantAction } from '@/lib/action';
import { resetCustomer, resetCustomerSchema } from '@/modules/restaurant/customers/service';

export const resetCustomerAction = defineTenantAction({
  schema: resetCustomerSchema,
  permission: 'customer.update',
  handler: async ({ ctx, input }) => {
    const result = await resetCustomer(ctx, input);
    revalidatePath(`/${ctx.organizationSlug}/${ctx.branchSlug}/customers`);
    return result;
  },
});
