import { z } from 'zod';

const cents = z
  .union([z.string(), z.number()])
  .transform((v) => {
    const text = String(v).trim().replace(/[,\s]/g, '');
    if (!/^\d+(\.\d{0,2})?$/.test(text)) throw new Error('invalid');
    const [whole = '0', fraction = ''] = text.split('.');
    return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  })
  .pipe(z.number().int().nonnegative());

export const productUnits = ['piece', 'kg', 'gram', 'litre', 'metre', 'box', 'pack'] as const;

export const createProductSchema = z.object({
  name: z.string().trim().min(1, 'اسم المنتج مطلوب').max(200),
  categoryId: z.string().uuid().nullable().optional(),
  description: z.string().trim().max(2000).optional(),
  unit: z.enum(productUnits).default('piece'),
  // Tax is entered as a percentage and stored as basis points, so 14% is 1400
  // and no float ever touches the database.
  taxRatePercent: z.coerce.number().min(0).max(100).default(0),
  isOnline: z.coerce.boolean().default(true),
  // A product always gets at least one variant; a simple product gets one
  // called "default" so pricing, stock and sales have a single shape.
  variants: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(120).default('default'),
        sku: z.string().trim().max(64).optional().or(z.literal('')),
        barcode: z.string().trim().max(64).optional().or(z.literal('')),
        priceCents: cents,
        costCents: cents.optional(),
        reorderPoint: z.coerce.number().min(0).default(0),
        openingQuantity: z.coerce.number().min(0).default(0),
      }),
    )
    .min(1, 'أضف سعرًا واحدًا على الأقل'),
});

export type CreateProductInput = z.infer<typeof createProductSchema>;

export const updateProductSchema = createProductSchema
  .omit({ variants: true })
  .extend({ id: z.string().uuid() });

export const createCategorySchema = z.object({
  name: z.string().trim().min(1, 'اسم التصنيف مطلوب').max(120),
});

export const adjustStockSchema = z.object({
  variantId: z.string().uuid(),
  // Signed: negative removes stock. The reason decides which permission the
  // database will demand.
  quantityDelta: z.coerce.number().refine((v) => v !== 0, 'أدخل كمية'),
  reason: z.enum(['adjustment', 'damage', 'stocktake', 'transfer_in', 'transfer_out', 'initial']),
  note: z.string().trim().max(500).optional(),
});
