'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Alert } from '@/components/ui/alert';
import { createMemberDirectAction, removeMemberAction, resetMemberPasswordAction } from './actions';

type Scope = { orgSlug: string; branchSlug: string };

/**
 * Creating a staff account directly: Name, Username, initial Password/PIN,
 * Role, Branch access. The account works immediately — no email, no
 * invitation. Staff cannot change this password later; an admin resets it
 * from the table below.
 */
export function CreateMemberDirectForm({
  orgSlug, branchSlug, roles, branches,
}: Scope & {
  roles: { id: string; label: string }[];
  branches: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [roleIds, setRoleIds] = useState<string[]>([]);
  const [branchIds, setBranchIds] = useState<string[]>([]);
  const [allBranches, setAllBranches] = useState(true);

  function onSubmit(formData: FormData) {
    setError(null);
    setDone(null);

    startTransition(async () => {
      const result = await createMemberDirectAction(
        { organizationSlug: orgSlug, branchSlug },
        {
          username: String(formData.get('username') ?? ''),
          password: String(formData.get('password') ?? ''),
          fullName: String(formData.get('fullName') ?? ''),
          roleIds,
          allBranches,
          branchIds: allBranches ? [] : branchIds,
        },
      );
      if (!result.ok) { setError(result.error); return; }
      setDone(result.data.username);
      setRoleIds([]);
      setBranchIds([]);
      router.refresh();
    });
  }

  return (
    <form action={onSubmit} className="space-y-3">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {done ? (
        <Alert tone="success">
          تم إنشاء الحساب. الموظف يدخل باسم المستخدم <span dir="ltr">{done}</span> وكلمة المرور
          اللي أدخلتها.
        </Alert>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="الاسم" required>
          {(p) => <Input {...p} name="fullName" required maxLength={120} />}
        </Field>
        <Field
          label="اسم المستخدم"
          required
          hint="حروف إنجليزية صغيرة وأرقام (3–32). هو اللي بيدخل بيه الموظف."
        >
          {(p) => (
            <Input
              {...p}
              name="username"
              dir="ltr"
              required
              minLength={3}
              maxLength={32}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
            />
          )}
        </Field>
        <Field label="كلمة المرور / الرقم السري المبدئي" required hint="6 أحرف أو أرقام على الأقل">
          {(p) => (
            <Input
              {...p}
              name="password"
              type="text"
              dir="ltr"
              required
              minLength={6}
              maxLength={72}
              autoComplete="off"
            />
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

      <fieldset className="space-y-1">
        <legend className="mb-1 block text-sm font-medium text-fg">الفروع المسموح بها</legend>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="h-4 w-4"
            checked={allBranches}
            onChange={(e) => setAllBranches(e.target.checked)}
          />
          كل الفروع
        </label>
        {!allBranches ? (
          <div className="flex flex-wrap gap-3 ps-6">
            {branches.map((b) => (
              <label key={b.id} className="flex items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  checked={branchIds.includes(b.id)}
                  onChange={(e) =>
                    setBranchIds((ids) =>
                      e.target.checked ? [...ids, b.id] : ids.filter((x) => x !== b.id),
                    )
                  }
                />
                {b.name}
              </label>
            ))}
          </div>
        ) : null}
      </fieldset>

      <Button type="submit" size="sm" disabled={isPending} data-testid="create-member-direct">
        {isPending ? '…' : 'إنشاء الحساب'}
      </Button>
    </form>
  );
}

/**
 * The admin assigns a staff member a new password directly. First click opens
 * an inline field; the second submits it. There is no email and no link — and
 * the member cannot do this for themselves.
 */
export function ResetMemberPassword({ orgSlug, branchSlug, memberId }: Scope & { memberId: string }) {
  const [isPending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (!open) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        data-testid={`reset-password-${memberId}`}
        onClick={() => { setOpen(true); setDone(false); }}
      >
        {done ? 'تم التغيير ✓ — تغيير مرة أخرى' : 'إعادة تعيين كلمة المرور'}
      </Button>
    );
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <input
        type="text"
        dir="ltr"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="كلمة المرور الجديدة"
        aria-label="كلمة المرور الجديدة"
        minLength={6}
        maxLength={72}
        autoComplete="off"
        className="h-8 w-40 rounded border border-line bg-elevated px-2 text-sm text-fg"
      />
      <Button
        type="button"
        size="sm"
        disabled={isPending || password.length < 6}
        data-testid={`confirm-reset-password-${memberId}`}
        onClick={() =>
          startTransition(async () => {
            const result = await resetMemberPasswordAction(
              { organizationSlug: orgSlug, branchSlug },
              { memberId, password },
            );
            if (!result.ok) { setError(result.error); return; }
            setError(null);
            setPassword('');
            setOpen(false);
            setDone(true);
          })
        }
      >
        {isPending ? '…' : 'حفظ'}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => { setOpen(false); setPassword(''); setError(null); }}
      >
        تراجع
      </Button>
      {error ? <span className="w-full text-xs text-danger">{error}</span> : null}
    </span>
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
