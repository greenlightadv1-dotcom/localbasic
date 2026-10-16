/** Cashier risk events (0108): client-safe constants shared by the dashboard and the server. */

export const RISK_EVENTS = ['void_after_print', 'drawer_kick_no_sale', 'reprint_receipt', 'discount_over_limit', 'refund_processed'] as const;
export type RiskEvent = (typeof RISK_EVENTS)[number];
export const RISK_EVENT_LABELS: Record<RiskEvent, string> = {
  void_after_print: 'إلغاء بعد الطباعة',
  drawer_kick_no_sale: 'فتح الدرج بدون بيع',
  reprint_receipt: 'إعادة طباعة',
  discount_over_limit: 'خصم فوق الحد اليومي',
  refund_processed: 'استرداد',
};
export const RISK_EVENT_POINTS: Record<RiskEvent, number> = {
  void_after_print: 4, discount_over_limit: 3, drawer_kick_no_sale: 2, refund_processed: 2, reprint_receipt: 1,
};
export const RISK_FLAG_THRESHOLD = 10;


export type RiskRow = {
  userId: string; name: string; points: number; flagged: boolean; flaggedAt: string | null;
  counts: Record<RiskEvent, number>; refundCents: number; discountOverCents: number; windowPoints: number;
  refundLimitCents: number | null; discountLimitCents: number | null; lastEventAt: string | null; lastResetAt: string | null;
};

export type RiskLogEntry = {
  id: number; userId: string; event: RiskEvent; points: number; at: string; amountCents: number | null;
  reason: string | null; orderNumber: string | null; branchName: string | null; approvedBy: string | null;
};
