'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { defineTenantAction } from '@/lib/action';
import { setRestaurantFeature } from '@/modules/core/modules/service';
import { geofenceInput, saveGeofenceSettings } from '@/modules/restaurant/geofence/settings';

export const setRestaurantFeatureAction = defineTenantAction({
  schema: z.object({
    key: z.enum(['kitchen_display_enabled', 'captain_hall_enabled']),
    enabled: z.coerce.boolean(),
  }),
  permission: 'organization.manage',
  handler: async ({ ctx, input }) => {
    await setRestaurantFeature(ctx, input.key, input.enabled);
    // The layout/app-shell reads these flags on every request, so the whole
    // shell (not just this page) needs to be told to re-render.
    revalidatePath(`/${ctx.organizationSlug}/${ctx.branchSlug}`, 'layout');
    return { ok: true };
  },
});

export const saveGeofenceAction = defineTenantAction({
  schema: geofenceInput.extend({ scope: z.enum(['branch', 'organization']) }),
  permission: 'settings.manage',
  handler: async ({ ctx, input }) => {
    await saveGeofenceSettings(ctx, input, input.scope);
    return { ok: true };
  },
});
