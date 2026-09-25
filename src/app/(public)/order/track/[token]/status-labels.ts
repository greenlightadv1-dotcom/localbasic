/** The full order-status enum, in Arabic — shared by the server-rendered
 *  initial paint and the client-side live updater so the two never drift. */
export const STATUS_LABELS: Record<string, string> = {
  new: 'بانتظار تأكيد المطعم',
  confirmed: 'تم تأكيد الطلب',
  preparing: 'جارٍ التحضير',
  ready: 'الطلب جاهز',
  served: 'تم التسليم',
  completed: 'مكتمل',
  cancelled: 'ملغي',
};
