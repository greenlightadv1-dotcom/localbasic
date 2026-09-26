'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { adjustDaysAction, switchPlanAction, type SubscriptionOpsState } from '../../actions';
import { BILLING_PERIODS, BILLING_PERIOD_LABELS } from '@/modules/platform/billing/schemas';

type Plan = { id: string; key: string; name_ar: string; price_cents: number; currency: string };

function Submit({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="h-11 rounded bg-primary px-5 text-sm font-semibold text-primary-fg hover:bg-primary/90 disabled:opacity-50"
    >
      {pending ? pendingLabel : label}
    </button>
  );
}

function Message({ state }: { state: SubscriptionOpsState }) {
  if (state?.error) {
    return (
      <p className="rounded border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
        {state.error}
      </p>
    );
  }
  if (state?.ok) {
    return (
      <p className="rounded border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
        {state.ok}
      </p>
    );
  }
  return null;
}

/** Extend or shorten the days left on the live term without a payment. */
export function AdjustDaysForm({ organizationId }: { organizationId: string }) {
  const [state, action] = useFormState<SubscriptionOpsState, FormData>(adjustDaysAction, undefined);

  return (
    <form action={action} className="space-y-4 p-5">
      <input type="hidden" name="organizationId" value={organizationId} />
      <Message state={state} />
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-fg">
            عدد الأيام <span className="font-normal text-muted">(موجب لإضافة، سالب لخصم)</span>
          </span>
          <input
            name="deltaDays"
            type="number"
            required
            step={1}
            placeholder="مثال: 7 أو -7"
            dir="ltr"
            className="h-11 w-full rounded border border-line bg-elevated px-3 text-sm text-fg"
          />
        </label>
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
      </div>
      <div className="flex items-center gap-3">
        <Submit label="تعديل المدة" pendingLabel="جارٍ التعديل…" />
        <p className="text-xs text-muted">لا تُسجَّل أي عملية دفع لهذا التعديل.</p>
      </div>
    </form>
  );
}

/**
 * Switch plan starting from now, discarding whatever days were left on the
 * old one — the opposite of the renewal form above, which extends the term.
 */
export function SwitchPlanForm({
  organizationId,
  plans,
  currentPlanId,
}: {
  organizationId: string;
  plans: Plan[];
  currentPlanId: string | null;
}) {
  const [state, action] = useFormState<SubscriptionOpsState, FormData>(switchPlanAction, undefined);

  return (
    <form action={action} className="space-y-4 p-5">
      <input type="hidden" name="organizationId" value={organizationId} />
      <Message state={state} />
      <p className="rounded border border-warn/30 bg-warn/10 px-3 py-2 text-xs font-semibold text-warn">
        هذا يبدأ مدة جديدة من الآن ويُلغي أي أيام متبقية من الباقة الحالية — على عكس نموذج
        التجديد أعلاه الذي يمدّد المدة الحالية.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-fg">الباقة الجديدة</span>
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
      <Submit label="تبديل الباقة (نقدي)" pendingLabel="جارٍ التبديل…" />
    </form>
  );
}
