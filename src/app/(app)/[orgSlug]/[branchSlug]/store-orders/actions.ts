'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { defineTenantAction } from '@/lib/action';
import {
  advanceStoreOrder, cancelStoreOrder, completeStoreOrder,
} from '@/modules/retail/store/orders';

/**
 * Store order actions.
 *
 * Each names the permission it needs; the wrapper enforces it against the
 * context resolved from the URL. Completion additionally carries the document
 * and payment privileges, because that is the step where a receipt is issued
 * and money is taken.
 */

const orderId = z.object({ id: z.string().uuid() });

export const advanceOrderAction = defineTenantAction({
  schema: orderId.extend({ status: z.enum(['confirmed', 'packed', 'fulfilled']) }),
  permission: 'retail.order.manage',
  handler: async ({ ctx, input }) => {
    await advanceStoreOrder(ctx, input.id, input.status);
    revalidatePath(`/${ctx.organizationSlug}/${ctx.branchSlug}/store-orders`);
    return { ok: true };
  },
});

export const cancelOrderAction = defineTenantAction({
  schema: orderId.extend({ reason: z.string().trim().max(300).optional() }),
  permission: 'retail.order.manage',
  handler: async ({ ctx, input }) => {
    await cancelStoreOrder(ctx, input.id, input.reason);
    revalidatePath(`/${ctx.organizationSlug}/${ctx.branchSlug}/store-orders`);
    revalidatePath(`/${ctx.organizationSlug}/${ctx.branchSlug}/inventory`);
    return { ok: true };
  },
});

export const completeOrderAction = defineTenantAction({
  schema: orderId.extend({
    method: z.enum(['cash', 'card', 'transfer', 'wallet', 'other']).default('cash'),
  }),
  permission: ['retail.order.manage', 'invoice.create', 'payment.create'],
  handler: async ({ ctx, input }) => {
    const result = await completeStoreOrder(ctx, input.id, input.method);
    revalidatePath(`/${ctx.organizationSlug}/${ctx.branchSlug}/store-orders`);
    revalidatePath(`/${ctx.organizationSlug}/${ctx.branchSlug}/invoices`);
    revalidatePath(`/${ctx.organizationSlug}/${ctx.branchSlug}/treasury`);
    return result;
  },
});
