'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Alert } from '@/components/ui/alert';
import { createBranchAction } from './actions';

type Scope = { orgSlug: string; branchSlug: string };

/**
 * Adding a branch. The plan's limit is enforced server-side
 * (branch_create(), 0079) — this form only shows the friendly refusal that
 * comes back, it never decides on its own whether there is room left.
 */
export function CreateBranchForm({ orgSlug, branchSlug }: Scope) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onSubmit(formData: FormData) {
    setError(null);
    startTransition(async () => {
      const result = await createBranchAction(
        { organizationSlug: orgSlug, branchSlug },
        {
          name: String(formData.get('name') ?? ''),
          slug: String(formData.get('slug') ?? ''),
          address: String(formData.get('address') ?? ''),
          phone: String(formData.get('phone') ?? ''),
        },
      );
      if (!result.ok) { setError(result.error); return; }
      (document.getElementById('create-branch-form') as HTMLFormElement | null)?.reset();
      router.refresh();
    });
  }

  return (
    <form id="create-branch-form" action={onSubmit} className="space-y-3">
      {error ? <Alert tone="danger">{error}</Alert> : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="اسم الفرع" required>
          {(p) => <Input {...p} name="name" required maxLength={120} />}
        </Field>
        <Field label="المعرّف" hint="حروف إنجليزية صغيرة وأرقام وشرطات فقط — يظهر في الرابط.">
          {(p) => <Input {...p} name="slug" dir="ltr" required maxLength={50} />}
        </Field>
        <Field label="العنوان (اختياري)">
          {(p) => <Input {...p} name="address" maxLength={300} />}
        </Field>
        <Field label="الهاتف (اختياري)">
          {(p) => <Input {...p} name="phone" dir="ltr" maxLength={40} />}
        </Field>
      </div>

      <Button type="submit" size="sm" disabled={isPending} data-testid="create-branch">
        {isPending ? '…' : 'إضافة الفرع'}
      </Button>
    </form>
  );
}
