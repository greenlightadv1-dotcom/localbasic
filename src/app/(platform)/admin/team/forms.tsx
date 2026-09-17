'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { grantAdminAction, revokeAdminAction, type RosterState } from './actions';

function Submit({ label, subtle }: { label: string; subtle?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className={
        subtle
          ? 'rounded border border-line px-3 py-1.5 text-xs font-semibold text-danger hover:bg-danger/10 disabled:opacity-50'
          : 'h-11 rounded bg-primary px-5 text-sm font-semibold text-primary-fg hover:opacity-90 disabled:opacity-50'
      }
    >
      {pending ? '…' : label}
    </button>
  );
}

export function GrantAdminForm() {
  const [state, formAction] = useFormState<RosterState, FormData>(grantAdminAction, undefined);

  return (
    <form action={formAction} className="space-y-3">
      {state?.error ? (
        <p
          data-testid="grant-error"
          className="rounded border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
        >
          {state.error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[16rem] flex-1">
          <label htmlFor="admin-email" className="mb-1 block text-xs font-medium text-muted">
            البريد الإلكتروني
          </label>
          <input
            id="admin-email"
            name="email"
            type="email"
            required
            dir="ltr"
            className="h-11 w-full rounded border border-line bg-elevated px-3 text-sm text-fg outline-none focus-visible:border-primary"
          />
        </div>

        <div>
          <label htmlFor="admin-role" className="mb-1 block text-xs font-medium text-muted">
            الدور
          </label>
          <select
            id="admin-role"
            name="role"
            defaultValue="staff"
            className="h-11 rounded border border-line bg-elevated px-3 text-sm text-fg outline-none focus-visible:border-primary"
          >
            <option value="staff">موظف</option>
            <option value="owner">مالك المنصة</option>
          </select>
        </div>

        <Submit label="منح الصلاحية" />
      </div>
    </form>
  );
}

export function RevokeAdminButton({ userId, email }: { userId: string; email: string }) {
  const [state, formAction] = useFormState<RosterState, FormData>(revokeAdminAction, undefined);

  return (
    <form action={formAction}>
      <input type="hidden" name="userId" value={userId} />
      {state?.error ? (
        <p data-testid="revoke-error" className="mb-1 text-xs text-danger">{state.error}</p>
      ) : null}
      <Submit label="سحب الصلاحية" subtle />
      <span className="sr-only">{email}</span>
    </form>
  );
}
