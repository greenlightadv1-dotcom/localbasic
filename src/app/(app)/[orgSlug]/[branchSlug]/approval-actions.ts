'use server';

import { defineTenantAction } from '@/lib/action';
import { RATE_LIMITS } from '@/lib/rate-limit';
import { grantSchema } from '@/modules/restaurant/approvals/schema';
import { grantApproval, listApprovers } from '@/modules/restaurant/approvals/service';
import { z } from 'zod';

/**
 * The approval dialog's two calls. No TypeScript permission on purpose: any
 * active member may ASK, and the database decides whether the chosen
 * approver may approve (approval.grant at this branch, not themselves, PIN
 * correct and not locked) — the same answer whichever screen asks.
 */
export const listApproversAction = defineTenantAction({
  schema: z.object({}),
  permission: [],
  handler: async ({ ctx }) => listApprovers(ctx),
});

export const grantApprovalAction = defineTenantAction({
  schema: grantSchema,
  permission: [],
  rateLimit: RATE_LIMITS.signIn,
  handler: async ({ ctx, input }) => grantApproval(ctx, input),
});
