/**
 * Values the client forms need.
 *
 * Kept out of service.ts because that module is `server-only`; importing a
 * label from it would pull the Supabase server client into the browser bundle.
 */

export const ORDER_STATUS_AR: Record<string, string> = {
  new: 'قيد المراجعة',
  confirmed: 'تم التأكيد',
  preparing: 'يتم التحضير',
  ready: 'جاهز',
  served: 'تم التقديم',
  completed: 'مكتمل',
  cancelled: 'ملغي',
};

export const FULFILLMENT_AR: Record<string, string> = {
  pickup: 'استلام من الفرع',
  delivery: 'توصيل',
  dine_in: 'داخل المطعم',
  takeaway: 'تيك أواي',
};

/**
 * The receipt wording now lives in Core, because retail shows the same words
 * on the same kind of document. Re-exported here so existing imports keep
 * working and the text still has exactly one definition.
 */
export { RECEIPT_DISCLAIMER_AR } from '@/modules/core/legal/receipt';
