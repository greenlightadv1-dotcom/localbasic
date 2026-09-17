'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { defineTenantAction } from '@/lib/action';
import {
  createPurchaseSchema, paySchema, receiveSchema, supplierSchema,
} from '@/modules/retail/purchasing/schemas';
import {
  cancelPurchaseOrder, createPurchaseOrder, createSupplier, payPurchaseOrder,
  receivePurchaseOrder, setSupplierActive, submitPurchaseOrder,
} from '@/modules/retail/purchasing/service';

/**
 * Purchasing actions.
 *
 * Each one names the permission it needs and the wrapper enforces it against
 * the context resolved from the URL — the form's own fields never decide which
 * organization or branch is acted on. Receiving and paying additionally carry
 * the privilege for what they really do: move stock, and take money out.
 */

export const createSupplierAction = defineTenantAction({
  schema: supplierSchema,
  permission: 'retail.supplier.manage',
  handler: async ({ ctx, input }) => {
    const id = await createSupplier(ctx, input);
    revalidatePath(`/${ctx.organizationSlug}/${ctx.branchSlug}/suppliers`);
    return { id };
  },
});

export const setSupplierActiveAction = defineTenantAction({
  schema: z.object({ id: z.string().uuid(), isActive: z.boolean() }),
  permission: 'retail.supplier.manage',
  handler: async ({ ctx, input }) => {
    await setSupplierActive(ctx, input.id, input.isActive);
    revalidatePath(`/${ctx.organizationSlug}/${ctx.branchSlug}/suppliers`);
    return { ok: true };
  },
});

export const createPurchaseAction = defineTenantAction({
  schema: createPurchaseSchema,
  permission: 'retail.purchase.manage',
  handler: async ({ ctx, input }) => {
    const order = await createPurchaseOrder(ctx, input);
    revalidatePath(`/${ctx.organizationSlug}/${ctx.branchSlug}/purchases`);
    return order;
  },
});

export const submitPurchaseAction = defineTenantAction({
  schema: z.object({ id: z.string().uuid() }),
  permission: 'retail.purchase.manage',
  handler: async ({ ctx, input }) => {
    await submitPurchaseOrder(ctx, input.id);
    revalidatePath(`/${ctx.organizationSlug}/${ctx.branchSlug}/purchases`);
    return { ok: true };
  },
});

/**
 * Record a delivery.
 *
 * Two permissions, because this is two things: purchasing paperwork and a
 * movement of real stock. Someone allowed to raise an order is not thereby
 * allowed to declare that goods arrived.
 */
export const receivePurchaseAction = defineTenantAction({
  schema: receiveSchema,
  permission: ['retail.purchase.manage', 'retail.inventory.adjust'],
  handler: async ({ ctx, input }) => {
    const result = await receivePurchaseOrder(ctx, input);
    revalidatePath(`/${ctx.organizationSlug}/${ctx.branchSlug}/purchases`);
    revalidatePath(`/${ctx.organizationSlug}/${ctx.branchSlug}/inventory`);
    return result;
  },
});

export const payPurchaseAction = defineTenantAction({
  schema: paySchema,
  permission: ['retail.purchase.manage', 'treasury.create'],
  handler: async ({ ctx, input }) => {
    const result = await payPurchaseOrder(ctx, input);
    revalidatePath(`/${ctx.organizationSlug}/${ctx.branchSlug}/purchases`);
    revalidatePath(`/${ctx.organizationSlug}/${ctx.branchSlug}/treasury`);
    return result;
  },
});

export const cancelPurchaseAction = defineTenantAction({
  schema: z.object({ id: z.string().uuid(), reason: z.string().trim().max(300).optional() }),
  permission: 'retail.purchase.manage',
  handler: async ({ ctx, input }) => {
    await cancelPurchaseOrder(ctx, input.id, input.reason);
    revalidatePath(`/${ctx.organizationSlug}/${ctx.branchSlug}/purchases`);
    return { ok: true };
  },
});
