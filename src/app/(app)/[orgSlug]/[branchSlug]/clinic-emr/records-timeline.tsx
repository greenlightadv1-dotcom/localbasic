'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Activity, ExternalLink, FileText, History, Loader2, Microscope, Paperclip, PenLine } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/field';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/patterns/states';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import type { ClinicWorkspace, EmrRecord, EmrRecordType, PatientChart } from '@/modules/clinic/service';
import { addEmrRecordAction } from './actions';
import { RECORD_LABELS, VITALS, failure, formatDateTime, outOfRange, type EmrPermissions, type Scope } from './shared';

const ICON: Record<EmrRecordType, typeof FileText> = {
  note: FileText, diagnosis: Microscope, vitals: Activity, history: History, attachment: Paperclip, amendment: PenLine,
};
type Filter = 'all' | 'note' | 'diagnosis' | 'vitals' | 'attachment';

/**
 * The chart, newest first. Amendments are shown under the entry they correct,
 * never in place of it: the original stays visible, as the record requires.
 */
export function RecordsTimeline({ scope, workspace, chart, permissions }: {
  scope: Scope; organizationId: string; workspace: ClinicWorkspace; chart: PatientChart; permissions: EmrPermissions;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const doctorName = new Map(workspace.doctors.map((d) => [d.id, d.name]));
  const amendments = useMemo(() => {
    const m = new Map<string, EmrRecord[]>();
    for (const r of chart.records) if (r.type === 'amendment' && r.amendsId) m.set(r.amendsId, [...(m.get(r.amendsId) ?? []), r]);
    return m;
  }, [chart.records]);
  const entries = chart.records.filter((r) => r.type !== 'amendment' && (filter === 'all' || r.type === filter || (filter === 'note' && r.type === 'history')));

  return (
    <section className="space-y-3" aria-label="السجل الطبي">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">السجل الطبي <span className="text-sm font-normal text-muted">({chart.records.length})</span></h3>
        <div className="flex flex-wrap gap-1 text-xs" role="radiogroup" aria-label="تصفية">
          {([['all', 'الكل'], ['note', 'ملاحظات'], ['diagnosis', 'تشخيصات'], ['vitals', 'علامات حيوية'], ['attachment', 'مرفقات']] as const).map(([k, l]) => (
            <button key={k} type="button" role="radio" aria-checked={filter === k} onClick={() => setFilter(k)}
              className={cn('rounded-full border px-3 py-1', filter === k ? 'border-primary bg-primary-soft text-primary' : 'border-line hover:bg-surface')}>{l}</button>
          ))}
        </div>
      </div>

      {entries.length === 0 ? (
        <div className="rounded-lg border border-line bg-elevated">
          <EmptyState icon={FileText} title="لا سجلات" description={permissions.write ? 'ابدأ بملاحظة أو علامات حيوية من الأعلى.' : 'لم يُسجَّل شيء في الملف بعد.'} />
        </div>
      ) : (
        <ol className="relative space-y-3 border-s-2 border-line ps-4">
          {entries.map((r) => (
            <RecordItem key={r.id} scope={scope} record={r} amendments={amendments.get(r.id) ?? []} tz={workspace.timezone}
              doctor={r.doctorId ? doctorName.get(r.doctorId) ?? null : null} patientId={chart.patient.id} canAmend={permissions.write} />
          ))}
        </ol>
      )}
    </section>
  );
}

function RecordItem({ scope, record: r, amendments, tz, doctor, patientId, canAmend }: {
  scope: Scope; record: EmrRecord; amendments: EmrRecord[]; tz: string; doctor: string | null; patientId: string; canAmend: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const Icon = ICON[r.type];
  const [amending, setAmending] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function amend() {
    setBusy(true);
    setError(null);
    const res = await addEmrRecordAction(scope, { type: 'amendment', patientId, appointmentId: r.appointmentId, amendsId: r.id, body: text.trim() });
    setBusy(false);
    if (!res.ok) { setError(failure(res)); return; }
    toast.success('أضيف التصحيح');
    setAmending(false);
    setText('');
    router.refresh();
  }

  return (
    <li className="relative">
      <span className="absolute -start-[1.65rem] top-1 flex h-6 w-6 items-center justify-center rounded-full border-2 border-elevated bg-primary-soft" aria-hidden="true">
        <Icon className="h-3.5 w-3.5 text-primary" />
      </span>
      <article className="rounded-lg border border-line bg-elevated p-3" data-testid="emr-record">
        <header className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <Badge tone={r.type === 'diagnosis' ? 'info' : 'neutral'}>{RECORD_LABELS[r.type]}</Badge>
          {r.diagnosisCode && <Badge tone="info"><span dir="ltr">{r.diagnosisCode}</span></Badge>}
          <span>{formatDateTime(r.createdAt, tz)}</span>
          <span>· {r.author}{doctor && doctor !== r.author ? ` (${doctor})` : ''}</span>
          {r.appointmentId && <span>· ضمن زيارة</span>}
        </header>
        {r.title && <h4 className="mt-1 font-semibold">{r.title}</h4>}

        {r.type === 'vitals' ? (
          <dl className="mt-2 flex flex-wrap gap-2 text-sm">
            {r.vitals.systolicMmhg !== null && r.vitals.diastolicMmhg !== null && (
              <Chip label="الضغط" value={`${r.vitals.systolicMmhg}/${r.vitals.diastolicMmhg}`} unit="mmHg"
                flag={outOfRange('systolicMmhg', r.vitals.systolicMmhg) || outOfRange('diastolicMmhg', r.vitals.diastolicMmhg)} />
            )}
            {VITALS.filter((v) => v.key !== 'systolicMmhg' && v.key !== 'diastolicMmhg').map((v) => {
              const val = r.vitals[v.key];
              return val === null ? null : <Chip key={v.key} label={v.label} value={String(val)} unit={v.unit} flag={outOfRange(v.key, val)} />;
            })}
            {(r.vitals.systolicMmhg === null) !== (r.vitals.diastolicMmhg === null) && (
              <Chip label="الضغط" value={String(r.vitals.systolicMmhg ?? r.vitals.diastolicMmhg)} unit="mmHg" flag={false} />
            )}
          </dl>
        ) : r.type === 'attachment' && r.attachment ? (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
            {r.attachment.url && r.attachment.mime?.startsWith('image/') ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={r.attachment.url} alt={r.body ?? 'مرفق'} className="max-h-48 rounded border border-line" />
            ) : null}
            {r.attachment.url ? (
              <a href={r.attachment.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary underline">
                <ExternalLink className="h-4 w-4" aria-hidden="true" /> فتح الملف
              </a>
            ) : <span className="text-muted">الملف غير متاح الآن</span>}
            {r.attachment.bytes && <span className="text-xs text-muted">{(r.attachment.bytes / 1024 / 1024).toFixed(1)} م.ب</span>}
            {r.body && <p className="w-full whitespace-pre-wrap">{r.body}</p>}
          </div>
        ) : (
          r.body && <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed">{r.body}</p>
        )}

        {amendments.length > 0 && (
          <ul className="mt-2 space-y-1 border-s-2 border-warn/60 ps-3">
            {amendments.map((a) => (
              <li key={a.id} className="text-sm">
                <span className="text-xs font-medium text-warn">تصحيح · {formatDateTime(a.createdAt, tz)} · {a.author}</span>
                <p className="whitespace-pre-wrap">{a.body}</p>
              </li>
            ))}
          </ul>
        )}

        {canAmend && !amending && (
          <button type="button" onClick={() => setAmending(true)} className="mt-2 inline-flex items-center gap-1 text-xs text-muted hover:text-primary">
            <PenLine className="h-3 w-3" aria-hidden="true" /> إضافة تصحيح
          </button>
        )}
        {amending && (
          <div className="mt-2 space-y-2">
            <Textarea autoFocus aria-label="نص التصحيح" value={text} onChange={(e) => setText(e.target.value)} rows={2} maxLength={20000}
              placeholder="السجل الأصلي يبقى كما هو؛ يُضاف التصحيح تحته باسمك." />
            {error && <p className="text-xs text-danger">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setAmending(false)} disabled={busy}>إلغاء</Button>
              <Button size="sm" onClick={() => void amend()} disabled={busy || text.trim().length < 2}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <PenLine className="h-4 w-4" aria-hidden="true" />} حفظ التصحيح
              </Button>
            </div>
          </div>
        )}
      </article>
    </li>
  );
}

function Chip({ label, value, unit, flag }: { label: string; value: string; unit: string; flag: boolean }) {
  return (
    <div className={cn('rounded border px-2 py-1', flag ? 'border-warn/50 bg-warn/10' : 'border-line bg-surface')}>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={cn('lb-numeric font-semibold', flag && 'text-warn')}><span dir="ltr">{value}</span> <span className="text-xs font-normal text-muted" dir="ltr">{unit}</span></dd>
    </div>
  );
}
