import { z } from 'zod';

/**
 * Customer account input.
 *
 * Note what is absent: there is no organizationId, customerId, userId or
 * addressId-as-identity anywhere in these schemas. The organization comes from
 * the slug in the URL the customer is already on, and the customer row comes
 * from the session. The only id a customer may send is one that is then used
 * as a filter against their own row — never as a claim about who they are.
 */

/** A public slug. Constrained so a hostile value never reaches the database. */
export const orgSlug = z
  .string()
  .trim()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/i, 'معرّف غير صالح');

export const profileInput = z.object({
  orgSlug,
  name: z.string().trim().min(2, 'الاسم مطلوب').max(120, 'الاسم طويل'),
  phone: z
    .string()
    .trim()
    .max(32)
    .refine((v) => v === '' || v.length >= 6, 'رقم الهاتف غير صحيح')
    .optional(),
  // Contact-only — never an Auth identity. See 0077.
  email: z
    .string()
    .trim()
    .max(200)
    .refine((v) => v === '' || z.string().email().safeParse(v).success, 'بريد إلكتروني غير صحيح')
    .optional(),
});

export const settingsInput = z.object({
  orgSlug,
  marketing: z.boolean(),
  orderUpdates: z.boolean(),
});

export const favoriteInput = z.object({
  orgSlug,
  productId: z.string().uuid('منتج غير صالح'),
});

export const addressInput = z.object({
  orgSlug,
  id: z.string().uuid().optional(),
  label: z.string().trim().min(1, 'اسم العنوان مطلوب').max(60),
  address: z.string().trim().min(5, 'العنوان غير مكتمل').max(500),
  recipientName: z.string().trim().max(120).optional(),
  phone: z.string().trim().max(32).optional(),
  city: z.string().trim().max(120).optional(),
  area: z.string().trim().max(120).optional(),
  landmark: z.string().trim().max(240).optional(),
  isDefault: z.boolean().optional(),
});

export const addressRef = z.object({ orgSlug, id: z.string().uuid() });

export const orderRef = z.object({
  orgSlug,
  /** The human order number, not an id. Scoped to the caller's own history. */
  number: z.string().trim().min(1).max(40),
});

/** The order-status token, in the same shape D1 mints. */
export const claimInput = z.object({
  token: z.string().trim().min(22).max(64).regex(/^[A-Za-z0-9_-]+$/),
});

export type ProfileInput = z.infer<typeof profileInput>;
export type AddressInput = z.infer<typeof addressInput>;
