'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Droplet, HeartPulse, Loader2, Pencil, Phone, Save, UserRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/field';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Modal } from '@/components/ui/modal';
import { useToast } from '@/components/ui/toast';
import type { PatientChart, PatientProfile } from '@/modules/clinic/service';
import { savePatientAction } from '../clinic-appointments/actions';
import { failure, formatDate, type Scope } from './shared';

const BLOOD = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'] as const;

/**
 * Who the patient is, and the two things nobody may miss: allergies (red) and
 * chronic conditions (amber), always above the fold.
 */
export function PatientHeader({ scope, chart, canEdit, tz }: { scope: Scope; chart: PatientChart; canEdit: boolean; tz: string }) {
  const p = chart.patient;
  const [editing, setEditing] = useState(false);

  return (
    <section className="space-y-3 rounded-lg border border-line bg-elevated p-4" aria-label="بيانات المريض" data-testid="emr-patient">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary-soft"><UserRound className="h-6 w-6 text-primary" aria-hidden="true" /></div>
        <div className="min-w-0 flex-1 space-y-1">
          <h2 className="flex flex-wrap items-center gap-2 text-lg font-bold">
            {p.fullName}
            <Badge>ملف <span className="lb-numeric">{p.fileNumber}</span></Badge>
          </h2>
          <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted">
            {p.gender && <span>{p.gender === 'female' ? 'أنثى' : 'ذكر'}</span>}
            {p.age !== null && <span><span className="lb-numeric">{p.age}</span> سنة{p.dateOfBirth && <> · {formatDate(p.dateOfBirth, 'UTC')}</>}</span>}
            {p.bloodType && <span className="flex items-center gap-1"><Droplet className="h-3.5 w-3.5 text-danger" aria-hidden="true" /> <span dir="ltr">{p.bloodType}</span></span>}
            {p.phone && <span className="flex items-center gap-1"><Phone className="h-3.5 w-3.5" aria-hidden="true" /> <span dir="ltr">{p.phone}</span></span>}
            {p.nationalId && <span>رقم قومي <span className="lb-numeric">{p.nationalId}</span></span>}
            <span>مسجّل منذ {formatDate(p.createdAt, tz)}</span>
          </p>
        </div>
        {canEdit && <Button size="sm" variant="outline" onClick={() => setEditing(true)}><Pencil className="h-4 w-4" aria-hidden="true" /> تعديل</Button>}
      </div>

      <div className="grid gap-2 md:grid-cols-2">
        <div className={p.allergies ? 'rounded border border-danger/40 bg-danger/10 p-3' : 'rounded border border-line p-3'}>
          <p className={p.allergies ? 'flex items-center gap-1.5 text-sm font-bold text-danger' : 'flex items-center gap-1.5 text-sm font-medium text-muted'}>
            <AlertTriangle className="h-4 w-4" aria-hidden="true" /> الحساسية
          </p>
          <p className={p.allergies ? 'mt-1 text-sm text-danger' : 'mt-1 text-sm text-muted'}>{p.allergies ?? 'لا حساسية مسجّلة'}</p>
        </div>
        <div className={p.chronicConditions ? 'rounded border border-warn/40 bg-warn/10 p-3' : 'rounded border border-line p-3'}>
          <p className={p.chronicConditions ? 'flex items-center gap-1.5 text-sm font-bold text-warn' : 'flex items-center gap-1.5 text-sm font-medium text-muted'}>
            <HeartPulse className="h-4 w-4" aria-hidden="true" /> أمراض مزمنة
          </p>
          <p className="mt-1 text-sm">{p.chronicConditions ?? <span className="text-muted">لا شيء مسجّل</span>}</p>
        </div>
      </div>
      {(p.emergencyContactName || p.notes) && (
        <p className="text-xs text-muted">
          {p.emergencyContactName && <>للطوارئ: {p.emergencyContactName} {p.emergencyContactPhone && <span dir="ltr">{p.emergencyContactPhone}</span>}</>}
          {p.emergencyContactName && p.notes && ' · '}
          {p.notes}
        </p>
      )}

      {editing && <EditPatientModal scope={scope} patient={p} onClose={() => setEditing(false)} />}
    </section>
  );
}

