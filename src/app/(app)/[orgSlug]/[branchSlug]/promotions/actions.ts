'use server';

import { revalidatePath } from 'next/cache';
import { defineTenantAction } from '@/lib/action';
import * as crm from '@/modules/restaurant/crm/service';

function refresh(ctx: { organizationSlug: string; branchSlug: string }) {
  revalidatePath(`/${ctx.organizationSlug}/${ctx.branchSlug}/promotions`);
}

export const savePromotionAction = defineTenantAction({
  schema: crm.promotionSchema, permission: 'restaurant.promotion.manage',
  handler: async ({ ctx, input }) => { const id = await crm.savePromotion(ctx, input); refresh(ctx); return { id }; },
});

export const saveRewardAction = defineTenantAction({
  schema: crm.rewardSchema, permission: 'restaurant.loyalty.manage',
  handler: async ({ ctx, input }) => { await crm.saveReward(ctx, input); refresh(ctx); return { ok: true as const }; },
});

/** A PIN-approved points correction (approval action loyalty.adjust). */
export const adjustPointsAction = defineTenantAction({
  schema: crm.pointsAdjustSchema, permission: 'restaurant.loyalty.manage',
  handler: async ({ ctx, input }) => ({ balance: await crm.adjustPoints(ctx, input) }),
});

/** Staff redeem a reward for a guest at the till: returns a coupon code. */
export const redeemRewardAction = defineTenantAction({
  schema: crm.redeemSchema, permission: 'restaurant.pos.use',
  handler: async ({ ctx, input }) => crm.staffRedeem(ctx, input),
});
