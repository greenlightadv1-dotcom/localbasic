'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { onboardCustomerAction, type OnboardState } from '../actions';
import { BILLING_PERIODS, BILLING_PERIOD_LABELS } from '@/modules/platform/billing/schemas';

const FIELD = 'h-11 w-full rounded border border-line bg-elevated px-3 text-sm text-fg';

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="h-11 rounded bg-primary px-6 text-sm font-semibold text-primary-fg hover:bg-primary/90 disabled:opacity-50"
    >
      {pending ? 'جارٍ الإنشاء…' : 'إنشاء مساحة العمل'}
    </button>
  );
}

export function OnboardForm({
  plans,
  services,
  leads,
  canInvite,
}: {
  plans: { id: string; name_ar: string; price_cents: number; currency: string }[];
  services: { moduleKey: string; nameAr: string }[];
  leads: { id: string; name: string; businessName: string | null }[];
  canInvite: boolean;
}) {
  const [state, action] = useFormState<OnboardState, FormData>(onboardCustomerAction, undefined);

  return (
    <form action={action} className="space-y-5 p-5">
      {state?.error ? (
        <p className="rounded border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">{state.error}</p>
      ) : null}
      {state?.ok ? (
        <p className="rounded border border-success/30 bg-success/10 px-3 py-2 text-sm font-semibold text-success">
          {state.ok}
        </p>
      ) : null}

      <fieldset className="space-y-3">
        <legend className="mb-2 text-xs font-bold text-fg">المالك</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold text-fg">بريد المالك</span>
            <input name="ownerEmail" type="email" required dir="ltr" className={FIELD} />
            <span className="mt-1 block text-[11px] text-muted">
              {canInvite
                ? 'إن لم يكن له حساب، تُرسَل دعوة ليضبط كلمة المرور بنفسه.'
                : 'يجب أن يكون للمالك حساب بالفعل — إنشاء الحسابات غير مُهيأ.'}
            </span>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold text-fg">اسم المالك</span>
            <input name="ownerName" required maxLength={120} className={FIELD} />
          </label>
        </div>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="mb-2 text-xs font-bold text-fg">المنشأة</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold text-fg">اسم المنشأة</span>
            <input name="organizationName" required maxLength={120} className={FIELD} />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold text-fg">المعرّف (في الرابط)</span>
            <input name="slug" required dir="ltr" placeholder="alhara" className={FIELD} />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold text-fg">الخدمة</span>
            <select name="moduleKey" required className={FIELD}>
              {services.map((s) => <option key={s.moduleKey} value={s.moduleKey}>{s.nameAr}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold text-fg">اسم الفرع الرئيسي</span>
            <input name="branchName" maxLength={120} placeholder="الفرع الرئيسي" className={FIELD} />
          </label>
        </div>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="mb-2 text-xs font-bold text-fg">الاشتراك</legend>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold text-fg">الباقة</span>
            <select name="planId" required className={FIELD}>
              {plans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name_ar} — {(p.price_cents / 100).toLocaleString('ar-EG')} {p.currency}/شهر
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold text-fg">المدة</span>
            <select name="billingPeriod" defaultValue="month" required className={FIELD}>
              {BILLING_PERIODS.map((p) => (
                <option key={p} value={p}>{BILLING_PERIOD_LABELS[p]}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold text-fg">رمز خصم (اختياري)</span>
            <input name="promoCode" dir="ltr" placeholder="DEMO30" className={FIELD} />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold text-fg">طريقة الدفع</span>
            <input value="نقدي (كاش)" readOnly className={`${FIELD} cursor-not-allowed bg-surface text-muted`} />
          </label>
        </div>
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-fg">ربط بعميل محتمل (اختياري)</span>
          <select name="leadId" className={FIELD}>
            <option value="">بدون</option>
            {leads.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}{l.businessName ? ` — ${l.businessName}` : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-fg">ملاحظة</span>
          <input name="note" maxLength={500} className={FIELD} />
        </label>
      </div>

      <div className="flex items-center gap-3 border-t border-line pt-4">
        <Submit />
        <p className="text-xs text-muted">
          السعر والخصم وتاريخ الانتهاء وكود العميل تُحدَّد كلها على الخادم.
        </p>
      </div>
    </form>
  );
}
