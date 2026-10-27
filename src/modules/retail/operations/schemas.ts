import { z } from 'zod';

/**
 * Inputs for the retail operations of 0112 (and the barcode lookup of 0111).
 *
 * As with the POS sale, nothing monetary comes from the client except what a
 * person typed on purpose (cash tendered, store credit to spend, a manual
 * discount). Prices, promotion values and refund amounts are all computed by
 * the database.
 */

const uuid = z.string().uuid();
const qty = z.coerce.number().positive().max(100000);
const cents = z.coerce.number().int().nonnegative().max(1_000_000_000);
const method = z.enum(['cash', 'card', 'transfer', 'wallet', 'online', 'other']);
const reason = z.string().trim().max(300);

export const barcodeLookupSchema = z.object({ code: z.string().trim().min(1).max(64) });

// ---- transfers ---------------------------------------------------------------
export const transferRequestSchema = z.object({
  /** The branch that has the stock. The current branch is the one asking. */
  fromBranchId: uuid,
  items: z.array(z.object({ variantId: uuid, quantity: qty })).min(1, 'أضف صنفًا واحدًا على الأقل').max(500),
  reason: reason.optional(),
});

export const transferDecideSchema = z
  .object({ transferId: uuid, approve: z.boolean(), note: reason.optional() })
  .refine((v) => v.approve || (v.note ?? '').length > 0, { message: 'سبب الرفض مطلوب', path: ['note'] });

export const transferDispatchSchema = z.object({
  transferId: uuid,
  /** Only lines shipped short; 0 drops the line. */
  items: z.array(z.object({ variantId: uuid, quantity: z.coerce.number().nonnegative().max(100000) })).max(500).optional(),
});

export const transferReceiveSchema = z.object({
  transferId: uuid,
  /** Only lines counted short; the rest are received in full. */
  items: z.array(z.object({ variantId: uuid, quantityReceived: z.coerce.number().nonnegative().max(100000) })).max(500).optional(),
  note: reason.optional(),
});

export const transferCancelSchema = z.object({ transferId: uuid, reason: reason.min(1, 'سبب الإلغاء مطلوب') });

// ---- checkout ----------------------------------------------------------------
const cartItems = z
  .array(z.object({ variantId: uuid, quantity: qty, discountCents: cents.default(0) }))
  .min(1, 'السلة فارغة')
  .max(300);

export const promotionsPreviewSchema = z.object({
  items: z.array(z.object({ variantId: uuid, quantity: qty })).min(1).max(300),
  customerId: uuid.nullable().optional(),
  code: z.string().trim().max(32).optional(),
});

export const checkoutSchema = z.object({
  items: cartItems,
  method: method.default('cash'),
  tenderedCents: cents.default(0),
  customerId: uuid.nullable().optional(),
  promoCode: z.string().trim().max(32).optional(),
  storeCreditCents: cents.default(0),
  orderDiscountCents: cents.default(0),
  note: z.string().trim().max(500).optional(),
});

// ---- returns -----------------------------------------------------------------
export const returnSchema = z
  .object({
    invoiceId: uuid,
    items: z
      .array(z.object({
        variantId: uuid,
        quantity: qty,
        condition: z.enum(['resellable', 'damaged']).default('resellable'),
        note: reason.optional(),
      }))
      .min(1, 'اختر صنفًا واحدًا على الأقل')
      .max(300),
    resolution: z.enum(['cash', 'card', 'store_credit', 'exchange']),
    customerId: uuid.nullable().optional(),
    reason: reason.optional(),
    exchangeItems: cartItems.optional(),
    exchangeMethod: method.default('cash'),
    exchangeTenderedCents: cents.default(0),
  })
  .refine((v) => v.resolution !== 'exchange' || (v.exchangeItems?.length ?? 0) > 0, {
    message: 'اختر أصناف الاستبدال', path: ['exchangeItems'],
  });

export const storeCreditBalanceSchema = z.object({ customerId: uuid });

export const storeCreditAdjustSchema = z.object({
  customerId: uuid,
  deltaCents: z.coerce.number().int().refine((n) => n !== 0 && Math.abs(n) <= 100_000_000, 'قيمة غير صالحة'),
  note: reason.min(1, 'سبب التعديل مطلوب'),
});

export const emptySchema = z.object({}).strict();

export type TransferRequestInput = z.infer<typeof transferRequestSchema>;
export type TransferDecideInput = z.infer<typeof transferDecideSchema>;
export type TransferDispatchInput = z.infer<typeof transferDispatchSchema>;
export type TransferReceiveInput = z.infer<typeof transferReceiveSchema>;
export type TransferCancelInput = z.infer<typeof transferCancelSchema>;
export type PromotionsPreviewInput = z.infer<typeof promotionsPreviewSchema>;
export type CheckoutInput = z.infer<typeof checkoutSchema>;
export type ReturnInput = z.infer<typeof returnSchema>;
export type StoreCreditAdjustInput = z.infer<typeof storeCreditAdjustSchema>;
