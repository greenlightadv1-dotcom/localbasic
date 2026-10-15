import { z } from 'zod';

/** Floor plan, table operations and the waiting list (0105). */

export const TABLE_SHAPES = ['square', 'round', 'rect'] as const;
export type TableShape = (typeof TABLE_SHAPES)[number];

export const layoutSchema = z.object({
  tables: z
    .array(
      z.object({
        id: z.string().uuid(),
        sectionId: z.string().uuid().nullable(),
        x: z.number().min(0).max(100),
        y: z.number().min(0).max(100),
        w: z.number().min(4).max(60),
        h: z.number().min(4).max(60),
        shape: z.enum(TABLE_SHAPES),
      }),
    )
    .max(500),
});

export const transferSchema = z.object({
  fromTableId: z.string().uuid(),
  toTableId: z.string().uuid(),
  orderId: z.string().uuid().nullable().optional(),
});

export const mergeSchema = z.object({
  targetTableId: z.string().uuid(),
  sourceTableIds: z.array(z.string().uuid()).min(1, 'اختر طاولة واحدة على الأقل للدمج').max(20),
});

export const unmergeSchema = z.object({ tableId: z.string().uuid() });

export const splitSchema = z.object({
  orderId: z.string().uuid(),
  lines: z
    .array(z.object({ itemId: z.string().uuid(), qty: z.number().positive() }))
    .min(1, 'اختر الأصناف المراد فصلها')
    .max(100),
});

export const seatSchema = z.object({
  itemIds: z.array(z.string().uuid()).min(1).max(200),
  seat: z.number().int().min(1).max(99).nullable(),
});

export const checkLinesSchema = z.object({ orderId: z.string().uuid() });

export const WAITLIST_ACTIONS = ['assign', 'notify', 'seat', 'cancel', 'no_show'] as const;

export const waitlistAddSchema = z
  .object({
    guestName: z.string().trim().min(1, 'اسم الضيف مطلوب').max(80),
    guestPhone: z
      .string()
      .trim()
      .max(30)
      .regex(/^[0-9+ ()-]{5,30}$/, 'رقم الهاتف غير صالح')
      .optional()
      .or(z.literal('')),
    partySize: z.coerce.number().int().min(1, 'عدد الأشخاص غير صالح').max(50),
    kind: z.enum(['walk_in', 'reservation']).default('walk_in'),
    reservedFor: z.string().datetime({ offset: true }).nullable().optional(),
    note: z.string().trim().max(300).optional(),
  })
  .refine((v) => v.kind === 'walk_in' || Boolean(v.reservedFor), {
    message: 'حدد موعد الحجز',
    path: ['reservedFor'],
  });

export const waitlistActionSchema = z.object({
  id: z.string().uuid(),
  action: z.enum(WAITLIST_ACTIONS),
  tableId: z.string().uuid().nullable().optional(),
});

export const estimateSchema = z.object({ partySize: z.coerce.number().int().min(1).max(50) });

/** The floor's colour language. */
export const TABLE_STATUS_STYLE: Record<string, { label: string; tone: string }> = {
  available: { label: 'متاحة', tone: 'available' },
  occupied: { label: 'مشغولة', tone: 'occupied' },
  waiting_payment: { label: 'طلب الحساب', tone: 'bill' },
  reserved: { label: 'محجوزة', tone: 'reserved' },
  cleaning: { label: 'تنظيف', tone: 'cleaning' },
};
