'use server';

import { revalidatePath } from 'next/cache';
import { defineTenantAction } from '@/lib/action';
import * as risk from '@/modules/restaurant/risk/service';

const path = (ctx: { organizationSlug: string; branchSlug: string }) => `/${ctx.organizationSlug}/${ctx.branchSlug}/audit/cashier-risk`;

/** Clears a score; the database re-checks the manager's own PIN and refuses one's own score. */
export const resetRiskAction = defineTenantAction({
  schema: risk.resetSchema, permission: 'restaurant.audit.risk_reset',
  rateLimit: { limit: 20, windowMs: 10 * 60_000 },
  handler: async ({ ctx, input }) => { await risk.resetRisk(ctx, input); revalidatePath(path(ctx)); return { ok: true as const }; },
});

export const setLimitsAction = defineTenantAction({
  schema: risk.limitsSchema, permission: 'restaurant.audit.risk_reset',
  handler: async ({ ctx, input }) => { await risk.setLimits(ctx, input); revalidatePath(path(ctx)); return { ok: true as const }; },
});
