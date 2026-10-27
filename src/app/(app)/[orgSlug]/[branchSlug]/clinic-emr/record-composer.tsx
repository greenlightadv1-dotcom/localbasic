'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Activity, ClipboardPlus, FileText, History, Loader2, Microscope, Paperclip, Save, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/field';
import { Alert } from '@/components/ui/alert';
import { useToast } from '@/components/ui/toast';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';
import { cn } from '@/lib/cn';
import type { Vitals } from '@/modules/clinic/service';
import type { EmrInput } from '@/modules/clinic/schemas';
import { addEmrRecordAction } from './actions';
import { VITALS, failure, outOfRange, type Scope } from './shared';

type Kind = 'note' | 'diagnosis' | 'vitals' | 'history' | 'attachment';
const TABS: { kind: Kind; label: string; icon: typeof FileText }[] = [
  { kind: 'note', label: 'ملاحظة', icon: FileText },
  { kind: 'diagnosis', label: 'تشخيص', icon: Microscope },
  { kind: 'vitals', label: 'علامات حيوية', icon: Activity },
  { kind: 'history', label: 'تاريخ مرضي', icon: History },
  { kind: 'attachment', label: 'مرفق', icon: Paperclip },
];

const ALLOWED = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'application/dicom'];
const MAX_BYTES = 20 * 1024 * 1024;
const ICD10 = /^[A-Z][0-9]{2}(\.[0-9A-Z]{1,4})?$/;

/**
 * Adds one entry to the chart. Records are append-only in the database; a
 * mistake is fixed with an amendment, never an edit.
 *
 * Attachments go browser → private 'clinic-records' bucket under the
 * signed-in member's own session (the storage policy checks clinic.emr.write
 * and that the folder is this patient's), then the entry is recorded.
 */
