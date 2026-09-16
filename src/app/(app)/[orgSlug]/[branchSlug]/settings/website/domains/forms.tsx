'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Alert } from '@/components/ui/alert';
import {
  addDomainAction, removeDomainAction, setPrimaryAction, setStatusAction,
  verifyDomainAction, type DomainState,
} from './actions';

function Submit({ label, variant, size }: {
  label: string;
  variant?: 'primary' | 'outline' | 'ghost';
  size?: 'sm';
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} size={size} disabled={pending}>
      {pending ? '…' : label}
    </Button>
  );
}

function Scope({ orgSlug, branchSlug }: { orgSlug: string; branchSlug: string }) {
  return (
    <>
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="branchSlug" value={branchSlug} />
    </>
  );
}

export function AddDomainForm({
  orgSlug, branchSlug,
}: {
  orgSlug: string;
  branchSlug: string;
}) {
  const [state, formAction] = useFormState<DomainState, FormData>(addDomainAction, undefined);

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-2">
      {state?.error && (
        <div className="w-full">
          <Alert tone="danger">{state.error}</Alert>
        </div>
      )}
      <Scope orgSlug={orgSlug} branchSlug={branchSlug} />
      <div className="min-w-56 flex-1">
        <Field label="اسم النطاق" hint="بدون http:// وبدون مسار — مثال: example-restaurant.com">
          {(p) => (
            <Input
              {...p}
              name="hostname"
              dir="ltr"
              required
              maxLength={253}
              placeholder="example-restaurant.com"
            />
          )}
        </Field>
      </div>
      <Submit label="إضافة النطاق" />
    </form>
  );
}

export function VerifyButton({
  orgSlug, branchSlug, id, hostname,
}: {
  orgSlug: string;
  branchSlug: string;
  id: string;
  hostname: string;
}) {
  return (
    <form action={verifyDomainAction}>
      <Scope orgSlug={orgSlug} branchSlug={branchSlug} />
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="hostname" value={hostname} />
      <Submit label="تحقّق الآن" variant="outline" size="sm" />
    </form>
  );
}

export function StatusButton({
  orgSlug, branchSlug, id, to,
}: {
  orgSlug: string;
  branchSlug: string;
  id: string;
  to: 'active' | 'disabled';
}) {
  return (
    <form action={setStatusAction}>
      <Scope orgSlug={orgSlug} branchSlug={branchSlug} />
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="status" value={to} />
      <Submit
        label={to === 'active' ? 'تفعيل' : 'إيقاف'}
        variant={to === 'active' ? 'primary' : 'ghost'}
        size="sm"
      />
    </form>
  );
}

export function PrimaryButton({
  orgSlug, branchSlug, id,
}: {
  orgSlug: string;
  branchSlug: string;
  id: string;
}) {
  return (
    <form action={setPrimaryAction}>
      <Scope orgSlug={orgSlug} branchSlug={branchSlug} />
      <input type="hidden" name="id" value={id} />
      <Submit label="اجعله الأساسي" variant="outline" size="sm" />
    </form>
  );
}

export function RemoveButton({
  orgSlug, branchSlug, id,
}: {
  orgSlug: string;
  branchSlug: string;
  id: string;
}) {
  return (
    <form action={removeDomainAction}>
      <Scope orgSlug={orgSlug} branchSlug={branchSlug} />
      <input type="hidden" name="id" value={id} />
      <Button type="submit" variant="ghost" size="sm" className="text-danger hover:bg-danger/10">
        حذف
      </Button>
    </form>
  );
}
