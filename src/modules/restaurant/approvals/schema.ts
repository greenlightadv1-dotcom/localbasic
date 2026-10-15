import { z } from 'zod';

/** Sensitive actions that a manager approves with a PIN (0103). */
export const APPROVAL_ACTIONS = ['order.cancel', 'order.discount', 'inventory.adjust', 'inventory.resolve', 'table.merge', 'check.split'] as const;
export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number];

export const APPROVAL_ACTION_LABELS: Record<ApprovalAction, string> = {
  'order.cancel': 'إلغاء طلب أُرسل للتحضير',
  'order.discount': 'خصم على الطلب',
  'inventory.adjust': 'تسوية يدوية للمخزون',
  'inventory.resolve': 'تسوية فرق استلام',
  'table.merge': 'دمج طاولات في فاتورة واحدة',
  'check.split': 'تقسيم فاتورة',
};

export const grantSchema = z.object({
  action: z.enum(APPROVAL_ACTIONS),
  subjectId: z.string().uuid(),
  amount: z.coerce.number().min(0).nullable().optional(),
  approverMemberId: z.string().uuid(),
  pin: z.string().regex(/^[0-9]{4,8}$/, 'الرمز من 4 إلى 8 أرقام'),
});

export const setPinSchema = z
  .object({ pin: z.string().regex(/^[0-9]{4,8}$/, 'الرمز من 4 إلى 8 أرقام'), confirm: z.string() })
  .refine((v) => v.pin === v.confirm, { message: 'الرمزان غير متطابقين', path: ['confirm'] });

export const zoneSchema = z.object({
  memberId: z.string().uuid(),
  restricted: z.boolean(),
  sectionIds: z.array(z.string().uuid()).max(100).default([]),
  allowTakeaway: z.boolean().default(true),
  allowOnline: z.boolean().default(false),
});
