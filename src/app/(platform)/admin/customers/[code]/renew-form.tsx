'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { renewAction, type RenewState } from '../../actions';
import { BILLING_PERIODS, BILLING_PERIOD_LABELS } from '@/modules/platform/billing/schemas';

type Plan = { id: string; key: string; name_ar: string; price_cents: number; currency: string };

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="h-11 rounded bg-primary px-5 text-sm font-semibold text-primary-fg hover:bg-primary/90 disabled:opacity-50"
    >
      {pending ? 'جارٍ التسجيل…' : 'تسجيل التجديد (نقدي)'}
    </button>
  );
}

/**
 * Renewal form.
 *
 * Deliberately has no price field. The admin chooses a plan, a term and
 * optionally a code; the server prices it and records what was actually taken.
 */
export function RenewForm({
  organizationId,
  plans,
  currentPlanId,
}: {
  organizationId: string;
  plans: Plan[];
  currentPlanId: string | null;
}) {
  const [state, action] = useFormState<RenewState, FormData>(renewAction, undefined);

  return (
    <form action={action} className="space-y-4 p-5">
      <input type="hidden" name="organizationId" value={organizationId} />

      {state?.error ? (
        <p className="rounded border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
          {state.error}
        </p>
      ) : null}
      {state?.ok ? (
        <p className="rounded border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
          {state.ok}
        </p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-fg">الباقة</span>
          <select
            name="planId"
            defaultValue={currentPlanId ?? plans[0]?.id}
            required
            className="h-11 w-full rounded border border-line bg-elevated px-3 text-sm text-fg"
          >
            {plans.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name_ar} — {(p.price_cents / 100).toLocaleString('ar-EG')} {p.currency}/شهر
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-fg">المدة</span>
          <select
            name="billingPeriod"
            defaultValue="month"
            required
            className="h-11 w-full rounded border border-line bg-elevated px-3 text-sm text-fg"
          >
            {BILLING_PERIODS.map((p) => (
              <option key={p} value={p}>{BILLING_PERIOD_LABELS[p]}</option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-fg">
            رمز خصم / تجربة <span className="font-normal text-muted">(اختياري)</span>
          </span>
          <input
            name="promoCode"
            placeholder="DEMO30"
            dir="ltr"
            className="h-11 w-full rounded border border-line bg-elevated px-3 text-sm text-fg"
          />
        </label>

        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-fg">طريقة الدفع</span>
          <input
            value="نقدي (كاش)"
            readOnly
            className="h-11 w-full cursor-not-allowed rounded border border-line bg-surface px-3 text-sm text-muted"
          />
        </label>
      </div>

      <label className="block">
        <span className="mb-1.5 block text-xs font-semibold text-fg">
          ملاحظة <span className="font-normal text-muted">(اختياري)</span>
        </span>
        <input
          name="note"
          maxLength={500}
          className="h-11 w-full rounded border border-line bg-elevated px-3 text-sm text-fg"
        />
      </label>

      <div className="flex items-center gap-3">
        <Submit />
        <p className="text-xs text-muted">
          السعر والخصم وتاريخ الانتهاء تُحسب على الخادم من الباقة والمدة.
        </p>
      </div>
    </form>
  );
}
