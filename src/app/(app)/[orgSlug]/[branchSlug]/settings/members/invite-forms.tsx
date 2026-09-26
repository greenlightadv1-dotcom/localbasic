'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Alert } from '@/components/ui/alert';
import { createMemberDirectAction, removeMemberAction } from './actions';

type Scope = { orgSlug: string; branchSlug: string };

/**
 * Creating a staff account directly: an admin sets the password and the
 * account works immediately, no email round trip. Alongside InviteForm, not
 * instead of it — for someone already at the keyboard, not someone who isn't.
 */
export function CreateMemberDirectForm({
  orgSlug, branchSlug, roles,
}: Scope & { roles: { id: string; label: string }[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [roleIds, setRoleIds] = useState<string[]>([]);

  function onSubmit(formData: FormData) {
    setError(null);
    setDone(null);

    startTransition(async () => {
      const email = String(formData.get('email') ?? '');
      const result = await createMemberDirectAction(
        { organizationSlug: orgSlug, branchSlug },
        {
          email,
          password: String(formData.get('password') ?? ''),
          fullName: String(formData.get('fullName') ?? ''),
          roleIds,
          allBranches: formData.get('allBranches') === 'on',
          branchIds: [],
        },
      );
      if (!result.ok) { setError(result.error); return; }
      setDone(email);
      setRoleIds([]);
      router.refresh();
    });
  }

  return (
    <form action={onSubmit} className="space-y-3">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {done ? (
        <Alert tone="success">
          تم إنشاء الحساب. الموظف يمكنه الدخول الآن بالبريد وكلمة المرور اللي أدخلتها لـ{' '}
          <span dir="ltr">{done}</span>.
        </Alert>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="الاسم الكامل" required>
          {(p) => <Input {...p} name="fullName" required maxLength={120} />}
        </Field>
        <Field label="البريد الإلكتروني" required>
          {(p) => <Input {...p} name="email" type="email" dir="ltr" required maxLength={200} />}
        </Field>
        <Field label="كلمة المرور" required>
          {(p) => (
            <Input {...p} name="password" type="password" dir="ltr" required minLength={8} maxLength={72} />
          )}
        </Field>

        <fieldset className="space-y-1">
          <legend className="mb-1 block text-sm font-medium text-fg">الدور</legend>
          <div className="flex flex-wrap gap-2">
            {roles.map((r) => (
              <label key={r.id} className="flex items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  checked={roleIds.includes(r.id)}
                  onChange={(e) =>
                    setRoleIds((ids) =>
                      e.target.checked ? [...ids, r.id] : ids.filter((x) => x !== r.id),
                    )
                  }
                />
                {r.label}
              </label>
            ))}
          </div>
        </fieldset>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="allBranches" className="h-4 w-4" defaultChecked />
        الوصول لكل الفروع
      </label>

      <Button type="submit" size="sm" disabled={isPending} data-testid="create-member-direct">
        {isPending ? '…' : 'إنشاء الحساب'}
      </Button>
    </form>
  );
}

/**
 * Removing a staff member. A destructive, irreversible action — a member
 * loses access, not "pending" access — so it asks once before it does
 * anything: the first click arms it, the second (within the same render)
 * carries it out. Refreshing or navigating away disarms it for free, since
 * `armed` is component state.
 */
export function RemoveMember({ orgSlug, branchSlug, memberId }: Scope & { memberId: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [armed, setArmed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (armed) {
    return (
      <span className="inline-flex items-center gap-1.5">
        {error ? <span className="text-xs text-danger">{error}</span> : null}
        <Button
          type="button"
          variant="danger"
          size="sm"
          disabled={isPending}
          data-testid={`confirm-remove-${memberId}`}
          onClick={() =>
            startTransition(async () => {
              const result = await removeMemberAction({ organizationSlug: orgSlug, branchSlug }, { memberId });
              if (!result.ok) { setError(result.error); return; }
              router.refresh();
            })
          }
        >
          {isPending ? '…' : 'تأكيد الحذف'}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => { setArmed(false); setError(null); }}>
          تراجع
        </Button>
      </span>
    );
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      data-testid={`remove-${memberId}`}
      onClick={() => setArmed(true)}
    >
      حذف
    </Button>
  );
}
