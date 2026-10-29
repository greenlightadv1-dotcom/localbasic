import { z } from 'zod';
import { createOrderSchema, orderItemInput } from '@/modules/restaurant/orders/schemas';

/**
 * The restaurant hub (/restaurant, 0117). Inputs only name things — menu
 * variants, modifier ids, quantities; every price and total is the
 * database's.
 */

/** A new order from the floor, optionally sent straight to the kitchen. */
export const hubOrderSchema = createOrderSchema.extend({
  sendToKitchen: z.coerce.boolean().default(true),
});
export type HubOrderInput = z.infer<typeof hubOrderSchema>;

/** Another round on an open check. */
export const addItemsSchema = z.object({
  orderId: z.string().uuid(),
  items: z.array(orderItemInput).min(1, 'أضف صنفًا واحدًا على الأقل').max(100),
});
export type AddItemsInput = z.infer<typeof addItemsSchema>;

export const modifierChoiceSchema = z.object({
  id: z.string().uuid().nullable().optional(),
  name: z.string().trim().min(1, 'اسم الاختيار مطلوب').max(120),
  priceCents: z.coerce.number().int().min(0, 'السعر لا يكون سالبًا').max(100_000_000),
  isActive: z.coerce.boolean().default(true),
});

export const modifierGroupSchema = z
  .object({
    groupId: z.string().uuid().nullable().optional(),
    productId: z.string().uuid().nullable().optional(),
    name: z.string().trim().min(1, 'اسم المجموعة مطلوب').max(120),
    minSelect: z.coerce.number().int().min(0).max(30),
    maxSelect: z.coerce.number().int().min(1).max(30),
    isActive: z.coerce.boolean().default(true),
    modifiers: z.array(modifierChoiceSchema).max(30, 'حتى 30 اختيارًا في المجموعة'),
  })
  .refine((g) => g.groupId || g.productId, { message: 'اختر الصنف', path: ['productId'] })
  .refine((g) => g.minSelect <= g.maxSelect, { message: 'الحد الأدنى أكبر من الأقصى', path: ['minSelect'] })
  .refine((g) => !g.isActive || g.minSelect <= g.modifiers.filter((m) => m.isActive).length, {
    message: 'الحد الأدنى أكبر من عدد الاختيارات المتاحة',
    path: ['minSelect'],
  });
export type ModifierGroupInput = z.infer<typeof modifierGroupSchema>;

export const copyGroupSchema = z.object({
  groupId: z.string().uuid(),
  productIds: z.array(z.string().uuid()).min(1, 'اختر صنفًا واحدًا على الأقل').max(200),
});

/** Table statuses as the floor names them; waiting_payment is "billing". */
export const HUB_TABLE_STATUS: Record<string, { label: string; tone: string; dot: string }> = {
  available: { label: 'متاحة', tone: 'border-emerald-500 bg-emerald-50 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100', dot: 'bg-emerald-500' },
  occupied: { label: 'مشغولة', tone: 'border-sky-500 bg-sky-50 text-sky-900 dark:bg-sky-950/40 dark:text-sky-100', dot: 'bg-sky-500' },
  reserved: { label: 'محجوزة', tone: 'border-violet-500 bg-violet-50 text-violet-900 dark:bg-violet-950/40 dark:text-violet-100', dot: 'bg-violet-500' },
  waiting_payment: { label: 'الحساب', tone: 'border-amber-500 bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-100', dot: 'bg-amber-500' },
  cleaning: { label: 'تنظيف', tone: 'border-slate-400 bg-slate-100 text-slate-800 dark:bg-slate-800/60 dark:text-slate-100', dot: 'bg-slate-400' },
};

export const HUB_TABS = ['tables', 'kds', 'modifiers'] as const;
export type HubTab = (typeof HUB_TABS)[number];
