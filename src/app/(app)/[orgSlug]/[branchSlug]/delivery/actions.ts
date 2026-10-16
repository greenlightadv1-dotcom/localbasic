'use server';

import { revalidatePath } from 'next/cache';
import { defineTenantAction } from '@/lib/action';
import * as fleet from '@/modules/restaurant/delivery/service';

/**
 * Dispatch and fleet. Each action names the permission its screen needs; the
 * database re-checks it, the trip's state and, for money, the manager PIN.
 */
function refresh(ctx: { organizationSlug: string; branchSlug: string }) {
  for (const p of ['/delivery', '/my-deliveries', '/cashier', '/treasury']) revalidatePath(`/${ctx.organizationSlug}/${ctx.branchSlug}${p}`);
}
const ok = { ok: true as const };

export const saveZoneAction = defineTenantAction({
  schema: fleet.zoneSchema, permission: 'restaurant.driver.manage',
  handler: async ({ ctx, input }) => { await fleet.saveZone(ctx, input); refresh(ctx); return ok; },
});

export const saveDriverAction = defineTenantAction({
  schema: fleet.driverSchema, permission: 'restaurant.driver.manage',
  handler: async ({ ctx, input }) => { await fleet.saveDriver(ctx, input); refresh(ctx); return ok; },
});

export const adjustDriverAction = defineTenantAction({
  schema: fleet.driverAdjustSchema, permission: 'restaurant.driver.manage',
  handler: async ({ ctx, input }) => { await fleet.adjustDriver(ctx, input); refresh(ctx); return ok; },
});

export const setShiftAction = defineTenantAction({
  schema: fleet.shiftSchema, permission: 'restaurant.delivery.manage',
  handler: async ({ ctx, input }) => { await fleet.setShift(ctx, input); refresh(ctx); return ok; },
});

export const assignDriverAction = defineTenantAction({
  schema: fleet.assignSchema, permission: 'restaurant.delivery.manage',
  handler: async ({ ctx, input }) => { await fleet.assign(ctx, input); refresh(ctx); return ok; },
});

/** Dispatchers and drivers both move a trip; the database allows a driver only their own. */
export const setDeliveryStatusAction = defineTenantAction({
  schema: fleet.statusSchema, permission: [],
  handler: async ({ ctx, input }) => { await fleet.setStatus(ctx, input); refresh(ctx); return ok; },
});

export const giveFloatAction = defineTenantAction({
  schema: fleet.floatSchema, permission: 'restaurant.driver.settle',
  handler: async ({ ctx, input }) => { await fleet.giveFloat(ctx, input); refresh(ctx); return ok; },
});

export const settleDriverAction = defineTenantAction({
  schema: fleet.settleSchema, permission: 'restaurant.driver.settle',
  handler: async ({ ctx, input }) => {
    const r = (await fleet.settle(ctx, input)) as Record<string, unknown>;
    refresh(ctx);
    return { orders: Number(r.orders ?? 0), collected: Number(r.collected ?? 0), shortage: Number(r.shortage ?? 0), commissionPaid: Number(r.commission_paid ?? 0) };
  },
});

export const myShiftAction = defineTenantAction({
  schema: fleet.shiftSchema, permission: 'restaurant.driver.use',
  handler: async ({ ctx, input }) => { await fleet.setShift(ctx, input); refresh(ctx); return ok; },
});
