'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle, Ban, Banknote, CheckCircle2, ClipboardList, CreditCard, FileText, Loader2, PackageCheck,
  Plus, Receipt, Stethoscope, Trash2, UserCheck, UserX,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/field';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Modal } from '@/components/ui/modal';
import { useToast } from '@/components/ui/toast';
import { useApproval } from '@/components/patterns/approval-dialog';
import { formatMoney } from '@/lib/money';
import { toCents, fromCents } from '@/lib/amount-input';
import type { AppointmentStatus, CalendarAppointment, ClinicWorkspace, VisitPayment } from '@/modules/clinic/service';
import { minutesToHm, toLocal } from '@/modules/clinic/time';
import {
  addVisitServiceAction, invoiceVisitAction, payVisitAction, removeVisitServiceAction, setAppointmentStatusAction,
} from './actions';
import { ACTIVE, SOURCE_LABELS, STATUS_META, failure, type ClinicPermissions, type Scope } from './shared';

type Method = 'cash' | 'card' | 'transfer' | 'wallet';

/**
 * One visit: who, when, what was done, and what is owed.
 *
 * Completing the visit is where the database consumes each procedure's
 * supplies from the branch's clinic stock, accrues the doctor's commission and
 * issues the invoice, in one transaction. The front desk can also invoice
 * early (pay at check-in); a discount then needs a manager's PIN.
 */
