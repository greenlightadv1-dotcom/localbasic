import { z } from 'zod';
import { priceInput } from '@/modules/restaurant/menu/schemas';

/**
 * Bundles/packages: display-only merchandising cards for the customer-facing
 * site. Not a sellable POS catalog item — see restaurant_bundles' own
 * migration comment (0066) for why that is a deliberate, separate scope.
 */
export const bundleSchema = z.object({
  name: z.string().trim().min(1, 'الاسم مطلوب').max(200, 'الاسم طويل جدًا'),
  description: z.string().trim().max(1000).optional().or(z.literal('')),
  imageUrl: z.string().trim().url('رابط غير صحيح').max(2000).optional().or(z.literal('')),
  priceCents: priceInput,
});

export type BundleInput = z.infer<typeof bundleSchema>;

export const toggleBundleActiveSchema = z.object({
  bundleId: z.string().uuid(),
  isActive: z.coerce.boolean(),
});

export const setBundleImageSchema = z.object({
  bundleId: z.string().uuid(),
  imageUrl: z.string().trim().url().max(2000).nullable(),
});
