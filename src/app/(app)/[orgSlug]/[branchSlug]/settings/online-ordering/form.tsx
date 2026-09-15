'use client';

import { useState } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import { saveOnlineSettingsAction, type SettingsState } from './actions';
import type { OnlineSettings } from '@/modules/restaurant/online/settings';

function Save() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="h-12 w-full rounded bg-primary text-base font-semibold text-primary-fg hover:bg-primary/90 disabled:opacity-50 sm:w-auto sm:px-8"
    >
      {pending ? 'جارٍ الحفظ…' : 'حفظ الإعدادات'}
    </button>
  );
}

/** A full-width switch row: comfortable to tap on a phone. */
function Toggle({
  name, label, hint, defaultChecked, onChange,
}: {
  name: string;
  label: string;
  hint?: string;
  defaultChecked: boolean;
  onChange?: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 rounded border border-line bg-surface p-4">
      <span>
        <span className="block font-semibold text-fg">{label}</span>
        {hint ? <span className="mt-0.5 block text-sm text-muted">{hint}</span> : null}
      </span>
      <input
        type="checkbox"
        name={name}
        defaultChecked={defaultChecked}
        onChange={(e) => onChange?.(e.target.checked)}
        className="mt-1 h-6 w-6 shrink-0 rounded border-line accent-primary"
      />
    </label>
  );
}

export function OnlineOrderingForm({
  orgSlug,
  branchSlug,
  branchName,
  currency,
  settings,
}: {
  orgSlug: string;
  branchSlug: string;
  branchName: string;
  currency: string;
  settings: OnlineSettings;
}) {
  const [state, action] = useFormState<SettingsState, FormData>(
    saveOnlineSettingsAction,
    undefined,
  );
  // Only to show or hide the fee field. The server charges the stored fee
  // whatever this says, and refuses delivery outright when it is off.
  const [deliveryOn, setDeliveryOn] = useState(settings.deliveryEnabled);

  return (
    <form action={action} className="space-y-5">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="branchSlug" value={branchSlug} />

      {state?.error ? (
        <p className="rounded border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          {state.error}
        </p>
      ) : null}
      <div className="space-y-3">
        <Toggle
          name="enabled"
          label="الطلب أونلاين"
          hint="عند الإيقاف لا يستطيع العملاء فتح صفحة الطلب ولا إرسال أي طلب."
          defaultChecked={settings.enabled}
        />
        <Toggle
          name="pickupEnabled"
          label="الاستلام من المطعم"
          hint="يختار العميل الاستلام بنفسه من الفرع."
          defaultChecked={settings.pickupEnabled}
        />
        <Toggle
          name="deliveryEnabled"
          label="التوصيل"
          hint="يختار العميل التوصيل إلى عنوانه."
          defaultChecked={settings.deliveryEnabled}
          onChange={setDeliveryOn}
        />
      </div>

      <label className="block">
        <span className="mb-1.5 block font-semibold text-fg">رسوم التوصيل</span>
        <span className="mb-2 block text-sm text-muted">
          {deliveryOn
            ? `تُضاف إلى إجمالي طلبات التوصيل فقط. بالـ${currency}.`
            : 'التوصيل موقوف حاليًا، ولن تُحتسب أي رسوم حتى تفعيله.'}
        </span>
        <input
          type="number"
          name="deliveryFee"
          min={0}
          max={10000}
          step="0.01"
          defaultValue={(settings.deliveryFeeCents / 100).toString()}
          className="h-12 w-full rounded border border-line bg-elevated px-3 text-base text-fg sm:max-w-xs"
        />
      </label>

      <fieldset className="rounded border border-line bg-surface p-4">
        <legend className="px-1 text-sm font-semibold text-fg">نطاق الحفظ</legend>
        <div className="mt-2 space-y-2">
          <label className="flex items-center gap-3">
            <input type="radio" name="scope" value="branch" defaultChecked
              className="h-5 w-5 accent-primary" />
            <span className="text-sm text-fg">
              هذا الفرع فقط <span className="text-muted">({branchName})</span>
            </span>
          </label>
          <label className="flex items-center gap-3">
            <input type="radio" name="scope" value="organization" className="h-5 w-5 accent-primary" />
            <span className="text-sm text-fg">
              كل الفروع <span className="text-muted">(يُستخدم كإعداد افتراضي)</span>
            </span>
          </label>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-muted">
          إعداد الفرع يتقدّم على إعداد كل الفروع. أي فرع بلا إعداد خاص يتبع الإعداد العام.
        </p>
      </fieldset>

      <Save />
    </form>
  );
}
