'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2, Loader2, PackageMinus, Plus, Receipt, Stethoscope, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/field';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/ui/confirm';
import { useToast } from '@/components/ui/toast';
import { formatMoney } from '@/lib/money';
import type { ChartVisit, ClinicWorkspace, PatientChart } from '@/modules/clinic/service';
import { minutesToHm, toLocal } from '@/modules/clinic/time';
import { addVisitServiceAction, removeVisitServiceAction, setAppointmentStatusAction } from '../clinic-appointments/actions';
import { STATUS_META } from '../clinic-appointments/shared';
import { RecordComposer } from './record-composer';
import { failure, type EmrPermissions, type Scope } from './shared';

const UNIT: Record<string, string> = { g: 'جم', ml: 'مل', pc: 'قطعة' };

/**
 * The visit being documented now. The doctor writes notes, diagnosis and
 * vitals against it, records the procedures performed (with the supplies each
 * one will take from stock), and completes it. Completion is one database
 * transaction: supplies leave the clinic location, the commission accrues and
 * the invoice is issued for the front desk.
 */
export function VisitPanel({ scope, organizationId, currency, workspace, chart, permissions }: {
  scope: Scope; organizationId: string; currency: string; workspace: ClinicWorkspace; chart: PatientChart; permissions: EmrPermissions;
}) {
  const visit = chart.visits.find((v) => v.id === chart.activeVisitId) ?? null;
  const lastCompleted = chart.visits.find((v) => v.status === 'completed') ?? null;

  if (!visit) {
    return (
      <>
        {lastCompleted && <CompletedSummary visit={lastCompleted} currency={currency} workspace={workspace} />}
        {permissions.write && <RecordComposer scope={scope} organizationId={organizationId} patientId={chart.patient.id} appointmentId={null} />}
      </>
    );
  }
  return <ActiveVisit scope={scope} organizationId={organizationId} currency={currency} workspace={workspace} chart={chart} visit={visit} permissions={permissions} />;
}

