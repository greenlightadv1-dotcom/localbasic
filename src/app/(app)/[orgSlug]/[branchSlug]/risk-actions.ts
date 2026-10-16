'use server';

import { revalidatePath } from 'next/cache';
import { defineTenantAction } from '@/lib/action';
import * as risk from '@/modules/restaurant/risk/service';

/**
 * The till's side of fraud prevention (0108). The database decides what is a
 * risk event (a reprint, a drawer opened with no sale, a refund) and scores
 * it; these only report the act.
 */

/** Any screen that prints a bill or receipt; the database checks pos/service/invoice access. */
export const trackPrintAction = defineTenantAction({
  schema: risk.printTrackSchema, permission: [],
  handler: async ({ ctx, input }) => ({ printCount: await risk.trackPrint(ctx, input) }),
});

export const openDrawerAction = defineTenantAction({
  schema: risk.drawerSchema, permission: 'restaurant.pos.use',
  handler: async ({ ctx, input }) => { await risk.openDrawer(ctx, input); return { ok: true as const }; },
});

/** Past the person's daily refund cap the database asks for a PIN (refund.daily_limit). */
export const refundPaymentAction = defineTenantAction({
  schema: risk.refundSchema, permission: 'payment.refund',
  handler: async ({ ctx, input }) => {
    const r = await risk.refundPayment(ctx, input);
    const base = `/${ctx.organizationSlug}/${ctx.branchSlug}`;
    for (const p of ['/invoices', `/invoices/${input.invoiceId}`, '/treasury', '/cashier']) revalidatePath(`${base}${p}`);
    return r;
  },
});
