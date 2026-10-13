'use client';

/**
 * Shared by both guest checkouts (QR and online) — same copy, same shape.
 *
 * The order already exists by the time this renders (0086): it is sitting at
 * 'pending_verification', not waiting to be created. Tapping the WhatsApp
 * link and sending the message is enough — the gateway webhook advances the
 * order automatically, and the parent component's realtime subscription on
 * this same order is what notices and moves on. "تحقق الآن" is the manual
 * fallback for when that round trip does not land (gateway hiccup, a closed
 * tab that missed the broadcast): it just re-reads the order's current
 * status instead of waiting on the socket.
 */
export function GuestVerifySheet({
  code,
  whatsappUrl,
  checking,
  error,
  onRecheck,
}: {
  code: string;
  whatsappUrl: string;
  checking: boolean;
  error: string | null;
  onRecheck: () => void;
}) {
  return (
    <div className="space-y-3 rounded-[18px] border border-line bg-elevated p-4">
      <p className="text-sm font-semibold text-fg">تأكيد رقم الهاتف</p>
      <p className="text-sm text-muted">
        هذه أول مرة تطلب فيها من هذا الجهاز. اضغط الزر لفتح واتساب وإرسال الرمز إلى المطعم —
        سيُرسل طلبك للمراجعة تلقائيًا بمجرد وصول الرسالة. طلباتك القادمة من هذا الجهاز لن
        تحتاج هذه الخطوة مرة أخرى.
      </p>
      <p className="rounded-[13px] border border-line bg-surface p-3 text-center font-reem text-2xl tracking-[0.3em] text-fg">
        {code}
      </p>
      <a
        href={whatsappUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="flex h-11 w-full items-center justify-center rounded-[13px] bg-[#25D366] text-sm font-extrabold text-white"
      >
        فتح واتساب وإرسال الرمز
      </a>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <p className="flex items-center justify-center gap-2 text-xs text-muted" aria-live="polite">
        <span className="h-2 w-2 animate-pulse rounded-full bg-primary" aria-hidden="true" />
        في انتظار التحقق…
      </p>
      <button
        type="button"
        onClick={onRecheck}
        disabled={checking}
        className="h-11 w-full rounded-[13px] border border-line text-sm font-semibold text-fg disabled:opacity-50"
      >
        {checking ? 'جارٍ التحقق…' : 'تحقق الآن'}
      </button>
    </div>
  );
}
