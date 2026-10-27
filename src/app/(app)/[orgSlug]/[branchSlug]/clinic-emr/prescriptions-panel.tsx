'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Ban, Check, Copy, ExternalLink, Loader2, MessageCircle, Pill, Plus, Printer, Share2, Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/field';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Modal } from '@/components/ui/modal';
import { useToast } from '@/components/ui/toast';
import type { ClinicWorkspace, PatientChart, PrescriptionView } from '@/modules/clinic/service';
import { cancelPrescriptionAction, issuePrescriptionAction, sharePrescriptionAction } from './actions';
import { DOSAGE_FORMS, FREQUENCIES, ROUTES, failure, formatDate, type EmrPermissions, type Scope } from './shared';

type Line = { key: number; drugName: string; strength: string; dosageForm: string; dose: string; route: string; frequency: string; duration: string; instructions: string };
let n = 0;
const blank = (): Line => ({ key: ++n, drugName: '', strength: '', dosageForm: '', dose: '', route: '', frequency: '', duration: '', instructions: '' });

/**
 * Prescriptions: the patient's list, the builder, sharing and cancelling.
 * Issuing is a doctor's act (the database checks the signed-in user is one).
 * A share link is minted fresh each time it is sent and expires on the
 * clinic's schedule; cancelling a prescription kills its link at once.
 */
