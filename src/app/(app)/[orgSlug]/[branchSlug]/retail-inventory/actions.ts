'use server';

import { revalidatePath } from 'next/cache';
import { defineTenantAction } from '@/lib/action';
import * as schemas from '@/modules/retail/operations/schemas';
import * as retail from '@/modules/retail/operations/service';

/**
 * Branch transfers, auto-reorder and store-credit corrections (0112).
 *
 * The permission on each action is the early, clean refusal; the database
 * checks the precise rule per branch (request on the destination, approve and
 * dispatch on the source, receive on the destination, a second person to
 * receive what you shipped).
 */
const path = (ctx: { organizationSlug: string; branchSlug: string }) => `/${ctx.organizationSlug}/${ctx.branchSlug}/retail-inventory`;
const done = <T>(ctx: { organizationSlug: string; branchSlug: string }, value: T) => { revalidatePath(path(ctx)); return value; };

export const requestTransferAction = defineTenantAction({
  schema: schemas.transferRequestSchema, permission: 'retail.inventory.transfer',
  handler: async ({ ctx, input }) => done(ctx, await retail.requestTransfer(ctx, input)),
});

export const decideTransferAction = defineTenantAction({
  schema: schemas.transferDecideSchema, permission: 'retail.transfer.approve',
  handler: async ({ ctx, input }) => done(ctx, (await retail.decideTransfer(ctx, input), { ok: true as const })),
});

export const dispatchTransferAction = defineTenantAction({
  schema: schemas.transferDispatchSchema, permission: 'retail.inventory.transfer',
  handler: async ({ ctx, input }) => done(ctx, (await retail.dispatchTransfer(ctx, input), { ok: true as const })),
});

export const receiveTransferAction = defineTenantAction({
  schema: schemas.transferReceiveSchema, permission: 'retail.inventory.transfer',
  handler: async ({ ctx, input }) => done(ctx, await retail.receiveTransfer(ctx, input)),
});

// Either end may cancel (the requester, or the source's approver): the database decides.
export const cancelTransferAction = defineTenantAction({
  schema: schemas.transferCancelSchema, permission: 'retail.inventory.read',
  handler: async ({ ctx, input }) => done(ctx, (await retail.cancelTransfer(ctx, input), { ok: true as const })),
});

export const reorderSuggestionsAction = defineTenantAction({
  schema: schemas.emptySchema, permission: 'retail.purchase.read',
  handler: async ({ ctx }) => retail.getReorderSuggestions(ctx),
});

export const generateReorderAction = defineTenantAction({
  schema: schemas.emptySchema, permission: 'retail.purchase.manage',
  rateLimit: { limit: 10, windowMs: 60_000 },
  handler: async ({ ctx }) => {
    const drafts = await retail.generateReorderDrafts(ctx);
    revalidatePath(`/${ctx.organizationSlug}/${ctx.branchSlug}/purchases`);
    return done(ctx, drafts);
  },
});

/** Needs a second person's PIN ('retail.credit_adjust'), answered through the approval dialog. */
export const adjustStoreCreditAction = defineTenantAction({
  schema: schemas.storeCreditAdjustSchema, permission: 'retail.credit.manage',
  rateLimit: { limit: 20, windowMs: 10 * 60_000 },
  handler: async ({ ctx, input }) => done(ctx, { balanceCents: await retail.adjustStoreCredit(ctx, input) }),
});