function EditPatientModal({ scope, patient: p, onClose }: { scope: Scope; patient: PatientProfile; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [form, setForm] = useState({
    fullName: p.fullName, phone: p.phone ?? '', nationalId: p.nationalId ?? '', gender: p.gender ?? '',
    dateOfBirth: p.dateOfBirth ?? '', bloodType: p.bloodType ?? '', allergies: p.allergies ?? '',
    chronicConditions: p.chronicConditions ?? '', emergencyContactName: p.emergencyContactName ?? '',
    emergencyContactPhone: p.emergencyContactPhone ?? '', notes: p.notes ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setForm({ ...form, [k]: e.target.value });

  async function save() {
    setBusy(true);
    setError(null);
    // The save replaces the whole profile, so every field is sent back.
    const r = await savePatientAction(scope, {
      id: p.id, fullName: form.fullName,
      phone: form.phone || undefined, nationalId: form.nationalId || undefined,
      gender: (form.gender || undefined) as 'male' | 'female' | undefined,
      dateOfBirth: form.dateOfBirth || undefined,
      bloodType: (form.bloodType || undefined) as (typeof BLOOD)[number] | undefined,
      allergies: form.allergies || undefined, chronicConditions: form.chronicConditions || undefined,
      emergencyContactName: form.emergencyContactName || undefined, emergencyContactPhone: form.emergencyContactPhone || undefined,
      notes: form.notes || undefined,
    });
    setBusy(false);
    if (!r.ok) { setError(failure(r)); return; }
    toast.success('حُفظت بيانات المريض');
    onClose();
    router.refresh();
  }

  return (
    <Modal open onClose={onClose} busy={busy} size="lg" icon={Pencil} title="تعديل بيانات المريض" testId="patient-edit"
      footer={<>
        <Button variant="outline" onClick={onClose} disabled={busy}>إلغاء</Button>
        <Button onClick={() => void save()} disabled={busy || form.fullName.trim().length < 2}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Save className="h-4 w-4" aria-hidden="true" />} حفظ
        </Button>
      </>}>
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="grid gap-3 sm:grid-cols-2">
        <L label="الاسم"><Input value={form.fullName} onChange={set('fullName')} maxLength={160} /></L>
        <L label="الهاتف"><Input value={form.phone} onChange={set('phone')} inputMode="tel" dir="ltr" /></L>
        <L label="الرقم القومي"><Input value={form.nationalId} onChange={set('nationalId')} dir="ltr" maxLength={30} /></L>
        <L label="تاريخ الميلاد"><Input type="date" value={form.dateOfBirth} onChange={set('dateOfBirth')} dir="ltr" /></L>
        <L label="النوع"><Select value={form.gender} onChange={set('gender')}><option value="">—</option><option value="female">أنثى</option><option value="male">ذكر</option></Select></L>
        <L label="فصيلة الدم"><Select value={form.bloodType} onChange={set('bloodType')}><option value="">—</option>{BLOOD.map((b) => <option key={b} value={b}>{b}</option>)}</Select></L>
      </div>
      <L label="الحساسية"><Textarea value={form.allergies} onChange={set('allergies')} rows={2} maxLength={2000} placeholder="مثال: بنسلين، لاتكس" /></L>
      <L label="أمراض مزمنة"><Textarea value={form.chronicConditions} onChange={set('chronicConditions')} rows={2} maxLength={2000} placeholder="مثال: سكري، ضغط" /></L>
      <div className="grid gap-3 sm:grid-cols-2">
        <L label="اسم للطوارئ"><Input value={form.emergencyContactName} onChange={set('emergencyContactName')} maxLength={120} /></L>
        <L label="هاتف الطوارئ"><Input value={form.emergencyContactPhone} onChange={set('emergencyContactPhone')} inputMode="tel" dir="ltr" /></L>
      </div>
      <L label="ملاحظات"><Textarea value={form.notes} onChange={set('notes')} rows={2} maxLength={2000} /></L>
    </Modal>
  );
}

function L({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block space-y-1.5 text-sm"><span className="font-medium">{label}</span>{children}</label>;
}
