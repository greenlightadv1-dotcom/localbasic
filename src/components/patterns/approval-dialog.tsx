'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Field, Input, Select } from '@/components/ui/field';
import { APPROVAL_ACTION_LABELS, type ApprovalAction } from '@/modules/restaurant/approvals/schema';
import { grantApprovalAction, listApproversAction } from '@/app/(app)/[orgSlug]/[branchSlug]/approval-actions';

type Scope = { organizationSlug: string; branchSlug: string };
type Pending = { action: ApprovalAction; subjectId: string; amount: number | null; retry: () => Promise<void> };

/**
 * Manager approval, in place. When a sensitive action comes back
 * `approval_required`, the screen calls `request(...)` with a way to retry;
 * the manager (or main cashier) picks their name, types their PIN on this
 * device, and the original action runs again with a single-use grant the
 * database issued for exactly that order or item.
 *
 *   const approval = useApproval(scope);
 *   const r = await cancelAction(...);
 *   if (!r.ok && r.code === 'approval_required')
 *     approval.request('order.cancel', orderId, null, () => doCancel());
 *   ...
 *   {approval.dialog}
 */
export function useApproval(scope: Scope) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [approvers, setApprovers] = useState<{ memberId: string; name: string }[] | null>(null);
  const [approver, setApprover] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pinRef = useRef<HTMLInputElement>(null);

  const request = useCallback((action: ApprovalAction, subjectId: string, amount: number | null, retry: () => Promise<void>) => {
    setPending({ action, subjectId, amount, retry });
    setPin('');
    setError(null);
  }, []);

  useEffect(() => {
    if (!pending) return;
    let live = true;
    void listApproversAction(scope, {}).then((r) => {
      if (!live) return;
      if (r.ok) {
        setApprovers(r.data);
        setApprover((cur) => cur || r.data[0]?.memberId || '');
      } else {
        setApprovers([]);
        setError(r.error);
      }
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);

  async function confirm() {
    if (!pending) return;
    if (!approver) { setError('لا يوجد مدير متاح للموافقة'); return; }
    setBusy(true);
    setError(null);
    const r = await grantApprovalAction(scope, {
      action: pending.action, subjectId: pending.subjectId, amount: pending.amount, approverMemberId: approver, pin,
    });
    if (!r.ok) {
      setBusy(false);
      setError(r.error);
      setPin('');
      pinRef.current?.focus();
      return;
    }
    const { retry } = pending;
    setPending(null);
    setBusy(false);
    setPin('');
    await retry();
  }

  const dialog = (
    <ConfirmDialog
      open={pending !== null}
      title="موافقة المدير مطلوبة"
      description={pending ? APPROVAL_ACTION_LABELS[pending.action] : undefined}
      confirmLabel="موافقة"
      tone="primary"
      busy={busy}
      onCancel={() => { setPending(null); setPin(''); }}
      onConfirm={() => void confirm()}
    >
      <div className="space-y-3" data-testid="approval-dialog">
        <p className="flex items-center gap-2 text-sm text-muted">
          <ShieldCheck className="h-4 w-4 text-primary" aria-hidden="true" />
          يُسجَّل اسم المدير الموافق مع هذا الإجراء.
        </p>
        {approvers && approvers.length === 0 ? (
          <p className="text-sm text-danger">
            لا يوجد مدير لديه رمز موافقة في هذا الفرع. يضبط المدير رمزه من الإعدادات ← رمز الموافقة.
          </p>
        ) : (
          <>
            <Field label="المدير">
              {(p) => (
                <Select {...p} value={approver} onChange={(e) => setApprover(e.target.value)} data-testid="approval-approver">
                  {(approvers ?? []).map((a) => <option key={a.memberId} value={a.memberId}>{a.name}</option>)}
                </Select>
              )}
            </Field>
            <Field label="رمز الموافقة (PIN)">
              {(p) => (
                <Input
                  {...p}
                  ref={pinRef}
                  type="password"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={8}
                  dir="ltr"
                  value={pin}
                  onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                  onKeyDown={(e) => { if (e.key === 'Enter') void confirm(); }}
                  className="text-center text-2xl tracking-[0.5em]"
                  data-testid="approval-pin"
                />
              )}
            </Field>
          </>
        )}
        {error ? <p className="text-sm text-danger" role="alert">{error}</p> : null}
      </div>
    </ConfirmDialog>
  );

  return { request, dialog };
}
