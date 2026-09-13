import { z } from 'zod';

/**
 * What the POS is allowed to send.
 *
 * Note what is absent: no prices, no totals, no tax. The client identifies
 * variants and quantities; everything monetary is read back from the database
 * by retail_create_sale and recomputed there.
 */
export const posSaleSchema = z.object({
  items: z
    .array(
      z.object({
        variantId: z.string().uuid(),
        quantity: z.coerce.number().positive().max(100000),
        discountCents: z.coerce.number().int().nonnegative().default(0),
      }),
    )
    .min(1, 'السلة فارغة'),
  method: z.enum(['cash', 'card', 'transfer', 'wallet', 'other']).default('cash'),
  tenderedCents: z.coerce.number().int().nonnegative().default(0),
  customerId: z.string().uuid().nullable().optional(),
  orderDiscountCents: z.coerce.number().int().nonnegative().default(0),
  note: z.string().trim().max(500).optional(),
});

export type PosSaleInput = z.infer<typeof posSaleSchema>;

export const posReturnSchema = z.object({
  invoiceId: z.string().uuid(),
  items: z
    .array(z.object({ variantId: z.string().uuid(), quantity: z.coerce.number().positive() }))
    .min(1),
  method: z.enum(['cash', 'card', 'transfer', 'wallet', 'other']).default('cash'),
  reason: z.string().trim().max(500).optional(),
});
