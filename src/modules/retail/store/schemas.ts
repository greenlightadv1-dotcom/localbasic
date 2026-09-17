import { z } from 'zod';

/**
 * The storefront's input contract.
 *
 * Everything here arrives from an anonymous browser, so it is deliberately
 * narrow: identifiers and quantities, contact details, and an address when the
 * order is being delivered. There is no price, no total, no fee and no
 * organization id — those are the database's to decide, and a field that does
 * not exist cannot be forged.
 */

const slug = z.string().trim().min(1).max(80);

const quantity = z.coerce
  .number()
  .positive('الكمية يجب أن تكون أكبر من صفر')
  .max(1000, 'كمية كبيرة جدًا');

export const cartItem = z.object({
  variantId: z.string().uuid(),
  quantity,
});

export const fulfillmentTypes = ['pickup', 'delivery'] as const;
export const paymentMethods = ['cash_on_delivery', 'pay_on_collection'] as const;

export const storefrontInput = z.object({
  orgSlug: slug,
  branchSlug: slug.optional(),
});

export const quoteInput = z.object({
  orgSlug: slug,
  branchSlug: slug,
  items: z.array(cartItem).min(1, 'السلة فارغة').max(100),
  fulfillment: z.enum(fulfillmentTypes).default('pickup'),
});

export const checkoutInput = z.object({
  orgSlug: slug,
  branchSlug: slug,
  items: z.array(cartItem).min(1, 'السلة فارغة').max(100),
  fulfillment: z.enum(fulfillmentTypes),
  paymentMethod: z.enum(paymentMethods).default('cash_on_delivery'),
  contactName: z.string().trim().min(2, 'الاسم مطلوب').max(120),
  contactPhone: z.string().trim().min(6, 'رقم الهاتف مطلوب').max(30),
  note: z.string().trim().max(500).optional().or(z.literal('')),
  /** Generated once per checkout attempt by the browser; absorbs a double click. */
  idempotencyKey: z.string().trim().min(8).max(80),
  // Delivery only. Validated again in the database, which is what actually
  // refuses a delivery order with no address.
  recipientName: z.string().trim().max(120).optional().or(z.literal('')),
  addressPhone: z.string().trim().max(30).optional().or(z.literal('')),
  city: z.string().trim().max(80).optional().or(z.literal('')),
  area: z.string().trim().max(120).optional().or(z.literal('')),
  addressLine: z.string().trim().max(400).optional().or(z.literal('')),
  landmark: z.string().trim().max(200).optional().or(z.literal('')),
});

export const orderToken = z.string().trim().min(10).max(120);

export type CartItem = z.infer<typeof cartItem>;
export type QuoteInput = z.infer<typeof quoteInput>;
export type CheckoutInput = z.infer<typeof checkoutInput>;
export type FulfillmentType = (typeof fulfillmentTypes)[number];
export type PaymentMethod = (typeof paymentMethods)[number];