export function VisitModal({ scope, currency, workspace, appointment: a, permissions, onClose }: {
  scope: Scope; currency: string; workspace: ClinicWorkspace; appointment: CalendarAppointment; permissions: ClinicPermissions; onClose: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const approval = useApproval(scope);
  const money = (c: number) => formatMoney(c, currency);
  const tz = workspace.timezone;

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [newService, setNewService] = useState('');
  const [newQty, setNewQty] = useState('1');
  const [discount, setDiscount] = useState('');
  const [method, setMethod] = useState<Method>('cash');
  const [amount, setAmount] = useState('');
  const [paid, setPaid] = useState<VisitPayment | null>(null);

  const doctorName = new Map(workspace.doctors.map((d) => [d.id, d.name]));
  const room = workspace.rooms.find((r) => r.id === a.roomId);
  const start = toLocal(a.startsAt, tz);
  const end = toLocal(a.endsAt, tz);
  const active = ACTIVE.includes(a.status);
  const editableLines = active && !a.invoice && (permissions.book || permissions.clinical);

  const linesTotal = a.services.reduce((s, l) => s + l.quantity * l.unitPriceCents - l.discountCents, 0);
  const total = paid?.totalCents ?? a.invoice?.totalCents ?? linesTotal;
  const paidCents = paid?.paidCents ?? a.invoice?.paidCents ?? 0;
  const due = paid ? paid.dueCents : Math.max(total - paidCents, 0);
  const billable = a.status !== 'cancelled' && a.status !== 'no_show' && a.services.length > 0;

  async function step<T>(key: string, call: () => Promise<{ ok: true; data: T } | { ok: false; error: string; code: string }>, done: (d: T) => string, close = false) {
    setBusy(key);
    setError(null);
    const r = await call();
    setBusy(null);
    if (!r.ok) { setError(failure(r)); return false; }
    toast.success(done(r.data));
    router.refresh();
    if (close) onClose();
    return true;
  }

  const move = (status: AppointmentStatus, reason?: string) =>
    step(status, () => setAppointmentStatusAction(scope, { appointmentId: a.id, status, reason }), () => `${a.patient.name}: ${STATUS_META[status].label}`, status === 'cancelled' || status === 'no_show');

  async function invoiceNow(): Promise<void> {
    const cents = toCents(discount) ?? 0;
    setBusy('invoice');
    setError(null);
    const r = await invoiceVisitAction(scope, { appointmentId: a.id, discountCents: cents });
    setBusy(null);
    if (!r.ok) {
      if (r.code === 'approval_required') {
        approval.request('order.discount', a.id, r.approval?.amount ?? cents, invoiceNow);
        return;
      }
      setError(failure(r));
      return;
    }
    toast.success('صدرت فاتورة الزيارة');
    router.refresh();
  }

  async function pay() {
    const cents = amount.trim() === '' ? due : toCents(amount);
    if (!cents || cents <= 0) { setError('أدخل مبلغًا صحيحًا.'); return; }
    setBusy('pay');
    setError(null);
    const r = await payVisitAction(scope, { appointmentId: a.id, method, tenderedCents: cents });
    setBusy(null);
    if (!r.ok) { setError(failure(r)); return; }
    setPaid(r.data);
    setAmount('');
    toast.success(r.data.dueCents === 0 ? `تم تحصيل الزيارة · فاتورة ${r.data.invoiceNumber}` : `تم تحصيل ${money(r.data.paidCents - paidCents)}`);
    router.refresh();
  }

  return (
    <Modal open onClose={onClose} busy={busy !== null} size="lg" icon={ClipboardList} title={a.patient.name}
      description={`ملف ${a.patient.fileNumber}${a.patient.phone ? ` · ${a.patient.phone}` : ''}`} testId="visit-modal"
      footer={<Button variant="outline" onClick={onClose}>إغلاق</Button>}>
      {error && <Alert tone="danger">{error}</Alert>}
      {a.patient.allergies && (
        <Alert tone="danger" title="حساسية">{a.patient.allergies}</Alert>
      )}

      {/* Visit */}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded border border-line p-3 text-sm sm:grid-cols-4">
        <div><dt className="text-xs text-muted">الحالة</dt><dd><Badge tone={STATUS_META[a.status].tone}>{STATUS_META[a.status].label}</Badge></dd></div>
        <div><dt className="text-xs text-muted">الطبيب</dt><dd className="font-medium">{doctorName.get(a.doctorId) ?? '—'}</dd></div>
        <div><dt className="text-xs text-muted">الموعد</dt><dd className="lb-numeric">{start.date} · {minutesToHm(start.minutes)}–{minutesToHm(end.minutes)}</dd></div>
        <div><dt className="text-xs text-muted">الغرفة</dt><dd>{room?.name ?? '—'}</dd></div>
        {a.reason && <div className="col-span-2 sm:col-span-4"><dt className="text-xs text-muted">سبب الزيارة</dt><dd>{a.reason}</dd></div>}
        <div className="col-span-2 sm:col-span-4 text-xs text-muted">المصدر: {SOURCE_LABELS[a.source] ?? a.source}{a.cancelReason ? ` · سبب الإلغاء: ${a.cancelReason}` : ''}</div>
      </dl>

      {/* Status */}
      {active && (
        <div className="flex flex-wrap gap-2">
          {a.status === 'booked' && permissions.book && (
            <>
              <Button disabled={!!busy} onClick={() => void move('checked_in')}><UserCheck className="h-4 w-4" aria-hidden="true" /> تسجيل الوصول</Button>
              <Button variant="outline" disabled={!!busy} onClick={() => void move('no_show')}><UserX className="h-4 w-4" aria-hidden="true" /> لم يحضر</Button>
            </>
          )}
          {a.status === 'checked_in' && permissions.clinical && (
            <Button disabled={!!busy} onClick={() => void move('in_session')}><Stethoscope className="h-4 w-4" aria-hidden="true" /> بدء الكشف</Button>
          )}
          {a.status === 'in_session' && permissions.clinical && (
            <Button disabled={!!busy || a.services.length === 0} onClick={() => void move('completed')} data-testid="visit-complete">
              {busy === 'completed' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <CheckCircle2 className="h-4 w-4" aria-hidden="true" />} إنهاء الزيارة
            </Button>
          )}
          {(a.status === 'booked' || a.status === 'checked_in') && permissions.book && !cancelling && (
            <Button variant="ghost" disabled={!!busy} onClick={() => setCancelling(true)}><Ban className="h-4 w-4" aria-hidden="true" /> إلغاء الموعد</Button>
          )}
        </div>
      )}
      {a.status === 'in_session' && a.services.length === 0 && <p className="text-xs text-warn">أضف الإجراء الذي تم قبل إنهاء الزيارة.</p>}
      {cancelling && (
        <div className="space-y-2 rounded border border-danger/30 p-3">
          <label className="block space-y-1.5 text-sm">
            <span className="font-medium">سبب الإلغاء <span className="text-danger">*</span></span>
            <Textarea autoFocus value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} rows={2} maxLength={300} />
          </label>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setCancelling(false)}>رجوع</Button>
            <Button size="sm" variant="danger" disabled={!!busy || cancelReason.trim().length < 2} onClick={() => void move('cancelled', cancelReason.trim())}>تأكيد الإلغاء</Button>
          </div>
        </div>
      )}

      {/* Procedures */}
      <section className="space-y-2" aria-label="الإجراءات">
        <h3 className="flex items-center gap-2 text-sm font-semibold"><Stethoscope className="h-4 w-4 text-primary" aria-hidden="true" /> الإجراءات</h3>
        {a.services.length === 0 ? (
          <p className="rounded border border-dashed border-line py-3 text-center text-sm text-muted">لا إجراءات على الزيارة بعد.</p>
        ) : (
          <div className="overflow-x-auto rounded border border-line">
            <table className="w-full text-sm">
              <thead className="bg-surface text-xs text-muted">
                <tr>
                  <th className="px-3 py-2 text-start font-medium">الإجراء</th>
                  <th className="px-3 py-2 text-start font-medium">الطبيب</th>
                  <th className="px-3 py-2 text-start font-medium">الكمية</th>
                  <th className="px-3 py-2 text-start font-medium">المبلغ</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {a.services.map((l) => (
                  <tr key={l.lineId} className="border-t border-line">
                    <td className="px-3 py-2">
                      {l.name}
                      {l.consumed && <span className="ms-2 inline-flex items-center gap-0.5 text-xs text-success"><PackageCheck className="h-3 w-3" aria-hidden="true" /> خُصمت المستلزمات</span>}
                    </td>
                    <td className="px-3 py-2 text-muted">{doctorName.get(l.doctorId) ?? '—'}</td>
                    <td className="px-3 py-2 lb-numeric">{l.quantity}</td>
                    <td className="px-3 py-2 lb-numeric">{money(l.quantity * l.unitPriceCents - l.discountCents)}</td>
                    <td className="px-3 py-2 text-end">
                      {editableLines && (
                        <Button size="icon" variant="ghost" aria-label={`حذف ${l.name}`} disabled={!!busy}
                          onClick={() => void step(`rm-${l.lineId}`, () => removeVisitServiceAction(scope, { lineId: l.lineId }), () => `حُذف ${l.name}`)}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {editableLines && (
          <div className="flex flex-wrap gap-2">
            <Select aria-label="إجراء" value={newService} onChange={(e) => setNewService(e.target.value)} className="min-w-[12rem] flex-1">
              <option value="">إضافة إجراء…</option>
              {workspace.services.map((s) => <option key={s.id} value={s.id}>{s.name} · {money(s.priceCents)}</option>)}
            </Select>
            <Input aria-label="الكمية" value={newQty} onChange={(e) => setNewQty(e.target.value.replace(/\D/g, ''))} inputMode="numeric" dir="ltr" className="w-20 text-center" />
            <Button variant="secondary" disabled={!newService || !!busy || !(Number(newQty) >= 1)}
              onClick={async () => {
                const ok = await step('add', () => addVisitServiceAction(scope, { appointmentId: a.id, serviceId: newService, quantity: Number(newQty) }), () => 'أضيف الإجراء');
                if (ok) { setNewService(''); setNewQty('1'); }
              }}>
              {busy === 'add' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Plus className="h-4 w-4" aria-hidden="true" />} إضافة
            </Button>
          </div>
        )}
        {active && !a.invoice && (
          <p className="text-xs text-muted">عند إنهاء الزيارة: تُخصم مستلزمات كل إجراء من مخزون العيادة، وتُسجَّل عمولة الطبيب، وتصدر الفاتورة تلقائيًا.</p>
        )}
      </section>

      {/* Billing */}
      {permissions.billing && billable && (
        <section className="space-y-3 rounded border border-line p-3" aria-label="المحاسبة">
          <h3 className="flex items-center gap-2 text-sm font-semibold"><Receipt className="h-4 w-4 text-primary" aria-hidden="true" /> المحاسبة
            {a.invoice && <Badge tone="info">{paid?.invoiceNumber ?? a.invoice.number}</Badge>}</h3>
          <dl className="grid grid-cols-3 gap-2 text-center text-sm">
            <div className="rounded bg-surface p-2"><dt className="text-xs text-muted">الإجمالي</dt><dd className="lb-numeric font-bold">{money(total)}</dd></div>
            <div className="rounded bg-surface p-2"><dt className="text-xs text-muted">المدفوع</dt><dd className="lb-numeric font-bold text-success">{money(paidCents)}</dd></div>
            <div className="rounded bg-surface p-2"><dt className="text-xs text-muted">المتبقي</dt><dd className={due > 0 ? 'lb-numeric font-bold text-warn' : 'lb-numeric font-bold'}>{money(due)}</dd></div>
          </dl>

          {!a.invoice && !paid && active && (
            <div className="flex flex-wrap items-end gap-2">
              <label className="space-y-1 text-xs">
                <span className="text-muted">خصم (يحتاج رمز المدير)</span>
                <Input aria-label="خصم" value={discount} onChange={(e) => setDiscount(e.target.value)} inputMode="decimal" dir="ltr" placeholder="0.00" className="h-9 w-28" />
              </label>
              <Button variant="outline" disabled={!!busy} onClick={() => void invoiceNow()}>
                {busy === 'invoice' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <FileText className="h-4 w-4" aria-hidden="true" />} إصدار الفاتورة الآن
              </Button>
              <span className="text-xs text-muted">أو حصّل مباشرة وستصدر الفاتورة.</span>
            </div>
          )}

          {due > 0 && (
            <div className="flex flex-wrap items-end gap-2">
              <label className="space-y-1 text-xs">
                <span className="text-muted">طريقة الدفع</span>
                <Select value={method} onChange={(e) => setMethod(e.target.value as Method)} className="h-10">
                  <option value="cash">نقدي</option><option value="card">بطاقة</option><option value="transfer">تحويل</option><option value="wallet">محفظة</option>
                </Select>
              </label>
              <label className="space-y-1 text-xs">
                <span className="text-muted">المبلغ المستلم</span>
                <Input aria-label="المبلغ المستلم" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" dir="ltr" placeholder={fromCents(due)} className="h-10 w-32" data-testid="visit-amount" />
              </label>
              <Button disabled={!!busy} onClick={() => void pay()} data-testid="visit-pay">
                {busy === 'pay' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : method === 'cash' ? <Banknote className="h-4 w-4" aria-hidden="true" /> : <CreditCard className="h-4 w-4" aria-hidden="true" />} تحصيل
              </Button>
            </div>
          )}
          {paid && paid.changeCents > 0 && (
            <p className="rounded bg-success/10 px-3 py-2 text-sm text-success">الباقي للمريض: <span className="lb-numeric text-lg font-bold">{money(paid.changeCents)}</span></p>
          )}
          {due === 0 && (a.invoice || paid) && <p className="flex items-center gap-1 text-sm text-success"><CheckCircle2 className="h-4 w-4" aria-hidden="true" /> الزيارة محصّلة بالكامل.</p>}
        </section>
      )}
      {permissions.billing && !billable && a.status !== 'cancelled' && a.status !== 'no_show' && (
        <p className="flex items-center gap-1 text-xs text-muted"><AlertTriangle className="h-3 w-3" aria-hidden="true" /> لا يمكن المحاسبة قبل إضافة إجراء.</p>
      )}

      {approval.dialog}
    </Modal>
  );
}
