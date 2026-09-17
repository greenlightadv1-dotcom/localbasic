'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Alert } from '@/components/ui/alert';
import { createSupplierAction, setSupplierActiveAction } from '../purchases/actions';

export function SupplierForm({
  orgSlug, branchSlug,
}: {
  orgSlug: string;
  branchSlug: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  function onSubmit(formData: FormData) {
    setError(null);
    setFieldErrors({});

    const input = {
      name: formData.get('name'),
      phone: formData.get('phone') ?? '',
      email: formData.get('email') ?? '',
      taxId: formData.get('taxId') ?? '',
      address: '',
      notes: '',
    };

    startTransition(async () => {
      const result = await createSupplierAction({ organizationSlug: orgSlug, branchSlug }, input);
      if (!result.ok) {
        setError(result.error);
        setFieldErrors(result.fieldErrors ?? {});
        return;
      }
      router.refresh();
    });
  }

  return (
    <form action={onSubmit} className="space-y-3">
      {error ? <Alert tone="danger">{error}</Alert> : null}

      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="اسم المورد" required error={fieldErrors.name}>
          {(p) => <Input {...p} name="name" required maxLength={160} />}
        </Field>
        <Field label="الهاتف" error={fieldErrors.phone}>
          {(p) => <Input {...p} name="phone" dir="ltr" maxLength={40} />}
        </Field>
        <Field label="البريد الإلكتروني" error={fieldErrors.email}>
          {(p) => <Input {...p} name="email" type="email" dir="ltr" maxLength={160} />}
        </Field>
        <Field label="الرقم الضريبي" error={fieldErrors.taxId}>
          {(p) => <Input {...p} name="taxId" dir="ltr" maxLength={64} />}
        </Field>
      </div>

      <Button type="submit" size="sm" disabled={isPending}>
        {isPending ? '…' : 'إضافة المورد'}
      </Button>
    </form>
  );
}

export function SupplierToggle({
  orgSlug, branchSlug, id, isActive,
}: {
  orgSlug: string;
  branchSlug: string;
  id: string;
  isActive: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={isPending}
      onClick={() =>
        startTransition(async () => {
          await setSupplierActiveAction(
            { organizationSlug: orgSlug, branchSlug },
            { id, isActive: !isActive },
          );
          router.refresh();
        })
      }
    >
      {isActive ? 'إيقاف' : 'تفعيل'}
    </Button>
  );
}
