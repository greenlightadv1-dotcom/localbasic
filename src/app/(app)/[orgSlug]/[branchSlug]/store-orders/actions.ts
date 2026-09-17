'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { defineTenantAction } from '@/lib/action';
import {
  advanceStoreOrder, cancelStoreOrder, completeStoreOrder,
} from '@/modules/retail/store/orders';
import {
  createShipment, payShipment, setShipmentStatus,
} from '@/modules/retail/shipping/service';

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

/**
 * Money typed by a human becomes minor units exactly once, here at the action
 * boundary — services take already-parsed input.
 */
const cents = z
  .union([z.string(), z.number()])
  .transform((v, ctx) => {
    const text = String(v).trim().replace(/[,\s]/g, '');
    if (text === '') return 0;
    if (!/^\d+(\.\d{0,2})?$/.test(text)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'مبلغ غير صالح' });
      return z.NEVER;
    }
    const [whole = '0', fraction = ''] = text.split('.');
    return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  })
  .pipe(z.number().int().nonnegative());

export const createShipmentAction = defineTenantAction({
  schema: z.object({
    orderId: z.string().uuid(),
    providerId: z.string().uuid().nullable().optional(),
    costCents: cents,
    trackingCode: z.string().trim().max(120).optional().or(z.literal('')),
    note: z.string().trim().max(300).optional().or(z.literal('')),
  }),
  permission: 'retail.order.manage',
  handler: async ({ ctx, input }) => {
    const result = await createShipment(ctx, {
      orderId: input.orderId,
      providerId: input.providerId ?? null,
      costCents: input.costCents,
      trackingCode: input.trackingCode || undefined,
      note: input.note || undefined,
    });
    revalidatePath(`/${ctx.organizationSlug}/${ctx.branchSlug}/store-orders`);
    return result;
  },
});

export const setShipmentStatusAction = defineTenantAction({
  schema: z.object({
    id: z.string().uuid(),
    status: z.enum(['dispatched', 'delivered', 'failed', 'cancelled']),
    reason: z.string().trim().max(300).optional().or(z.literal('')),
  }),
  permission: 'retail.order.manage',
  handler: async ({ ctx, input }) => {
    await setShipmentStatus(ctx, input.id, input.status, input.reason || undefined);
    revalidatePath(`/${ctx.organizationSlug}/${ctx.branchSlug}/store-orders`);
    return { ok: true };
  },
});

export const payShipmentAction = defineTenantAction({
  schema: z.object({ id: z.string().uuid() }),
  // Paying the carrier takes money out of the till, which is its own right.
  permission: ['retail.order.manage', 'treasury.create'],
  handler: async ({ ctx, input }) => {
    const settled = await payShipment(ctx, input.id);
    revalidatePath(`/${ctx.organizationSlug}/${ctx.branchSlug}/store-orders`);
    revalidatePath(`/${ctx.organizationSlug}/${ctx.branchSlug}/treasury`);
    return { settledCents: settled };
  },
});
