import { z } from 'zod';

export const ORDER_STATUSES = [
  'new',
  'confirmed',
  'preparing',
  'ready',
  'served',
  'completed',
  'cancelled',
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

/**
 * What a client may send when creating an order.
 *
 * Note what is absent: no prices, no line totals, no order total. The client
 * names menu items, quantities and modifier choices; every figure is resolved
 * from the database server-side.
 */
export const orderItemInput = z.object({
  variantId: z.string().uuid(),
  quantity: z.coerce.number().positive().max(999),
  modifierIds: z.array(z.string().uuid()).max(30).default([]),
  note: z.string().trim().max(200).optional(),
});

export const createOrderSchema = z.object({
  items: z.array(orderItemInput).min(1, 'أضف صنفًا واحدًا على الأقل').max(100),
  tableId: z.string().uuid().nullable().optional(),
  type: z.enum(['dine_in', 'takeaway']).default('dine_in'),
  customerId: z.string().uuid().nullable().optional(),
  note: z.string().trim().max(500).optional(),
});

export const setStatusSchema = z.object({
  orderId: z.string().uuid(),
  status: z.enum(ORDER_STATUSES),
  reason: z.string().trim().max(300).optional(),
});

export const payOrderSchema = z.object({
  orderId: z.string().uuid(),
  method: z.enum(['cash', 'card', 'transfer', 'wallet', 'other']).default('cash'),
  tenderedCents: z.coerce.number().int().nonnegative().default(0),
  discountCents: z.coerce.number().int().nonnegative().default(0),
});

/** The public (guest) order. The token is the only identity involved. */
export const publicOrderSchema = z.object({
  token: z.string().min(22).max(64),
  items: z.array(orderItemInput).min(1).max(50),
  guestName: z.string().trim().max(80).optional(),
  guestPhone: z.string().trim().max(30).optional(),
  note: z.string().trim().max(300).optional(),
});

export const STATUS_LABELS: Record<OrderStatus, string> = {
  new: 'جديد',
  confirmed: 'مؤكد',
  preparing: 'تحت التحضير',
  ready: 'جاهز',
  served: 'تم التقديم',
  completed: 'مكتمل',
  cancelled: 'ملغي',
};

export const STATUS_TONES: Record<OrderStatus, 'neutral' | 'info' | 'warn' | 'success' | 'danger'> =
  {
    new: 'warn',
    confirmed: 'info',
    preparing: 'info',
    ready: 'success',
    served: 'neutral',
    completed: 'neutral',
    cancelled: 'danger',
  };
