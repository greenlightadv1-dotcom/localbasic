'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { createLeadAction, updateLeadAction, type LeadState } from '../actions';
import { LEAD_STATUSES, LEAD_STATUS_LABELS, LEAD_SOURCES, LEAD_SOURCE_LABELS } from '@/modules/platform/leads/schemas';

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

function Notice({ state }: { state: LeadState }) {
  if (state?.error) {
    return <p className="rounded border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">{state.error}</p>;
  }
  if (state?.ok) {
    return <p className="rounded border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">{state.ok}</p>;
  }
  return null;
}

export function CreateLeadForm({ services }: { services: { moduleKey: string; nameAr: string }[] }) {
  const [state, action] = useFormState<LeadState, FormData>(createLeadAction, undefined);

  return (
    <form action={action} className="space-y-4 p-5">
      <Notice state={state} />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-fg">الاسم</span>
          <input name="name" required maxLength={120}
            className="h-10 w-full rounded border border-line bg-elevated px-3 text-sm text-fg" />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-fg">الهاتف / واتساب</span>
          <input name="phone" required maxLength={32} dir="ltr"
            className="h-10 w-full rounded border border-line bg-elevated px-3 text-sm text-fg" />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-fg">اسم النشاط</span>
          <input name="businessName" maxLength={160}
            className="h-10 w-full rounded border border-line bg-elevated px-3 text-sm text-fg" />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-fg">الخدمة المطلوبة</span>
          <select name="requestedService"
            className="h-10 w-full rounded border border-line bg-elevated px-3 text-sm text-fg">
            {services.map((s) => (
              <option key={s.moduleKey} value={s.moduleKey}>{s.nameAr}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-fg">المصدر</span>
          <select name="source" defaultValue="whatsapp"
            className="h-10 w-full rounded border border-line bg-elevated px-3 text-sm text-fg">
            {LEAD_SOURCES.map((s) => (
              <option key={s} value={s}>{LEAD_SOURCE_LABELS[s]}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-fg">ملاحظات</span>
          <input name="notes" maxLength={4000}
            className="h-10 w-full rounded border border-line bg-elevated px-3 text-sm text-fg" />
        </label>
      </div>
      <Submit label="إضافة عميل محتمل" />
    </form>
  );
}

/** Inline status + notes editor on each row. */
export function UpdateLeadForm({
  id, status, notes,
}: {
  id: string; status: string; notes: string | null;
}) {
  const [state, action] = useFormState<LeadState, FormData>(updateLeadAction, undefined);

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="id" value={id} />
      <select
        name="status"
        defaultValue={status}
        aria-label="الحالة"
        className="h-9 rounded border border-line bg-elevated px-2 text-xs text-fg"
      >
        {LEAD_STATUSES.map((s) => (
          <option key={s} value={s}>{LEAD_STATUS_LABELS[s]}</option>
        ))}
      </select>
      <input
        name="notes"
        defaultValue={notes ?? ''}
        placeholder="ملاحظة"
        maxLength={4000}
        className="h-9 min-w-40 flex-1 rounded border border-line bg-elevated px-2 text-xs text-fg"
      />
      <Submit label="حفظ" />
      {state?.error ? <span className="text-xs text-danger">{state.error}</span> : null}
      {state?.ok ? <span className="text-xs text-success">{state.ok}</span> : null}
    </form>
  );
}