export function RecordComposer({ scope, organizationId, patientId, appointmentId, initial = 'note', compact }: {
  scope: Scope; organizationId: string; patientId: string; appointmentId: string | null; initial?: Kind; compact?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [kind, setKind] = useState<Kind>(initial);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [code, setCode] = useState('');
  const [vitals, setVitals] = useState<Partial<Record<keyof Vitals, string>>>({});
  const [file, setFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsedVitals = Object.fromEntries(
    VITALS.map((v) => [v.key, vitals[v.key]?.trim() ? Number(vitals[v.key]) : undefined]),
  ) as Partial<Record<keyof Vitals, number>>;
  const vitalErrors = VITALS.filter((v) => {
    const n = parsedVitals[v.key];
    return n !== undefined && (!Number.isFinite(n) || n < v.min || n > v.max);
  });
  const bpBad = parsedVitals.systolicMmhg !== undefined && parsedVitals.diastolicMmhg !== undefined && parsedVitals.systolicMmhg <= parsedVitals.diastolicMmhg;
  const codeUpper = code.trim().toUpperCase();

  const blocker =
    kind === 'note' || kind === 'history' ? (body.trim() ? null : 'اكتب النص.')
    : kind === 'diagnosis' ? (!codeUpper && !body.trim() ? 'أدخل رمز ICD-10 أو وصف التشخيص.' : codeUpper && !ICD10.test(codeUpper) ? 'رمز ICD-10 غير صالح (مثل J06.9).' : null)
    : kind === 'vitals' ? (Object.values(parsedVitals).every((v) => v === undefined) ? 'أدخل قياسًا واحدًا على الأقل.' : vitalErrors.length ? `قيمة خارج النطاق: ${vitalErrors.map((v) => v.label).join('، ')}` : bpBad ? 'الانقباضي يجب أن يكون أعلى من الانبساطي.' : null)
    : !file ? 'اختر ملفًا.' : !ALLOWED.includes(file.type) ? 'النوع المسموح: PDF أو صورة أو DICOM.' : file.size > MAX_BYTES ? 'الحد الأقصى 20 ميجابايت.' : null;

  function reset() { setTitle(''); setBody(''); setCode(''); setVitals({}); setFile(null); if (fileRef.current) fileRef.current.value = ''; }

  async function save() {
    if (blocker) return;
    setBusy(true);
    setError(null);
    const base = { patientId, appointmentId, title: title.trim() || undefined };
    let input: EmrInput;

    if (kind === 'attachment' && file) {
      const safe = file.name.normalize('NFKC').replace(/[^\w.\-]+/g, '_').slice(-80) || 'file';
      const path = `${organizationId}/${patientId}/${crypto.randomUUID()}-${safe}`;
      const upload = await createSupabaseBrowserClient().storage.from('clinic-records').upload(path, file, { contentType: file.type, upsert: false });
      if (upload.error) {
        setBusy(false);
        setError('تعذّر رفع الملف. تحقق من الصلاحية والحجم ثم حاول مرة أخرى.');
        return;
      }
      input = { ...base, type: 'attachment', body: body.trim() || undefined, attachmentPath: path, attachmentMime: file.type, attachmentBytes: file.size };
    } else if (kind === 'vitals') {
      input = { ...base, type: 'vitals', vitals: parsedVitals };
    } else if (kind === 'diagnosis') {
      input = { ...base, type: 'diagnosis', body: body.trim() || undefined, diagnosisCode: codeUpper || undefined };
    } else if (kind === 'note' || kind === 'history') {
      input = { ...base, type: kind, body: body.trim() };
    } else {
      setBusy(false);
      return;
    }

    const r = await addEmrRecordAction(scope, input);
    setBusy(false);
    if (!r.ok) { setError(failure(r)); return; }
    toast.success('أضيف إلى الملف');
    reset();
    router.refresh();
  }

  return (
    <div className={cn('space-y-3', !compact && 'rounded-lg border border-line bg-elevated p-4')}>
      {!compact && <h3 className="flex items-center gap-2 text-sm font-semibold"><ClipboardPlus className="h-4 w-4 text-primary" aria-hidden="true" /> إضافة إلى الملف</h3>}
      <div className="flex flex-wrap gap-1" role="tablist" aria-label="نوع السجل">
        {TABS.map(({ kind: k, label, icon: Icon }) => (
          <button key={k} type="button" role="tab" aria-selected={kind === k} onClick={() => { setKind(k); setError(null); }}
            className={cn('flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm', kind === k ? 'border-primary bg-primary text-primary-fg' : 'border-line bg-elevated hover:border-primary')}>
            <Icon className="h-4 w-4" aria-hidden="true" /> {label}
          </button>
        ))}
      </div>

      {error && <Alert tone="danger">{error}</Alert>}

      {(kind === 'note' || kind === 'history') && (
        <>
          <Input aria-label="عنوان" placeholder="عنوان (اختياري)" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
          <Textarea aria-label="النص" value={body} onChange={(e) => setBody(e.target.value)} rows={4} maxLength={20000}
            placeholder={kind === 'note' ? 'الشكوى، الفحص، الخطة…' : 'عمليات سابقة، أمراض العائلة، أدوية مستمرة…'} data-testid="emr-body" />
        </>
      )}

      {kind === 'diagnosis' && (
        <>
          <div className="flex flex-wrap gap-2">
            <Input aria-label="رمز ICD-10" placeholder="ICD-10 (مثل J06.9)" value={code} onChange={(e) => setCode(e.target.value)} dir="ltr" maxLength={8}
              className={cn('w-44', codeUpper && !ICD10.test(codeUpper) && 'border-danger')} />
            <Input aria-label="عنوان" placeholder="عنوان التشخيص" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} className="min-w-[12rem] flex-1" />
          </div>
          <Textarea aria-label="وصف التشخيص" value={body} onChange={(e) => setBody(e.target.value)} rows={3} maxLength={20000} placeholder="وصف التشخيص والملاحظات" />
        </>
      )}

      {kind === 'vitals' && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {VITALS.map((v) => {
            const n = parsedVitals[v.key];
            const bad = n !== undefined && (!Number.isFinite(n) || n < v.min || n > v.max);
            const flag = !bad && n !== undefined && outOfRange(v.key, n);
            return (
              <label key={v.key} className="space-y-1 text-xs">
                <span className="flex justify-between text-muted"><span>{v.label}</span><span dir="ltr">{v.unit}</span></span>
                <Input value={vitals[v.key] ?? ''} onChange={(e) => setVitals({ ...vitals, [v.key]: e.target.value })} inputMode="decimal" dir="ltr"
                  aria-invalid={bad} className={cn('h-9', bad && 'border-danger', flag && 'border-warn')} placeholder={`${v.min}–${v.max}`} />
                {flag && <span className="text-warn">خارج المعدل المعتاد</span>}
              </label>
            );
          })}
        </div>
      )}

      {kind === 'attachment' && (
        <>
          <label className="flex cursor-pointer flex-col items-center gap-2 rounded-lg border border-dashed border-line p-5 text-center text-sm hover:border-primary">
            <Upload className="h-6 w-6 text-primary" aria-hidden="true" />
            {file ? <span className="font-medium">{file.name} <span className="text-muted">({(file.size / 1024 / 1024).toFixed(1)} م.ب)</span></span>
              : <span className="text-muted">تحليل، أشعة، تقرير — PDF أو صورة أو DICOM حتى 20 م.ب</span>}
            <input ref={fileRef} type="file" accept={ALLOWED.join(',')} className="sr-only" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
          <Input aria-label="وصف المرفق" placeholder="وصف (اختياري)" value={body} onChange={(e) => setBody(e.target.value)} maxLength={500} />
        </>
      )}

      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted">{blocker ?? (appointmentId ? 'يُربط بالزيارة الحالية.' : 'يُضاف إلى الملف دون زيارة.')}</p>
        <Button onClick={() => void save()} disabled={!!blocker || busy} data-testid="emr-save">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Save className="h-4 w-4" aria-hidden="true" />} حفظ
        </Button>
      </div>
    </div>
  );
}