export function PrescriptionsPanel({ scope, workspace, chart, permissions }: {
  scope: Scope; workspace: ClinicWorkspace; chart: PatientChart; permissions: EmrPermissions;
}) {
  const [building, setBuilding] = useState(false);
  const [sharing, setSharing] = useState<PrescriptionView | null>(null);
  const [cancelling, setCancelling] = useState<PrescriptionView | null>(null);
  const doctorName = new Map(workspace.doctors.map((d) => [d.id, d.name]));
  const tz = workspace.timezone;

  return (
    <section className="space-y-3 rounded-lg border border-line bg-elevated p-4" aria-label="الروشتات" data-testid="emr-rx">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 font-semibold"><Pill className="h-4 w-4 text-primary" aria-hidden="true" /> الروشتات</h3>
        {permissions.prescribe && <Button size="sm" onClick={() => setBuilding(true)} data-testid="rx-new"><Plus className="h-4 w-4" aria-hidden="true" /> روشتة جديدة</Button>}
      </div>
      {!permissions.prescribe && permissions.prescriptionWrite && (
        <p className="text-xs text-muted">إصدار الروشتة للأطباء المسجّلين فقط؛ اربط حسابك بملف طبيب.</p>
      )}

      {chart.prescriptions.length === 0 ? (
        <p className="text-sm text-muted">لا روشتات سابقة.</p>
      ) : (
        <ul className="space-y-2">
          {chart.prescriptions.map((rx) => (
            <li key={rx.id} className="rounded border border-line p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="lb-numeric font-semibold">{rx.number}</span>
                <Badge tone={rx.status === 'issued' ? 'success' : 'danger'}>{rx.status === 'issued' ? 'سارية' : 'ملغاة'}</Badge>
                <span className="text-xs text-muted">{formatDate(rx.issuedAt, tz)} · {doctorName.get(rx.doctorId) ?? ''}</span>
              </div>
              <ul className="mt-2 space-y-0.5 text-sm">
                {rx.items.map((i, idx) => (
                  <li key={idx}><span className="font-medium">{i.drugName}</span>{i.strength && <span dir="ltr"> {i.strength}</span>}
                    <span className="text-muted">{[i.dosageForm, i.dose, i.frequency, i.duration].filter(Boolean).map((x) => ` · ${x}`).join('')}</span></li>
                ))}
              </ul>
              {rx.notes && <p className="mt-1 text-xs text-muted">{rx.notes}</p>}
              {rx.cancelReason && <p className="mt-1 text-xs text-danger">سبب الإلغاء: {rx.cancelReason}</p>}
              {rx.status === 'issued' && permissions.prescriptionWrite && (
                <div className="mt-2 flex gap-2">
                  <Button size="sm" variant="secondary" onClick={() => setSharing(rx)}><Share2 className="h-4 w-4" aria-hidden="true" /> مشاركة / طباعة</Button>
                  {(rx.doctorId === workspace.myDoctorId || permissions.manageDoctors) && (
                    <Button size="sm" variant="ghost" onClick={() => setCancelling(rx)}><Ban className="h-4 w-4" aria-hidden="true" /> إلغاء</Button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {building && (
        <BuilderModal scope={scope} chart={chart} onClose={() => setBuilding(false)}
          onIssued={(rx) => { setBuilding(false); setSharing(rx); }} />
      )}
      {sharing && <ShareModal scope={scope} prescription={sharing} patientName={chart.patient.fullName} hasPhone={!!chart.patient.phone} onClose={() => setSharing(null)} />}
      {cancelling && <CancelModal scope={scope} prescription={cancelling} onClose={() => setCancelling(null)} />}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------
function BuilderModal({ scope, chart, onClose, onIssued }: {
  scope: Scope; chart: PatientChart; onClose: () => void; onIssued: (rx: PrescriptionView) => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [lines, setLines] = useState<Line[]>([blank()]);
  const [notes, setNotes] = useState('');
  const [linkVisit, setLinkVisit] = useState(!!chart.activeVisitId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filled = lines.filter((l) => l.drugName.trim());
  const set = (key: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const allergy = chart.patient.allergies?.trim();

  async function issue() {
    setBusy(true);
    setError(null);
    const r = await issuePrescriptionAction(scope, {
      patientId: chart.patient.id,
      appointmentId: linkVisit ? chart.activeVisitId : null,
      notes: notes.trim() || undefined,
      items: filled.map((l) => ({
        drugName: l.drugName.trim(), strength: l.strength.trim() || undefined, dosageForm: l.dosageForm || undefined,
        dose: l.dose.trim() || undefined, route: l.route || undefined, frequency: l.frequency.trim() || undefined,
        duration: l.duration.trim() || undefined, instructions: l.instructions.trim() || undefined,
      })),
    });
    setBusy(false);
    if (!r.ok) { setError(failure(r)); return; }
    toast.success(`صدرت الروشتة ${r.data.number}`);
    router.refresh();
    onIssued({
      id: r.data.id, number: r.data.number, status: 'issued', notes: notes.trim() || null, issuedAt: new Date().toISOString(),
      expiresAt: r.data.expiresAt, doctorId: '', appointmentId: linkVisit ? chart.activeVisitId : null, cancelReason: null,
      items: filled.map((l) => ({ drugName: l.drugName, strength: l.strength || null, dosageForm: l.dosageForm || null, dose: l.dose || null, route: l.route || null, frequency: l.frequency || null, duration: l.duration || null, instructions: l.instructions || null })),
    });
  }

  return (
    <Modal open onClose={onClose} busy={busy} size="lg" icon={Pill} title={`روشتة جديدة — ${chart.patient.fullName}`} testId="rx-builder"
      footer={<>
        <span className="me-auto text-xs text-muted">{filled.length} دواء</span>
        <Button variant="outline" onClick={onClose} disabled={busy}>إلغاء</Button>
        <Button onClick={() => void issue()} disabled={busy || filled.length === 0} data-testid="rx-issue">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Check className="h-4 w-4" aria-hidden="true" />} إصدار الروشتة
        </Button>
      </>}>
      {allergy && <Alert tone="danger" title="حساسية المريض">{allergy}</Alert>}
      {error && <Alert tone="danger">{error}</Alert>}

      <datalist id="rx-frequencies">{FREQUENCIES.map((f) => <option key={f} value={f} />)}</datalist>
      <ol className="space-y-3">
        {lines.map((l, idx) => (
          <li key={l.key} className="space-y-2 rounded border border-line p-3">
            <div className="flex items-center gap-2">
              <span className="lb-numeric flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary-soft text-xs font-bold text-primary">{idx + 1}</span>
              <Input aria-label="اسم الدواء" placeholder="اسم الدواء" value={l.drugName} onChange={(e) => set(l.key, { drugName: e.target.value })} maxLength={160} className="flex-1" />
              <Input aria-label="التركيز" placeholder="التركيز (500mg)" value={l.strength} onChange={(e) => set(l.key, { strength: e.target.value })} dir="ltr" maxLength={60} className="w-32" />
              {lines.length > 1 && <Button size="icon" variant="ghost" aria-label="حذف الدواء" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}><Trash2 className="h-4 w-4" /></Button>}
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              <Select aria-label="الشكل" value={l.dosageForm} onChange={(e) => set(l.key, { dosageForm: e.target.value })}>
                <option value="">الشكل</option>{DOSAGE_FORMS.map((f) => <option key={f} value={f}>{f}</option>)}
              </Select>
              <Input aria-label="الجرعة" placeholder="الجرعة (قرص)" value={l.dose} onChange={(e) => set(l.key, { dose: e.target.value })} maxLength={60} />
              <Input aria-label="التكرار" placeholder="التكرار" list="rx-frequencies" value={l.frequency} onChange={(e) => set(l.key, { frequency: e.target.value })} maxLength={80} />
              <Input aria-label="المدة" placeholder="المدة (5 أيام)" value={l.duration} onChange={(e) => set(l.key, { duration: e.target.value })} maxLength={60} />
              <Select aria-label="طريقة الاستعمال" value={l.route} onChange={(e) => set(l.key, { route: e.target.value })}>
                <option value="">الطريقة</option>{ROUTES.map((r) => <option key={r} value={r}>{r}</option>)}
              </Select>
            </div>
            <Input aria-label="تعليمات" placeholder="تعليمات (بعد الأكل…)" value={l.instructions} onChange={(e) => set(l.key, { instructions: e.target.value })} maxLength={500} />
          </li>
        ))}
      </ol>
      {lines.length < 30 && <Button variant="outline" size="sm" onClick={() => setLines((ls) => [...ls, blank()])}><Plus className="h-4 w-4" aria-hidden="true" /> دواء آخر</Button>}

      <label className="block space-y-1.5 text-sm">
        <span className="font-medium">ملاحظات الطبيب</span>
        <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={2000} placeholder="متابعة بعد أسبوع، تحاليل مطلوبة…" />
      </label>
      {chart.activeVisitId && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={linkVisit} onChange={(e) => setLinkVisit(e.target.checked)} className="h-4 w-4" /> ربط بالزيارة الحالية
        </label>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Share
// ---------------------------------------------------------------------------
function ShareModal({ scope, prescription: rx, patientName, hasPhone, onClose }: {
  scope: Scope; prescription: PrescriptionView; patientName: string; hasPhone: boolean; onClose: () => void;
}) {
  const toast = useToast();
  const [link, setLink] = useState<{ url: string; expiresAt: string; whatsappUrl: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    let live = true;
    void sharePrescriptionAction(scope, { prescriptionId: rx.id }).then((r) => {
      if (!live) return;
      setBusy(false);
      if (!r.ok) { setError(failure(r)); return; }
      setLink(r.data);
    });
    return () => { live = false; };
  }, [scope, rx.id]);

  async function copy() {
    if (!link) return;
    try { await navigator.clipboard.writeText(link.url); toast.success('نُسخ الرابط'); }
    catch { toast.error('تعذّر النسخ؛ انسخ الرابط يدويًا.'); }
  }

  return (
    <Modal open onClose={onClose} size="md" icon={Share2} title={`مشاركة ${rx.number}`} description={patientName} testId="rx-share"
      footer={<Button variant="outline" onClick={onClose}>إغلاق</Button>}>
      {busy && <p className="flex items-center gap-2 text-sm text-muted"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> جارٍ إنشاء رابط آمن…</p>}
      {error && <Alert tone="danger">{error}</Alert>}
      {link && (
        <>
          <div className="flex gap-2">
            <Input readOnly value={link.url} dir="ltr" aria-label="رابط الروشتة" onFocus={(e) => e.target.select()} className="text-xs" />
            <Button variant="outline" onClick={() => void copy()}><Copy className="h-4 w-4" aria-hidden="true" /> نسخ</Button>
          </div>
          <p className="text-xs text-muted">الرابط صالح حتى {formatDate(link.expiresAt, 'UTC')}. أي رابط سابق لهذه الروشتة توقف عن العمل الآن.</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {link.whatsappUrl ? (
              <a href={link.whatsappUrl} target="_blank" rel="noopener noreferrer"
                className="flex h-12 items-center justify-center gap-2 rounded bg-[#25D366] px-4 font-medium text-white hover:opacity-90">
                <MessageCircle className="h-5 w-5" aria-hidden="true" /> إرسال على واتساب
              </a>
            ) : (
              <p className="flex items-center justify-center rounded border border-dashed border-line p-3 text-center text-xs text-muted">
                {hasPhone ? 'رقم المريض غير صالح لواتساب.' : 'لا يوجد رقم هاتف للمريض؛ انسخ الرابط وأرسله.'}
              </p>
            )}
            <a href={link.url} target="_blank" rel="noopener noreferrer"
              className="flex h-12 items-center justify-center gap-2 rounded border border-line px-4 font-medium hover:bg-surface">
              <Printer className="h-5 w-5" aria-hidden="true" /> فتح للطباعة <ExternalLink className="h-4 w-4" aria-hidden="true" />
            </a>
          </div>
        </>
      )}
    </Modal>
  );
}

function CancelModal({ scope, prescription: rx, onClose }: { scope: Scope; prescription: PrescriptionView; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal open onClose={onClose} busy={busy} size="sm" icon={Ban} title={`إلغاء ${rx.number}`} description="يتوقف رابط المشاركة فورًا وتبقى الروشتة في الملف كملغاة."
      footer={<>
        <Button variant="outline" onClick={onClose} disabled={busy}>رجوع</Button>
        <Button variant="danger" disabled={busy || reason.trim().length < 2} onClick={async () => {
          setBusy(true); setError(null);
          const r = await cancelPrescriptionAction(scope, { prescriptionId: rx.id, reason: reason.trim() });
          setBusy(false);
          if (!r.ok) { setError(failure(r)); return; }
          toast.success(`أُلغيت ${rx.number}`); onClose(); router.refresh();
        }}>{busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Ban className="h-4 w-4" aria-hidden="true" />} تأكيد الإلغاء</Button>
      </>}>
      {error && <Alert tone="danger">{error}</Alert>}
      <Textarea autoFocus aria-label="سبب الإلغاء" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={300} placeholder="مثال: جرعة خاطئة" />
    </Modal>
  );
}
