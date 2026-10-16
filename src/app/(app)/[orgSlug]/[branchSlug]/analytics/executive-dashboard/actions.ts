'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { defineTenantAction } from '@/lib/action';
import * as bi from '@/modules/restaurant/analytics/service';

/** Executive dashboard writes. The database re-checks each permission. */
const path = (ctx: { organizationSlug: string; branchSlug: string }) => `/${ctx.organizationSlug}/${ctx.branchSlug}/analytics/executive-dashboard`;

export const sendCampaignAction = defineTenantAction({
  schema: bi.campaignSchema, permission: 'restaurant.campaign.send',
  rateLimit: { limit: 10, windowMs: 60 * 60_000 },
  handler: async ({ ctx, input }) => { const r = await bi.sendCampaign(ctx, input); revalidatePath(path(ctx)); return r; },
});

export const saveAnalyticsSettingsAction = defineTenantAction({
  schema: bi.settingsSchema, permission: 'restaurant.analytics.executive',
  handler: async ({ ctx, input }) => { await bi.saveSettings(ctx, input); revalidatePath(path(ctx)); return { ok: true as const }; },
});

export const ackMarginAlertAction = defineTenantAction({
  schema: bi.alertAckSchema, permission: 'restaurant.analytics.executive',
  handler: async ({ ctx, input }) => { await bi.ackAlert(ctx, input); revalidatePath(path(ctx)); return { ok: true as const }; },
});

export const scanMarginsAction = defineTenantAction({
  schema: z.object({}), permission: 'restaurant.analytics.executive',
  handler: async ({ ctx }) => { const opened = await bi.scanMargins(ctx); revalidatePath(path(ctx)); return { opened }; },
});
