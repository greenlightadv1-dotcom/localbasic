'use client';

import { useState, useTransition } from 'react';
import { useFormState } from 'react-dom';
import {
  grantStaffRoleAction, revokeStaffRoleAction, type StaffRoleState,
} from '../../actions';
import type { StaffMember, CustomerRole } from '@/modules/platform/staff/service';

/**
 * Granular staff role management, from the platform console.
 *
 * Every grant/revoke goes through platform_grant_staff_role /
 * platform_revoke_staff_role (0074) — this component is presentation only.
 * The database refuses the organization's own owner role to anyone but a
 * platform owner; isPlatformOwner here only decides whether that option is
 * even offered, so a staff-tier admin sees why it's missing rather than a
 * raw refusal after submitting.
 */
export function StaffRoles({
  customerCode,
  staff,
  roles,
  isPlatformOwner,
}: {
  customerCode: string;
  staff: StaffMember[];
  roles: CustomerRole[];
  isPlatformOwner: boolean;
}) {
  const assignableRoles = roles.filter((r) => !r.isOwner || isPlatformOwner);

  if (staff.length === 0) {
    return <p className="px-5 py-8 text-center text-sm text-muted">لا يوجد فريق عمل بعد.</p>;
  }

  return (
    <ul className="divide-y divide-line">
      {staff.map((member) => (
        <li key={member.memberId} className="space-y-3 px-5 py-4">
          <div>
            <p className="font-semibold text-fg">{member.fullName ?? '—'}</p>
            {member.phone ? <p className="text-xs text-muted" dir="ltr">{member.phone}</p> : null}
          </div>

          <div className="flex flex-wrap gap-1.5">
            {member.roles.length === 0 ? (
              <span className="text-xs text-muted">بدون أدوار</span>
            ) : (
              member.roles.map((grant) => (
                <RoleChip
                  key={grant.userRoleId}
                  customerCode={customerCode}
                  memberId={member.memberId}
                  grant={grant}
                  canRevoke={!grant.isOwner || isPlatformOwner}
                />
              ))
            )}
          </div>

          {assignableRoles.length > 0 ? (
            <GrantForm customerCode={customerCode} memberId={member.memberId} roles={assignableRoles} />
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function RoleChip({
  customerCode,
  memberId,
  grant,
  canRevoke,
}: {
  customerCode: string;
  memberId: string;
  grant: StaffMember['roles'][number];
  canRevoke: boolean;
}) {
  const [state, action] = useFormState<StaffRoleState, FormData>(revokeStaffRoleAction, undefined);
  const [isPending, startTransition] = useTransition();

  return (
    <form
      action={(formData) => startTransition(() => action(formData))}
      className="inline-flex"
    >
      <input type="hidden" name="customerCode" value={customerCode} />
      <input type="hidden" name="memberId" value={memberId} />
      <input type="hidden" name="roleId" value={grant.roleId} />
      <input type="hidden" name="branchId" value={grant.branchId ?? ''} />
      <span
        className={
          'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ' +
          (grant.isOwner ? 'bg-primary-soft text-primary' : 'bg-surface text-fg')
        }
      >
        {grant.roleNameAr}
        {grant.branchName ? <span className="text-muted"> · {grant.branchName}</span> : null}
        {canRevoke ? (
          <button
            type="submit"
            disabled={isPending}
            aria-label={`سحب دور ${grant.roleNameAr}`}
            className="text-muted hover:text-danger disabled:opacity-50"
          >
            ✕
          </button>
        ) : null}
      </span>
      {state?.error ? <span className="ms-2 text-xs text-danger">{state.error}</span> : null}
    </form>
  );
}

function GrantForm({
  customerCode,
  memberId,
  roles,
}: {
  customerCode: string;
  memberId: string;
  roles: CustomerRole[];
}) {
  const [state, action] = useFormState<StaffRoleState, FormData>(grantStaffRoleAction, undefined);
  const [roleId, setRoleId] = useState(roles[0]?.roleId ?? '');
  const [isPending, startTransition] = useTransition();

  return (
    <form
      action={(formData) => startTransition(() => action(formData))}
      className="flex flex-wrap items-center gap-2"
    >
      <input type="hidden" name="customerCode" value={customerCode} />
      <input type="hidden" name="memberId" value={memberId} />
      <select
        name="roleId"
        value={roleId}
        onChange={(e) => setRoleId(e.target.value)}
        className="h-9 rounded border border-line bg-elevated px-2 text-xs text-fg"
      >
        {roles.map((r) => (
          <option key={r.roleId} value={r.roleId}>
            {r.nameAr}
            {r.isOwner ? ' (مالك)' : ''}
          </option>
        ))}
      </select>
      <button
        type="submit"
        disabled={isPending || !roleId}
        className="h-9 rounded border border-line px-3 text-xs font-semibold text-fg hover:bg-surface disabled:opacity-50"
      >
        {isPending ? '…' : 'إضافة دور'}
      </button>
      {state?.error ? <span className="text-xs text-danger">{state.error}</span> : null}
    </form>
  );
}
