'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Alert } from '@/components/ui/alert';
import { createCarrierAction, saveStoreSettingsAction } from './actions';
import type { StoreSettings } from '@/modules/retail/store/settings';

export function StoreSettingsForm({
  orgSlug, branchSlug, settings,
}: {
  orgSlug: string;
  branchSlug: string;
  settings: StoreSettings;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function onSubmit(formData: FormData) {
    setError(null);
    setSaved(false);

    startTransition(async () => {
      const result = await saveStoreSettingsAction(
        { organizationSlug: orgSlug, branchSlug },
        {
          enabled: formData.get('enabled') === 'on',
          pickup: formData.get('pickup') === 'on',
          delivery: formData.get('delivery') === 'on',
          deliveryFeeCents: String(formData.get('deliveryFee') ?? '0'),
          minOrderCents: String(formData.get('minOrder') ?? '0'),
        },
      );
      if (!result.ok) { setError(result.error); return; }
      setSaved(true);
      router.refresh();
    });
  }

  return (
    <form action={onSubmit} className="space-y-4">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {saved ? (
        <Alert tone="success">
          <span data-testid="store-settings-saved">تم حفظ الإعدادات.</span>
        </Alert>
      ) : null}

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="enabled"
          defaultChecked={settings.enabled}
          data-testid="store-enabled"
          className="h-4 w-4"
        />
        فتح المتجر الإلكتروني
      </label>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="pickup" defaultChecked={settings.pickup} className="h-4 w-4" />
        الاستلام من الفرع
      </label>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="delivery" defaultChecked={settings.delivery} className="h-4 w-4" />
        التوصيل
      </label>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="رسوم التوصيل">
          {(p) => (
            <Input
              {...p}
              name="deliveryFee"
              dir="ltr"
              inputMode="decimal"
              defaultValue={(settings.deliveryFeeCents / 100).toFixed(2)}
            />
          )}
        </Field>

        <Field label="الحد الأدنى للطلب">
          {(p) => (
            <Input
              {...p}
              name="minOrder"
              dir="ltr"
              inputMode="decimal"
              defaultValue={(settings.minOrderCents / 100).toFixed(2)}
            />
          )}
        </Field>
      </div>

      <Button type="submit" disabled={isPending}>
        {isPending ? '…' : 'حفظ'}
      </Button>
    </form>
  );
}

/** Add a carrier the shop actually uses. */
export function CarrierForm({
  orgSlug, branchSlug,
}: {
  orgSlug: string;
  branchSlug: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onSubmit(formData: FormData) {
    setError(null);
    startTransition(async () => {
      const result = await createCarrierAction(
        { organizationSlug: orgSlug, branchSlug },
        {
          name: String(formData.get('carrierName') ?? ''),
          defaultCostCents: String(formData.get('carrierCost') ?? '0'),
          phone: String(formData.get('carrierPhone') ?? ''),
        },
      );
      if (!result.ok) { setError(result.error); return; }
      router.refresh();
    });
  }

  return (
    <form action={onSubmit} className="space-y-3 border-t border-line pt-3">
      {error ? <Alert tone="danger">{error}</Alert> : null}

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="اسم شركة الشحن" required>
          {(p) => <Input {...p} name="carrierName" required maxLength={120} />}
        </Field>
        <Field label="التكلفة الافتراضية">
          {(p) => (
            <Input {...p} name="carrierCost" dir="ltr" inputMode="decimal" defaultValue="0.00" />
          )}
        </Field>
        <Field label="الهاتف">
          {(p) => <Input {...p} name="carrierPhone" dir="ltr" maxLength={40} />}
        </Field>
      </div>

      <Button type="submit" size="sm" variant="outline" disabled={isPending} data-testid="add-carrier">
        {isPending ? '…' : 'إضافة شركة شحن'}
      </Button>
    </form>
  );
}
