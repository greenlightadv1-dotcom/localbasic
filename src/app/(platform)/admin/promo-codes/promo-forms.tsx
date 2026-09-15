'use client';

import { useState } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import { createPromoCodeAction, togglePromoCodeAction, type PromoState } from '../actions';

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="h-10 rounded bg-primary px-4 text-sm font-semibold text-primary-fg hover:bg-primary/90 disabled:opacity-50"
    >
      {pending ? '…' : label}
    </button>
  );
}

const FIELD = 'h-10 w-full rounded border border-line bg-elevated px-3 text-sm text-fg';

export function CreatePromoForm({
  plans,
  services,
}: {
  plans: { id: string; name_ar: string }[];
  services: { moduleKey: string; nameAr: string }[];
}) {
  const [state, action] = useFormState<PromoState, FormData>(createPromoCodeAction, undefined);
  // Only the field belonging to the chosen kind is shown — and only that one is
  // submitted, matching the database CHECK that ties the effect to the kind.
  const [kind, setKind] = useState<'percent' | 'fixed' | 'trial_days'>('percent');

  return (
    <form action={action} className="space-y-4 p-5">
      {state?.error ? (
        <p className="rounded border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">{state.error}</p>
      ) : null}
      {state?.ok ? (
        <p className="rounded border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">{state.ok}</p>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-fg">الرمز</span>
          <input name="code" required dir="ltr" placeholder="DEMO30" maxLength={32} className={FIELD} />
          <span className="mt-1 block text-[11px] text-muted">يُحوَّل لحروف كبيرة على الخادم.</span>
        </label>

        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-fg">النوع</span>
          <select
            name="kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as typeof kind)}
            className={FIELD}
          >
            <option value="percent">نسبة مئوية</option>
            <option value="fixed">مبلغ ثابت</option>
            <option value="trial_days">أيام تجربة</option>
          </select>
        </label>

        {kind === 'percent' ? (
          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold text-fg">نسبة الخصم %</span>
            <input name="percentOff" type="number" min={1} max={100} required className={FIELD} />
          </label>
        ) : null}
        {kind === 'fixed' ? (
          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold text-fg">قيمة الخصم (ج.م)</span>
            <input name="amountOff" type="number" min={1} step="0.01" required className={FIELD} />
          </label>
        ) : null}
        {kind === 'trial_days' ? (
          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold text-fg">أيام التجربة</span>
            <input name="trialDays" type="number" min={1} max={365} required className={FIELD} />
          </label>
        ) : null}

        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-fg">ينتهي في</span>
          <input name="endsAt" type="date" className={FIELD} />
        </label>

        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-fg">حد الاستخدام</span>
          <input name="maxRedemptions" type="number" min={1} placeholder="بلا حد" className={FIELD} />
        </label>

        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-fg">الباقة</span>
          <select name="planId" className={FIELD}>
            <option value="">كل الباقات</option>
            {plans.map((p) => <option key={p.id} value={p.id}>{p.name_ar}</option>)}
          </select>
        </label>

        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-fg">الخدمة</span>
          <select name="moduleKey" className={FIELD}>
            <option value="">كل الخدمات</option>
            {services.map((s) => <option key={s.moduleKey} value={s.moduleKey}>{s.nameAr}</option>)}
          </select>
        </label>

        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-fg">الوصف</span>
          <input name="description" maxLength={200} className={FIELD} />
        </label>
      </div>

      <label className="flex items-center gap-2">
        <input type="checkbox" name="newCustomersOnly" className="h-4 w-4 rounded border-line" />
        <span className="text-sm text-fg">للعملاء الجدد فقط</span>
      </label>

      <div className="flex items-center gap-3">
        <Submit label="إنشاء الرمز" />
        <p className="text-xs text-muted">
          قيمة الخصم تُطبَّق على الخادم عند التسعير — لا يحسبها المتصفح.
        </p>
      </div>
    </form>
  );
}

export function TogglePromoForm({ id, isActive }: { id: string; isActive: boolean }) {
  const [state, action] = useFormState<PromoState, FormData>(togglePromoCodeAction, undefined);
  return (
    <form action={action} className="inline-flex items-center gap-2">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="isActive" value={isActive ? 'false' : 'true'} />
      <button
        type="submit"
        className="rounded border border-line bg-elevated px-3 py-1 text-xs font-semibold text-fg hover:bg-surface"
      >
        {isActive ? 'إيقاف' : 'تفعيل'}
      </button>
      {state?.error ? <span className="text-xs text-danger">{state.error}</span> : null}
    </form>
  );
}
