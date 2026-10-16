'use server';

import { revalidatePath } from 'next/cache';
import { defineTenantAction } from '@/lib/action';
import * as inv from '@/modules/restaurant/inventory/service';

/**
 * Every raw-material write. Each declares the permission the screen needs;
 * the database function re-checks it together with the location and the
 * two-person rules, so these declarations are a first gate, not the boundary.
 */
function refresh(orgSlug: string, branchSlug: string) {
  for (const p of ['/stock', '/kitchen', '/barista', '/inventory/recipes', '/inventory/wastage', '/inventory/purchasing']) revalidatePath(`/${orgSlug}/${branchSlug}${p}`);
}

const done = (ctx: { organizationSlug: string; branchSlug: string }) => {
  refresh(ctx.organizationSlug, ctx.branchSlug);
  return { ok: true as const };
};

export const saveItemAction = defineTenantAction({
  schema: inv.itemSchema, permission: 'inventory.manage',
  handler: async ({ ctx, input }) => { await inv.saveItem(ctx, input); return done(ctx); },
});
export const saveParLevelAction = defineTenantAction({
  schema: inv.parLevelSchema, permission: 'inventory.manage',
  handler: async ({ ctx, input }) => { await inv.saveParLevel(ctx, input); return done(ctx); },
});
export const saveRecipeAction = defineTenantAction({
  schema: inv.recipeSchema, permission: 'inventory.manage',
  handler: async ({ ctx, input }) => { await inv.saveRecipe(ctx, input); return done(ctx); },
});
export const stockInAction = defineTenantAction({
  schema: inv.stockInSchema, permission: 'inventory.stock_in',
  handler: async ({ ctx, input }) => { await inv.stockIn(ctx, input); return done(ctx); },
});
export const issueAction = defineTenantAction({
  schema: inv.issueSchema, permission: 'inventory.issue',
  handler: async ({ ctx, input }) => { await inv.issue(ctx, input); return done(ctx); },
});
export const receiveAction = defineTenantAction({
  schema: inv.receiveSchema, permission: 'inventory.receive',
  handler: async ({ ctx, input }) => { const status = await inv.receive(ctx, input); done(ctx); return { status }; },
});
export const cancelTransferAction = defineTenantAction({
  schema: inv.transferIdSchema, permission: 'inventory.read',
  handler: async ({ ctx, input }) => { await inv.cancelTransfer(ctx, input); return done(ctx); },
});
export const resolveTransferAction = defineTenantAction({
  schema: inv.resolveSchema, permission: 'inventory.adjust',
  handler: async ({ ctx, input }) => { await inv.resolveTransfer(ctx, input); return done(ctx); },
});
export const createRequestAction = defineTenantAction({
  schema: inv.requestSchema, permission: 'inventory.request',
  handler: async ({ ctx, input }) => { await inv.createRequest(ctx, input); return done(ctx); },
});
export const cancelRequestAction = defineTenantAction({
  schema: inv.requestIdSchema, permission: 'inventory.read',
  handler: async ({ ctx, input }) => { await inv.cancelRequest(ctx, input); return done(ctx); },
});
export const recordWasteAction = defineTenantAction({
  schema: inv.wasteSchema, permission: 'inventory.waste',
  handler: async ({ ctx, input }) => { await inv.recordWaste(ctx, input); return done(ctx); },
});
export const adjustAction = defineTenantAction({
  schema: inv.adjustSchema, permission: 'inventory.adjust',
  handler: async ({ ctx, input }) => { await inv.adjust(ctx, input); return done(ctx); },
});
export const ackAlertAction = defineTenantAction({
  schema: inv.alertIdSchema, permission: 'inventory.read',
  handler: async ({ ctx, input }) => { await inv.ackAlert(ctx, input); return done(ctx); },
});

/** The station panel re-reads itself after a realtime nudge. */
export const stationViewAction = defineTenantAction({
  schema: inv.requestSchema.pick({ kind: true }), permission: 'inventory.read',
  handler: async ({ ctx, input }) => inv.getStationView(ctx, input.kind),
});
