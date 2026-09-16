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
 * The wording the platform is required to show on any customer-facing
 * financial document. Local Basic issues RECEIPTS. It does not claim, and must
 * never appear to claim, Egyptian e-invoice status.
 */
export const RECEIPT_DISCLAIMER_AR =
  'هذا إيصال داخلي وليس فاتورة ضريبية معتمدة من منظومة الفاتورة الإلكترونية المصرية. ' +
  'التكامل مع المنظومة الضريبية مؤجل لمرحلة لاحقة، وصاحب النشاط (العميل) مسؤول بشكل ' +
  'مستقل عن التزاماته الضريبية تجاه مصلحة الضرائب المصرية.';
