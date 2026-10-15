'use server';

import { revalidatePath } from 'next/cache';
import { defineTenantAction } from '@/lib/action';
import * as floor from '@/modules/restaurant/floor/service';
import {
  checkLinesSchema, estimateSchema, layoutSchema, mergeSchema, seatSchema, splitSchema,
  transferSchema, unmergeSchema, waitlistActionSchema, waitlistAddSchema,
} from '@/modules/restaurant/floor/schemas';

/**
 * Floor operations. Each declares the permission its screen needs; the
 * database function re-checks it with the zone, the approval and the
 * inventory rules, so these are a first gate, not the boundary.
 */
function refresh(ctx: { organizationSlug: string; branchSlug: string }) {
  for (const p of ['/floor', '/tables', '/cashier', '/kitchen', '/barista']) {
    revalidatePath(`/${ctx.organizationSlug}/${ctx.branchSlug}${p}`);
  }
}

export const saveLayoutAction = defineTenantAction({
  schema: layoutSchema, permission: 'restaurant.table.manage',
  handler: async ({ ctx, input }) => { await floor.saveLayout(ctx, input); refresh(ctx); return { ok: true as const }; },
});

export const transferTableAction = defineTenantAction({
  schema: transferSchema, permission: 'restaurant.table.transfer',
  handler: async ({ ctx, input }) => { const moved = await floor.transferTable(ctx, input); refresh(ctx); return { moved }; },
});

export const mergeTablesAction = defineTenantAction({
  schema: mergeSchema, permission: 'restaurant.table.transfer',
  handler: async ({ ctx, input }) => { const orderId = await floor.mergeTables(ctx, input); refresh(ctx); return { orderId }; },
});

export const unmergeTableAction = defineTenantAction({
  schema: unmergeSchema, permission: 'restaurant.table.transfer',
  handler: async ({ ctx, input }) => { await floor.unmergeTable(ctx, input.tableId); refresh(ctx); return { ok: true as const }; },
});

export const splitCheckAction = defineTenantAction({
  schema: splitSchema, permission: 'restaurant.table.transfer',
  handler: async ({ ctx, input }) => { const r = await floor.splitCheck(ctx, input); refresh(ctx); return r; },
});

export const setSeatAction = defineTenantAction({
  schema: seatSchema, permission: 'restaurant.table.transfer',
  handler: async ({ ctx, input }) => { await floor.setSeat(ctx, input); return { ok: true as const }; },
});

export const checkLinesAction = defineTenantAction({
  schema: checkLinesSchema, permission: 'restaurant.order.read',
  handler: async ({ ctx, input }) => floor.getCheckLines(ctx, input.orderId),
});

export const waitlistAddAction = defineTenantAction({
  schema: waitlistAddSchema, permission: 'restaurant.waitlist.manage',
  handler: async ({ ctx, input }) => { const r = await floor.addToWaitlist(ctx, input); refresh(ctx); return r; },
});

export const waitlistActAction = defineTenantAction({
  schema: waitlistActionSchema, permission: 'restaurant.waitlist.manage',
  handler: async ({ ctx, input }) => { await floor.waitlistAction(ctx, input); refresh(ctx); return { ok: true as const }; },
});

export const estimateWaitAction = defineTenantAction({
  schema: estimateSchema, permission: 'restaurant.waitlist.manage',
  handler: async ({ ctx, input }) => ({ minutes: await floor.estimateWait(ctx, input.partySize) }),
});
