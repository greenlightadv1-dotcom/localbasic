import { z } from 'zod';

/** Accepts "12.50" or 1250-style input and stores integer minor units. */
export const priceInput = z
  .union([z.string(), z.number()])
  .transform((v) => {
    const text = String(v).trim().replace(/[,\s]/g, '') || '0';
    if (!/^\d+(\.\d{0,2})?$/.test(text)) throw new Error('invalid');
    const [whole = '0', fraction = ''] = text.split('.');
    return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  })
  .pipe(z.number().int().nonnegative());

export const categorySchema = z.object({
  name: z.string().trim().min(1, 'اسم التصنيف مطلوب').max(120),
  description: z.string().trim().max(500).optional(),
  imageUrl: z.string().trim().url().max(2000).nullable().optional(),
  sortOrder: z.coerce.number().int().min(0).default(0),
});

export const setImageSchema = z.object({
  id: z.string().uuid(),
  imageUrl: z.string().trim().url().max(2000).nullable(),
});

export const menuProductSchema = z.object({
  name: z.string().trim().min(1, 'اسم الصنف مطلوب').max(200),
  categoryId: z.string().uuid().nullable().optional(),
  description: z.string().trim().max(1000).optional(),
  imageUrl: z.string().trim().url().max(2000).nullable().optional(),
  taxRatePercent: z.coerce.number().min(0).max(100).default(0),
  prepMinutes: z.coerce.number().int().min(0).max(600).default(0),
  variants: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(120).default('default'),
        priceCents: priceInput,
      }),
    )
    .min(1, 'أضف سعرًا واحدًا على الأقل')
    .max(10),
  modifierGroups: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(120),
        minSelect: z.coerce.number().int().min(0).max(20).default(0),
        maxSelect: z.coerce.number().int().min(1).max(20).default(1),
        modifiers: z
          .array(z.object({ name: z.string().trim().min(1).max(120), priceCents: priceInput }))
          .max(30),
      }),
    )
    .max(10)
    .default([]),
});

export type MenuProductInput = z.infer<typeof menuProductSchema>;

export const toggleProductSchema = z.object({
  productId: z.string().uuid(),
  isActive: z.coerce.boolean(),
});

export const toggleBestSellerSchema = z.object({
  productId: z.string().uuid(),
  isBestSeller: z.coerce.boolean(),
});

export const setAvailabilitySchema = z.object({
  variantId: z.string().uuid(),
  isAvailable: z.coerce.boolean(),
  note: z.string().trim().max(200).optional(),
});
