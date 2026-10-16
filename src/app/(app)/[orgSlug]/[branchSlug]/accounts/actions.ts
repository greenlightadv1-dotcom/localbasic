'use server';

import { revalidatePath } from 'next/cache';
import { defineTenantAction } from '@/lib/action';
import * as crm from '@/modules/restaurant/crm/service';

function refresh(ctx: { organizationSlug: string; branchSlug: string }, customerId?: string) {
  const base = `/${ctx.organizationSlug}/${ctx.branchSlug}`;
  revalidatePath(`${base}/accounts`);
  if (customerId) revalidatePath(`${base}/accounts/${customerId}`);
}

export const saveAccountAction = defineTenantAction({
  schema: crm.accountSchema, permission: 'restaurant.account.manage',
  handler: async ({ ctx, input }) => { const id = await crm.saveAccount(ctx, input); refresh(ctx, id); return { customerId: id }; },
});

export const accountPaymentAction = defineTenantAction({
  schema: crm.accountPaymentSchema, permission: 'restaurant.account.manage',
  handler: async ({ ctx, input }) => { await crm.receivePayment(ctx, input); refresh(ctx, input.customerId); revalidatePath(`/${ctx.organizationSlug}/${ctx.branchSlug}/treasury`); return { ok: true as const }; },
});

/** Credit notes / debit corrections need a manager PIN (account.adjust). */
export const accountAdjustAction = defineTenantAction({
  schema: crm.accountAdjustSchema, permission: 'restaurant.account.manage',
  handler: async ({ ctx, input }) => { await crm.adjustAccount(ctx, input); refresh(ctx, input.customerId); return { ok: true as const }; },
});