function ActiveVisit({ scope, organizationId, currency, workspace, chart, visit, permissions }: {
  scope: Scope; organizationId: string; currency: string; workspace: ClinicWorkspace; chart: PatientChart; visit: ChartVisit; permissions: EmrPermissions;
}) {
  const router = useRouter();
  const toast = useToast();
  const money = (c: number) => formatMoney(c, currency);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [service, setService] = useState('');
  const [qty, setQty] = useState('1');
  const [confirming, setConfirming] = useState(false);

  const doctor = workspace.doctors.find((d) => d.id === visit.doctorId);
  const start = toLocal(visit.startsAt, workspace.timezone);
  const editable = permissions.write && !visit.invoice && ['booked', 'checked_in', 'in_session'].includes(visit.status);
  const supplies = (serviceId: string) => chart.serviceSupplies[serviceId] ?? [];
  const total = visit.services.reduce((s, l) => s + l.quantity * l.unitPriceCents - l.discountCents, 0);
  const preview = service ? supplies(service) : [];

  // Everything that will leave stock on completion, summed per item.
  const deductions = new Map<string, { qty: number; unit: string }>();
  for (const l of visit.services) {
    for (const s of supplies(l.serviceId)) {
      const cur = deductions.get(s.itemName) ?? { qty: 0, unit: s.unit };
      deductions.set(s.itemName, { qty: cur.qty + s.qty * l.quantity, unit: s.unit });
    }
  }

  async function run(key: string, call: () => Promise<{ ok: true } | { ok: false; error: string; code: string }>, message: string) {
    setBusy(key);
    setError(null);
    const r = await call();
    setBusy(null);
    if (!r.ok) { setError(failure(r)); return false; }
    toast.success(message);
    router.refresh();
    return true;
  }

  return (
    <section className="space-y-4 rounded-lg border-2 border-primary/30 bg-elevated p-4" aria-label="الزيارة الحالية" data-testid="emr-visit">
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="flex items-center gap-2 font-semibold"><Stethoscope className="h-5 w-5 text-primary" aria-hidden="true" /> الزيارة الحالية</h3>
        <Badge tone={STATUS_META[visit.status].tone}>{STATUS_META[visit.status].label}</Badge>
        <span className="text-sm text-muted"><span className="lb-numeric">{minutesToHm(start.minutes)}</span> · {doctor?.name ?? ''}{visit.reason ? ` · ${visit.reason}` : ''}</span>
        <div className="ms-auto flex gap-2">
          {visit.status === 'checked_in' && permissions.write && (
            <Button size="sm" disabled={!!busy} onClick={() => void run('start', () => setAppointmentStatusAction(scope, { appointmentId: visit.id, status: 'in_session' }), 'بدأ الكشف')}>
              {busy === 'start' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Stethoscope className="h-4 w-4" aria-hidden="true" />} بدء الكشف
            </Button>
          )}
          {visit.status === 'in_session' && permissions.write && (
            <Button size="sm" disabled={!!busy || visit.services.length === 0} onClick={() => setConfirming(true)} data-testid="emr-complete">
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> إنهاء الزيارة
            </Button>
          )}
        </div>
      </header>

      {visit.status === 'booked' && <Alert tone="info">المريض لم يسجّل وصوله بعد. يمكنك الكتابة في الملف، ويبدأ الكشف بعد تسجيل الوصول.</Alert>}
      {error && <Alert tone="danger">{error}</Alert>}

      {permissions.write && (
        <RecordComposer scope={scope} organizationId={organizationId} patientId={chart.patient.id} appointmentId={visit.id} compact />
      )}

      {/* Procedures and consumables */}
      <div className="space-y-2 border-t border-line pt-3">
        <h4 className="text-sm font-semibold">الإجراءات التي تمت</h4>
        {visit.services.length === 0 ? (
          <p className="rounded border border-dashed border-line py-3 text-center text-sm text-muted">أضف الإجراء قبل إنهاء الزيارة.</p>
        ) : (
          <ul className="space-y-1.5">
            {visit.services.map((l) => (
              <li key={l.lineId} className="flex flex-wrap items-center justify-between gap-2 rounded border border-line px-3 py-2 text-sm">
                <span className="min-w-0">
                  <span className="font-medium">{l.name}</span> {l.quantity > 1 && <span className="lb-numeric text-muted">× {l.quantity}</span>}
                  {supplies(l.serviceId).length > 0 && (
                    <span className="block text-xs text-muted">
                      يستهلك: {supplies(l.serviceId).map((s) => `${s.itemName} ${s.qty * l.quantity} ${UNIT[s.unit] ?? s.unit}`).join('، ')}
                    </span>
                  )}
                </span>
                <span className="flex items-center gap-2">
                  <span className="lb-numeric">{money(l.quantity * l.unitPriceCents - l.discountCents)}</span>
                  {editable && (
                    <Button size="icon" variant="ghost" aria-label={`حذف ${l.name}`} disabled={!!busy}
                      onClick={() => void run(`rm-${l.lineId}`, () => removeVisitServiceAction(scope, { lineId: l.lineId }), `حُذف ${l.name}`)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
        {editable && (
          <div className="space-y-1">
            <div className="flex flex-wrap gap-2">
              <Select aria-label="إجراء" value={service} onChange={(e) => setService(e.target.value)} className="min-w-[12rem] flex-1">
                <option value="">إضافة إجراء…</option>
                {workspace.services.map((s) => <option key={s.id} value={s.id}>{s.name} · {money(s.priceCents)}</option>)}
              </Select>
              <Input aria-label="الكمية" value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, ''))} inputMode="numeric" dir="ltr" className="w-20 text-center" />
              <Button variant="secondary" disabled={!service || !(Number(qty) >= 1) || !!busy}
                onClick={async () => {
                  const ok = await run('add', () => addVisitServiceAction(scope, { appointmentId: visit.id, serviceId: service, quantity: Number(qty) }), 'أضيف الإجراء');
                  if (ok) { setService(''); setQty('1'); }
                }}>
                {busy === 'add' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Plus className="h-4 w-4" aria-hidden="true" />} إضافة
              </Button>
            </div>
            {preview.length > 0 && <p className="text-xs text-muted">سيستهلك: {preview.map((s) => `${s.itemName} ${s.qty * Number(qty || 1)} ${UNIT[s.unit] ?? s.unit}`).join('، ')}</p>}
          </div>
        )}
        <p className="flex justify-between text-sm"><span className="text-muted">إجمالي الزيارة</span><span className="lb-numeric font-semibold">{money(total)}</span></p>
      </div>

      <ConfirmDialog
        open={confirming}
        title="إنهاء الزيارة"
        description="سيتم في عملية واحدة: خصم المستلزمات من مخزون العيادة، وتسجيل عمولة الطبيب، وإصدار الفاتورة للاستقبال. لا يمكن إضافة إجراءات بعدها."
        confirmLabel="إنهاء وإصدار الفاتورة"
        tone="primary"
        busy={busy === 'complete'}
        onCancel={() => setConfirming(false)}
        onConfirm={async () => {
          const ok = await run('complete', () => setAppointmentStatusAction(scope, { appointmentId: visit.id, status: 'completed' }), 'انتهت الزيارة وصدرت الفاتورة');
          if (ok) setConfirming(false);
        }}
      >
        {deductions.size > 0 && (
          <div className="rounded border border-line p-3 text-sm">
            <p className="mb-1 flex items-center gap-1.5 font-medium"><PackageMinus className="h-4 w-4 text-primary" aria-hidden="true" /> يُخصم من المخزون</p>
            <ul className="space-y-0.5 text-muted">
              {[...deductions].map(([name, d]) => <li key={name} className="flex justify-between"><span>{name}</span><span className="lb-numeric">{d.qty} {UNIT[d.unit] ?? d.unit}</span></li>)}
            </ul>
          </div>
        )}
        <p className="flex justify-between text-sm"><span>إجمالي الفاتورة</span><span className="lb-numeric font-bold">{money(total)}</span></p>
      </ConfirmDialog>
    </section>
  );
}

function CompletedSummary({ visit, currency, workspace }: { visit: ChartVisit; currency: string; workspace: ClinicWorkspace }) {
  const recent = Date.now() - Date.parse(visit.startsAt) < 24 * 3600 * 1000;
  if (!recent) return null;
  const money = (c: number) => formatMoney(c, currency);
  const doctor = workspace.doctors.find((d) => d.id === visit.doctorId);
  return (
    <Alert tone="success" title="آخر زيارة اليوم انتهت">
      <span className="block">{doctor?.name ?? ''} · {visit.services.map((s) => s.name).join('، ')}</span>
      {visit.services.some((s) => s.consumed) && <span className="block">خُصمت المستلزمات من مخزون العيادة وسُجّلت العمولة.</span>}
      {visit.invoice && (
        <span className="mt-1 flex items-center gap-1"><Receipt className="h-4 w-4" aria-hidden="true" /> فاتورة <span className="lb-numeric font-semibold">{visit.invoice.number}</span> ·
          {visit.invoice.paidCents >= visit.invoice.totalCents ? ' محصّلة' : ` متبقٍ ${money(visit.invoice.totalCents - visit.invoice.paidCents)} عند الاستقبال`}</span>
      )}
    </Alert>
  );
}
