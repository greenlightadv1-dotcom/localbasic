'use server';

import { revalidatePath } from 'next/cache';
import { defineTenantAction } from '@/lib/action';
import { AppError } from '@/lib/errors';
import { createOrder, setOrderStatus } from '@/modules/restaurant/orders/service';
import { addOrderItems, copyModifierGroup, saveModifierGroup } from '@/modules/restaurant/hub/service';
import { addItemsSchema, copyGroupSchema, hubOrderSchema, modifierGroupSchema } from '@/modules/restaurant/hub/schemas';

/**
 * The hub's own actions (0117). Payment, status changes, KDS bumps and check
 * splits reuse the existing actions of the cashier, kitchen and floor screens,
 * so each rule lives in one place. Every database function re-checks the
 * permission named here; these are a first gate, not the boundary.
 */
function refresh(ctx: { organizationSlug: string; branchSlug: string }, ...extra: string[]) {
  for (const p of ['/restaurant', '/floor', '/cashier', '/kitchen', '/barista', ...extra]) {
    revalidatePath(`/${ctx.organizationSlug}/${ctx.branchSlug}${p}`);
  }
}

/**
 * A new order from the floor. Sending it to the kitchen is the same step the
 * cashier takes (confirmed); if this role may create but not confirm, the
 * order is kept and the screen says it is still waiting.
 */
export const createHubOrderAction = defineTenantAction({
  schema: hubOrderSchema,
  permission: 'restaurant.order.create',
  handler: async ({ ctx, input }) => {
    const { sendToKitchen, ...order } = input;
    const channel = ctx.permissions.has('restaurant.pos.use') ? 'cashier' : 'waiter';
    const created = await createOrder(ctx, order, channel);
    let sent = false;
    if (sendToKitchen) {
      try {
        await setOrderStatus(ctx, created.id, 'confirmed');
        sent = true;
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
      }
    }
    refresh(ctx, '/orders');
    return { ...created, sentToKitchen: sent };
  },
});

export const addOrderItemsAction = defineTenantAction({
  schema: addItemsSchema,
  permission: 'restaurant.order.create',
  handler: async ({ ctx, input }) => {
    const r = await addOrderItems(ctx, input);
    refresh(ctx, '/orders');
    return r;
  },
});

export const saveModifierGroupAction = defineTenantAction({
  schema: modifierGroupSchema,
  permission: 'restaurant.menu.manage',
  handler: async ({ ctx, input }) => {
    const id = await saveModifierGroup(ctx, input);
    refresh(ctx, '/menu');
    return { id };
  },
});

export const copyModifierGroupAction = defineTenantAction({
  schema: copyGroupSchema,
  permission: 'restaurant.menu.manage',
  handler: async ({ ctx, input }) => {
    const copies = await copyModifierGroup(ctx, input);
    refresh(ctx, '/menu');
    return { copies };
  },
});
