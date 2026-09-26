'use client';

import { useState } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import {
  resetOrganizationDataAction, deleteOrganizationAction, type SubscriptionOpsState,
} from '../../actions';

function Submit({
  label,
  pendingLabel,
  disabled,
}: {
  label: string;
  pendingLabel: string;
  disabled: boolean;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={disabled || pending}
      className="h-11 rounded bg-danger px-5 text-sm font-semibold text-white hover:bg-danger/90 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {pending ? pendingLabel : label}
    </button>
  );
}

/**
 * Both actions here are irreversible against real customer data, so both
 * require the operator to type the customer code back exactly — not click a
 * checkbox — before the submit button even enables. The database re-checks
 * the same code and that the caller is a platform *owner*; this is only the
 * UI's first line of defense against a slip in a long list of customers.
 */
export function DangerZone({
  organizationId,
  customerCode,
  isOwner,
}: {
  organizationId: string;
  customerCode: string;
  isOwner: boolean;
}) {
  const [resetConfirm, setResetConfirm] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [resetState, resetAction] = useFormState<SubscriptionOpsState, FormData>(
    resetOrganizationDataAction,
    undefined,
  );
  const [deleteState, deleteAction] = useFormState<SubscriptionOpsState, FormData>(
    deleteOrganizationAction,
    undefined,
  );

  if (!isOwner) {
    return (
      <p className="px-5 py-6 text-sm text-muted">
        تصفير البيانات وحذف العميل نهائيًا متاحان فقط لمالكي المنصة (Platform Owner).
      </p>
    );
  }

  return (
    <div className="divide-y divide-line">
      <form action={resetAction} className="space-y-3 p-5">
        <input type="hidden" name="organizationId" value={organizationId} />
        <h3 className="font-bold text-fg">تصفير بيانات العميل</h3>
        <p className="text-sm text-muted">
          يحذف كل الطلبات والفواتير والمدفوعات وحسابات العملاء وحركة المخزون لهذا العميل
          نهائيًا. لا يمسّ الإعدادات: القائمة، الهوية، الموقع، الموظفين، أو الاشتراك.
        </p>
        {resetState?.error ? (
          <p className="rounded border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
            {resetState.error}
          </p>
        ) : null}
        {resetState?.ok ? (
          <p className="rounded border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
            {resetState.ok}
          </p>
        ) : null}
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-fg">
            اكتب كود العميل <span dir="ltr" className="font-mono">{customerCode}</span> للتأكيد
          </span>
          <input
            name="confirmCustomerCode"
            value={resetConfirm}
            onChange={(e) => setResetConfirm(e.target.value)}
            dir="ltr"
            autoComplete="off"
            className="h-11 w-full rounded border border-line bg-elevated px-3 text-sm text-fg"
          />
        </label>
        <Submit
          label="تصفير البيانات نهائيًا"
          pendingLabel="جارٍ التصفير…"
          disabled={resetConfirm.trim() !== customerCode}
        />
      </form>

      <form action={deleteAction} className="space-y-3 p-5">
        <input type="hidden" name="organizationId" value={organizationId} />
        <h3 className="font-bold text-danger">حذف العميل نهائيًا</h3>
        <p className="text-sm text-muted">
          يحذف مساحة عمل هذا العميل بالكامل — المنشأة والفروع والموظفين والاشتراك وكل بياناته —
          حذفًا نهائيًا لا رجعة فيه.
        </p>
        {deleteState?.error ? (
          <p className="rounded border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
            {deleteState.error}
          </p>
        ) : null}
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-fg">
            اكتب كود العميل <span dir="ltr" className="font-mono">{customerCode}</span> للتأكيد
          </span>
          <input
            name="confirmCustomerCode"
            value={deleteConfirm}
            onChange={(e) => setDeleteConfirm(e.target.value)}
            dir="ltr"
            autoComplete="off"
            className="h-11 w-full rounded border border-line bg-elevated px-3 text-sm text-fg"
          />
        </label>
        <Submit
          label="حذف العميل نهائيًا"
          pendingLabel="جارٍ الحذف…"
          disabled={deleteConfirm.trim() !== customerCode}
        />
      </form>
    </div>
  );
}
