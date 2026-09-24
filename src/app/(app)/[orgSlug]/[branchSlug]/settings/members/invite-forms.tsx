'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Alert } from '@/components/ui/alert';
import { createMemberDirectAction, inviteMemberAction, revokeInvitationAction } from './actions';

type Scope = { orgSlug: string; branchSlug: string };

export function InviteForm({
  orgSlug, branchSlug, roles,
}: Scope & { roles: { id: string; label: string }[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [roleIds, setRoleIds] = useState<string[]>([]);

  function onSubmit(formData: FormData) {
    setError(null);
    setLink(null);

    startTransition(async () => {
      const result = await inviteMemberAction(
        { organizationSlug: orgSlug, branchSlug },
        {
          email: String(formData.get('email') ?? ''),
          roleIds,
          allBranches: formData.get('allBranches') === 'on',
          branchIds: [],
        },
      );
      if (!result.ok) { setError(result.error); return; }
      setLink(result.data.url);
      setRoleIds([]);
      router.refresh();
    });
  }

  return (
    <form action={onSubmit} className="space-y-3">
      {error ? <Alert tone="danger">{error}</Alert> : null}

      {link ? (
        <Alert tone="success">
          <span className="block" data-testid="invite-created">
            تم إنشاء الدعوة. انسخ الرابط الآن — لن يظهر مرة أخرى.
          </span>
          <span
            className="mt-2 block break-all rounded bg-surface px-2 py-1 font-mono text-xs"
            dir="ltr"
            data-testid="invite-link"
          >
            {link}
          </span>
        </Alert>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="البريد الإلكتروني" required>
          {(p) => <Input {...p} name="email" type="email" dir="ltr" required maxLength={200} />}
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

      <Button type="submit" size="sm" disabled={isPending} data-testid="send-invite">
        {isPending ? '…' : 'إنشاء دعوة'}
      </Button>
    </form>
  );
}

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

export function RevokeInvitation({ orgSlug, branchSlug, id }: Scope & { id: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={isPending}
      data-testid={`revoke-${id}`}
      onClick={() =>
        startTransition(async () => {
          await revokeInvitationAction({ organizationSlug: orgSlug, branchSlug }, { id });
          router.refresh();
        })
      }
    >
      سحب الدعوة
    </Button>
  );
}
