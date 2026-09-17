import { z } from 'zod';

/**
 * Money in, money out — always integer minor units.
 *
 * A supplier cost is typed by a human as "30" or "30.50", so it is parsed
 * here and never touches a float. This mirrors the product schema rather than
 * importing from it: the two happen to agree today, and a cost is free to
 * grow its own rules later without dragging the selling price along.
 */
const cents = z
  .union([z.string(), z.number()])
  .transform((v, ctx) => {
    const text = String(v).trim().replace(/[,\s]/g, '');
    if (!/^\d+(\.\d{0,2})?$/.test(text)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'مبلغ غير صالح' });
      return z.NEVER;
    }
    const [whole = '0', fraction = ''] = text.split('.');
    return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  })
  .pipe(z.number().int().nonnegative());

/** Quantities may be fractional — a shop buys 2.5 kg as readily as 3 boxes. */
const quantity = z.coerce
  .number()
  .positive('الكمية يجب أن تكون أكبر من صفر')
  .max(1_000_000, 'كمية غير معقولة');

export const supplierSchema = z.object({
  name: z.string().trim().min(1, 'اسم المورد مطلوب').max(160),
  phone: z.string().trim().max(40).optional().or(z.literal('')),
  email: z.string().trim().email('بريد غير صالح').max(160).optional().or(z.literal('')),
  address: z.string().trim().max(500).optional().or(z.literal('')),
  taxId: z.string().trim().max(64).optional().or(z.literal('')),
  notes: z.string().trim().max(2000).optional().or(z.literal('')),
});

export const createPurchaseSchema = z.object({
  supplierId: z.string().uuid('اختر موردًا').nullable().optional(),
  expectedAt: z.string().trim().optional().or(z.literal('')),
  note: z.string().trim().max(2000).optional().or(z.literal('')),
  lines: z
    .array(
      z.object({
        variantId: z.string().uuid(),
        quantity,
        unitCostCents: cents,
      }),
    )
    .min(1, 'أضف صنفًا واحدًا على الأقل')
    .max(200, 'عدد الأصناف كبير جدًا'),
});

export const receiveSchema = z.object({
  purchaseOrderId: z.string().uuid(),
  note: z.string().trim().max(500).optional().or(z.literal('')),
  lines: z
    .array(z.object({ itemId: z.string().uuid(), quantity }))
    .min(1, 'حدّد كمية واحدة على الأقل للاستلام'),
});

export const paySchema = z.object({
  purchaseOrderId: z.string().uuid(),
  amountCents: cents.pipe(z.number().int().positive('أدخل مبلغًا أكبر من صفر')),
  note: z.string().trim().max(500).optional().or(z.literal('')),
});

export type SupplierInput = z.infer<typeof supplierSchema>;
export type CreatePurchaseInput = z.infer<typeof createPurchaseSchema>;
export type ReceiveInput = z.infer<typeof receiveSchema>;
export type PayInput = z.infer<typeof paySchema>;
