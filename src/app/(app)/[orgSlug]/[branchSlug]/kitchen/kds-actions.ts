'use server';

import { revalidatePath } from 'next/cache';
import { defineTenantAction } from '@/lib/action';
import { bumpLines, bumpSchema, saveStationTimers, timersSchema } from '@/modules/restaurant/kds/service';

/**
 * A bump is checked per line by the database: restaurant.kitchen.use for a
 * kitchen line, restaurant.bar.use for a bar line. A chef and a barista both
 * reach this action; neither can move the other's lines.
 */
export const bumpLinesAction = defineTenantAction({
  schema: bumpSchema, permission: [],
  handler: async ({ ctx, input }) => {
    const orders = await bumpLines(ctx, input);
    for (const p of ['/kitchen', '/barista', '/cashier', '/floor']) revalidatePath(`/${ctx.organizationSlug}/${ctx.branchSlug}${p}`);
    return orders;
  },
});

export const saveStationTimersAction = defineTenantAction({
  schema: timersSchema, permission: 'restaurant.table.manage',
  handler: async ({ ctx, input }) => {
    await saveStationTimers(ctx, input);
    for (const p of ['/kitchen', '/barista', '/tables']) revalidatePath(`/${ctx.organizationSlug}/${ctx.branchSlug}${p}`);
    return { ok: true as const };
  },
});
