'use client';

/**
 * Shared by both guest checkouts (QR and online) — same copy, same shape,
 * because it is the same requirement in both places: a first-time device
 * must prove the phone number before the order is handed to the cashier as
 * "verified". A recognised device never sees this at all.
 */
export function GuestVerifySheet({
  code,
  whatsappUrl,
  pending,
  error,
  onContinue,
  onCancel,
}: {
  code: string;
  whatsappUrl: string | null;
  pending: boolean;
  error: string | null;
  onContinue: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="space-y-3 rounded-[18px] border border-line bg-elevated p-4">
      <p className="text-sm font-semibold text-fg">تأكيد رقم الهاتف</p>
      <p className="text-sm text-muted">
        هذه أول مرة تطلب فيها من هذا الجهاز. لمنع الطلبات الوهمية، أرسل رمز التحقق عبر واتساب
        إلى المطعم — طلباتك القادمة من هذا الجهاز لن تحتاج هذه الخطوة مرة أخرى.
      </p>
      <p className="rounded-[13px] border border-line bg-surface p-3 text-center font-reem text-2xl tracking-[0.3em] text-fg">
        {code}
      </p>
      {whatsappUrl ? (
        <a
          href={whatsappUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex h-11 w-full items-center justify-center rounded-[13px] bg-[#25D366] text-sm font-extrabold text-white"
        >
          فتح واتساب وإرسال الرمز
        </a>
      ) : (
        <p className="text-sm text-danger">لم يضبط المطعم رقم واتساب بعد.</p>
      )}
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <button
        type="button"
        onClick={onContinue}
        disabled={pending}
        className="h-11 w-full rounded-[13px] border border-line text-sm font-semibold text-fg disabled:opacity-50"
      >
        {pending ? 'جارٍ الإرسال…' : 'أرسلت الرمز، أكمل الطلب'}
      </button>
      <button type="button" onClick={onCancel} className="w-full text-center text-xs text-muted">
        إلغاء
      </button>
    </div>
  );
}
