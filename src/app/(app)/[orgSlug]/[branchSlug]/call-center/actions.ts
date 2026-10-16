'use server';

import { revalidatePath } from 'next/cache';
import { defineTenantAction } from '@/lib/action';
import * as cc from '@/modules/restaurant/callcenter/service';

/** Call center. The database re-checks restaurant.callcenter.use on every call. */
const P = 'restaurant.callcenter.use' as const;

export const lookupCallerAction = defineTenantAction({
  schema: cc.lookupSchema, permission: P,
  handler: async ({ ctx, input }) => cc.lookupCaller(ctx, input.phone),
});

export const saveCustomerAction = defineTenantAction({
  schema: cc.customerSchema, permission: P,
  handler: async ({ ctx, input }) => ({ id: await cc.saveCustomer(ctx, input) }),
});

export const saveAddressAction = defineTenantAction({
  schema: cc.addressSchema, permission: P,
  handler: async ({ ctx, input }) => ({ id: await cc.saveAddress(ctx, input) }),
});

export const placePhoneOrderAction = defineTenantAction({
  schema: cc.phoneOrderSchema, permission: P,
  handler: async ({ ctx, input }) => {
    const r = await cc.placePhoneOrder(ctx, input);
    for (const p of ['/delivery', '/kitchen', '/cashier', '/orders']) revalidatePath(`/${ctx.organizationSlug}/${ctx.branchSlug}${p}`);
    return r;
  },
});
