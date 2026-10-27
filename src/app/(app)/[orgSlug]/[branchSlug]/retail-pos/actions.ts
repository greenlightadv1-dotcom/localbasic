'use server';

import { revalidatePath } from 'next/cache';
import { defineTenantAction } from '@/lib/action';
import * as schemas from '@/modules/retail/operations/schemas';
import * as retail from '@/modules/retail/operations/service';

/**
 * The retail till (0111/0112): scan, price the cart with promotions, sell,
 * return. A cash refund comes back as `approval` (LB403 'retail.cashback');
 * the screen opens the manager-PIN dialog, which writes the grant, and
 * resubmits the same input.
 */
const path = (ctx: { organizationSlug: string; branchSlug: string }) => `/${ctx.organizationSlug}/${ctx.branchSlug}/retail-pos`;

export const lookupBarcodeAction = defineTenantAction({
  schema: schemas.barcodeLookupSchema, permission: 'retail.pos.use',
  // A scanner fires fast; allow it.
  rateLimit: { limit: 600, windowMs: 60_000 },
  handler: async ({ ctx, input }) => retail.lookupBarcode(ctx, input.code),
});

export const previewPromotionsAction = defineTenantAction({
  schema: schemas.promotionsPreviewSchema, permission: 'retail.pos.use',
  rateLimit: { limit: 300, windowMs: 60_000 },
  handler: async ({ ctx, input }) => retail.previewPromotions(ctx, input),
});

export const checkoutAction = defineTenantAction({
  schema: schemas.checkoutSchema, permission: ['retail.pos.use', 'invoice.create'],
  rateLimit: { limit: 120, windowMs: 60_000 },
  handler: async ({ ctx, input }) => {
    const result = await retail.checkout(ctx, input);
    revalidatePath(path(ctx));
    return result;
  },
});

export const processReturnAction = defineTenantAction({
  schema: schemas.returnSchema, permission: 'retail.return.manage',
  rateLimit: { limit: 30, windowMs: 60_000 },
  handler: async ({ ctx, input }) => {
    const result = await retail.processReturn(ctx, input);
    revalidatePath(path(ctx));
    return result;
  },
});

export const storeCreditBalanceAction = defineTenantAction({
  schema: schemas.storeCreditBalanceSchema, permission: 'retail.pos.use',
  handler: async ({ ctx, input }) => ({ balanceCents: await retail.getStoreCreditBalance(ctx, input.customerId) }),
});
