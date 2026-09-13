'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { defineTenantAction } from '@/lib/action';
import { createProductSchema, adjustStockSchema, createCategorySchema } from '@/modules/retail/products/schemas';
import { createProduct, createCategory } from '@/modules/retail/products/service';
import { adjustStock } from '@/modules/retail/inventory/service';
import { posSaleSchema, posReturnSchema } from '@/modules/retail/pos/schemas';
import { createSale } from '@/modules/retail/pos/service';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { AppError, toAppError } from '@/lib/errors';

/**
 * Every action below declares the permission it needs. The wrapper enforces it
 * against the tenant context resolved from the URL, before the handler runs
 * and before any input is trusted.
 */

export const createProductAction = defineTenantAction({
  schema: createProductSchema,
  permission: 'retail.product.manage',
  handler: async ({ ctx, input }) => {
    const result = await createProduct(ctx, input);
    revalidatePath(`/${ctx.organizationSlug}/${ctx.branchSlug}/products`);
    return result;
  },
});

export const createCategoryAction = defineTenantAction({
  schema: createCategorySchema,
  permission: 'retail.product.manage',
  handler: async ({ ctx, input }) => createCategory(ctx, input.name),
});

export const adjustStockAction = defineTenantAction({
  schema: adjustStockSchema,
  permission: 'retail.inventory.adjust',
  handler: async ({ ctx, input }) => {
    await adjustStock(ctx, input);
    revalidatePath(`/${ctx.organizationSlug}/${ctx.branchSlug}/inventory`);
    return { ok: true };
  },
});

export const createSaleAction = defineTenantAction({
  schema: posSaleSchema,
  permission: 'retail.pos.use',
  handler: async ({ ctx, input }) => {
    const sale = await createSale(ctx, input);
    revalidatePath(`/${ctx.organizationSlug}/${ctx.branchSlug}/pos`);
    return sale;
  },
});

export const createReturnAction = defineTenantAction({
  schema: posReturnSchema,
  permission: 'payment.refund',
  handler: async ({ ctx, input }) => {
    const supabase = createSupabaseServerClient();
    const { data, error } = await supabase
      .rpc('retail_create_return', {
        p_org: ctx.organizationId,
        p_branch: ctx.branchId,
        p_invoice: input.invoiceId,
        p_items: input.items.map((i) => ({ variant_id: i.variantId, quantity: i.quantity })),
        p_method: input.method,
        p_reason: input.reason ?? null,
      })
      .single();

    if (error?.code === '42501') throw new AppError('forbidden');
    if (error) throw toAppError(error, 'createReturn');

    const row = data as unknown as { out_refund_cents: number; out_payment_id: string } | null;
    revalidatePath(`/${ctx.organizationSlug}/${ctx.branchSlug}/invoices`);
    return { refundCents: row?.out_refund_cents ?? 0, paymentId: row?.out_payment_id ?? null };
  },
});

const searchSchema = z.object({ term: z.string().trim().max(100) });

export const searchCustomersAction = defineTenantAction({
  schema: searchSchema,
  permission: 'customer.read',
  handler: async ({ ctx, input }) => {
    const supabase = createSupabaseServerClient();
    const term = input.term.replace(/[%_\\]/g, (m) => `\\${m}`);
    const { data } = await supabase
      .from('customers')
      .select('id, name, phone')
      .eq('organization_id', ctx.organizationId)
      .is('deleted_at', null)
      .or(`name.ilike.%${term}%,phone.ilike.%${term}%`)
      .limit(10);
    return data ?? [];
  },
});
