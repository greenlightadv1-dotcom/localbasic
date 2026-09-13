import { z } from 'zod';

export const TABLE_STATUSES = [
  'available',
  'reserved',
  'occupied',
  'waiting_payment',
  'cleaning',
] as const;

export type TableStatus = (typeof TABLE_STATUSES)[number];

export const sectionSchema = z.object({
  name: z.string().trim().min(1, 'اسم المنطقة مطلوب').max(80),
  sortOrder: z.coerce.number().int().min(0).default(0),
});

export const tableSchema = z.object({
  name: z.string().trim().min(1, 'رقم أو اسم الطاولة مطلوب').max(40),
  sectionId: z.string().uuid().nullable().optional(),
  seats: z.coerce.number().int().min(1).max(100).default(4),
});

export const bulkTablesSchema = z.object({
  sectionId: z.string().uuid().nullable().optional(),
  from: z.coerce.number().int().min(1).max(999),
  to: z.coerce.number().int().min(1).max(999),
  seats: z.coerce.number().int().min(1).max(100).default(4),
});

export const tableStatusSchema = z.object({
  tableId: z.string().uuid(),
  status: z.enum(TABLE_STATUSES),
});

export const reissueQrSchema = z.object({ tableId: z.string().uuid() });
