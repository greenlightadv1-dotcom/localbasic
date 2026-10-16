'use server';

import { revalidatePath } from 'next/cache';
import { defineTenantAction } from '@/lib/action';
import * as po from '@/modules/restaurant/purchasing/service';

/**
 * Purchasing (0109). Each action names the permission its screen needs; the
 * database re-checks it at the branch (receiving also needs inventory.stock_in).
 */
function refresh(ctx: { organizationSlug: string; branchSlug: string }) {
  for (const p of ['/inventory/purchasing', '/stock', '/inventory/recipes']) revalidatePath(`/${ctx.organizationSlug}/${ctx.branchSlug}${p}`);
}
const ok = { ok: true as const };

export const generateOrdersAction = defineTenantAction({
  schema: po.generateSchema, permission: 'inventory.purchase',
  handler: async ({ ctx }) => { const r = await po.generateOrders(ctx); refresh(ctx); return r; },
});

export const savePoAction = defineTenantAction({
  schema: po.poSaveSchema, permission: 'inventory.purchase',
  handler: async ({ ctx, input }) => { const id = await po.savePo(ctx, input); refresh(ctx); return { id }; },
});

export const setPoStatusAction = defineTenantAction({
  schema: po.poStatusSchema, permission: 'inventory.purchase',
  handler: async ({ ctx, input }) => { await po.setPoStatus(ctx, input); refresh(ctx); return ok; },
});

export const receivePoAction = defineTenantAction({
  schema: po.poReceiveSchema, permission: ['inventory.purchase', 'inventory.stock_in'],
  handler: async ({ ctx, input }) => { const r = await po.receivePo(ctx, input); refresh(ctx); return r; },
});

export const saveSupplierAction = defineTenantAction({
  schema: po.supplierSchema, permission: 'inventory.purchase',
  handler: async ({ ctx, input }) => { const id = await po.saveSupplier(ctx, input); refresh(ctx); return { id }; },
});

export const setItemSupplierAction = defineTenantAction({
  schema: po.itemSupplierSchema, permission: 'inventory.purchase',
  handler: async ({ ctx, input }) => { await po.setItemSupplier(ctx, input); refresh(ctx); return ok; },
});

export const saveThresholdAction = defineTenantAction({
  schema: po.thresholdSchema, permission: 'inventory.manage',
  handler: async ({ ctx, input }) => { await po.saveThreshold(ctx, input); refresh(ctx); return ok; },
});
