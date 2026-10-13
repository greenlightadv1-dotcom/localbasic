'use server';

import { z } from 'zod';
import { definePublicAction } from '@/lib/action';
import { RATE_LIMITS } from '@/lib/rate-limit';
import { getCustomerProfile, claimReward } from '@/modules/restaurant/customer/service';

const scope = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('slug'), orgSlug: z.string().trim().min(2).max(64) }),
  z.object({ kind: z.literal('token'), token: z.string().trim().min(8).max(200) }),
]);

const identity = z.object({
  scope,
  deviceId: z.string().trim().min(8).max(128),
  phone: z.string().trim().min(6).max(32),
});

/** Reads are generous (the sheet refreshes while open); claims are tight. */
export const getCustomerProfileAction = definePublicAction({
  schema: identity,
  rateLimit: RATE_LIMITS.accountRead,
  handler: async ({ input }) => getCustomerProfile(input.scope, input.deviceId, input.phone),
});

export const claimRewardAction = definePublicAction({
  schema: identity,
  rateLimit: RATE_LIMITS.accountWrite,
  handler: async ({ input }) => claimReward(input.scope, input.deviceId, input.phone),
});
