'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { AlertTriangle, ArrowRight, FileHeart, Loader2, Search, Stethoscope, Users } from 'lucide-react';
import { Input } from '@/components/ui/field';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/patterns/states';
import { cn } from '@/lib/cn';
import type { CalendarAppointment, ClinicWorkspace, PatientChart, PatientHit } from '@/modules/clinic/service';
import { minutesToHm, toLocal } from '@/modules/clinic/time';
import { searchPatientsAction } from '../clinic-appointments/actions';
import { STATUS_META } from '../clinic-appointments/shared';
import { PatientHeader } from './patient-header';
import { VisitPanel } from './visit-panel';
import { RecordsTimeline } from './records-timeline';
import { VitalsHistory } from './vitals-history';
import { PrescriptionsPanel } from './prescriptions-panel';
import { failure, type EmrPermissions, type Scope } from './shared';

export function EmrWorkspace({
  scope, organizationId, currency, workspace, chart, requestedPatientId, todays, permissions,
}: {
  scope: Scope;
  organizationId: string;
  currency: string;
  workspace: ClinicWorkspace;
  chart: PatientChart | null;
  requestedPatientId: string | null;
  todays: CalendarAppointment[];
  permissions: EmrPermissions;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [opening, startOpen] = useTransition();
  const open = (id: string | null) => startOpen(() => router.push(id ? `${pathname}?patient=${id}` : pathname));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="flex items-center gap-2 text-xl font-bold">
          <FileHeart className="h-5 w-5 text-primary" aria-hidden="true" /> الملف الطبي
          {opening && <Loader2 className="h-4 w-4 animate-spin text-muted" aria-label="جارٍ الفتح" />}
        </h1>
        {chart && (
          <Button size="sm" variant="ghost" onClick={() => open(null)}>
            <ArrowRight className="h-4 w-4" aria-hidden="true" /> مرضى اليوم
          </Button>
        )}
        <div className="ms-auto w-full sm:w-96">
          <PatientSearch scope={scope} enabled={permissions.searchPatients} onPick={(p) => open(p.id)} />
        </div>
      </div>

      {requestedPatientId && !chart && (
        <Alert tone="warn">لا يوجد ملف لهذا المريض في المؤسسة.</Alert>
      )}

      {!chart ? (
        <TodayList tz={workspace.timezone} workspace={workspace} items={todays} onOpen={open} />
      ) : (
        <div className="space-y-4" key={chart.patient.id}>
          <PatientHeader scope={scope} chart={chart} canEdit={permissions.editPatient} tz={workspace.timezone} />
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_400px]">
            <div className="min-w-0 space-y-4">
              <VisitPanel scope={scope} organizationId={organizationId} currency={currency} workspace={workspace} chart={chart} permissions={permissions} />
              <RecordsTimeline scope={scope} organizationId={organizationId} workspace={workspace} chart={chart} permissions={permissions} />
            </div>
            <div className="min-w-0 space-y-4">
              <VitalsHistory chart={chart} tz={workspace.timezone} />
              <PrescriptionsPanel scope={scope} workspace={workspace} chart={chart} permissions={permissions} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PatientSearch({ scope, enabled, onPick }: { scope: Scope; enabled: boolean; onPick: (p: PatientHit) => void }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<PatientHit[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const term = q.trim();
    if (!enabled || term.length < 2) { setHits(null); setError(null); return; }
    const id = ++seq.current;
    setLoading(true);
    const t = setTimeout(async () => {
      const r = await searchPatientsAction(scope, { query: term });
      if (id !== seq.current) return;
      setLoading(false);
      if (!r.ok) { setError(failure(r)); setHits([]); return; }
      setError(null);
      setHits(r.data);
    }, 300);
    return () => clearTimeout(t);
  }, [q, scope, enabled]);

  return (
    <div className="relative">
      <Search className="pointer-events-none absolute inset-y-0 start-3 my-auto h-4 w-4 text-muted" aria-hidden="true" />
      <Input
        aria-label="بحث عن مريض"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setTimeout(() => setFocused(false), 150)}
        placeholder={enabled ? 'الاسم أو الهاتف أو رقم الملف' : 'البحث غير متاح لصلاحيتك'}
        disabled={!enabled}
        className="ps-9"
        data-testid="emr-search"
      />
      {loading && <Loader2 className="absolute inset-y-0 end-3 my-auto h-4 w-4 animate-spin text-muted" aria-hidden="true" />}
      {focused && (hits || error) && (
        <div className="absolute inset-x-0 top-full z-30 mt-1 max-h-80 overflow-y-auto rounded-lg border border-line bg-elevated shadow-lg">
          {error && <p className="p-3 text-sm text-danger">{error}</p>}
          {hits && hits.length === 0 && !error && <p className="p-3 text-sm text-muted">لا نتائج.</p>}
          {hits?.map((h) => (
            <button key={h.id} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => { onPick(h); setQ(''); setHits(null); }}
              className="flex w-full items-center justify-between gap-2 border-b border-line px-3 py-2 text-start text-sm last:border-0 hover:bg-surface">
              <span className="min-w-0">
                <span className="block truncate font-medium">{h.name}</span>
                <span className="text-xs text-muted"><span className="lb-numeric">{h.fileNumber}</span>{h.phone && <> · <span dir="ltr">{h.phone}</span></>}</span>
              </span>
              {h.allergies && <AlertTriangle className="h-4 w-4 shrink-0 text-danger" aria-label="حساسية" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function TodayList({ tz, workspace, items, onOpen }: {
  tz: string; workspace: ClinicWorkspace; items: CalendarAppointment[]; onOpen: (id: string) => void;
}) {
  const doctorName = new Map(workspace.doctors.map((d) => [d.id, d.name]));
  const order: Record<string, number> = { in_session: 0, checked_in: 1, booked: 2, completed: 3, no_show: 4, cancelled: 5 };
  const sorted = [...items]
    .filter((a) => workspace.myDoctorId === null || a.doctorId === workspace.myDoctorId || !workspace.doctors.some((d) => d.isMe))
    .sort((a, b) => (order[a.status]! - order[b.status]!) || a.startsAt.localeCompare(b.startsAt));

  if (sorted.length === 0) {
    return (
      <div className="rounded-lg border border-line bg-elevated">
        <EmptyState icon={Users} title="لا مرضى اليوم" description="ابحث عن مريض بالاسم أو الهاتف أو رقم الملف لفتح ملفه." />
      </div>
    );
  }
  return (
    <section className="space-y-2" aria-label="مرضى اليوم">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-muted">
        <Stethoscope className="h-4 w-4" aria-hidden="true" /> مرضى اليوم{workspace.myDoctorId ? ' — مواعيدي' : ''}
      </h2>
      <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {sorted.map((a) => (
          <li key={a.id}>
            <button type="button" onClick={() => onOpen(a.patient.id)}
              className={cn('flex w-full flex-col gap-1 rounded-lg border bg-elevated p-3 text-start transition-colors hover:border-primary',
                a.status === 'in_session' ? 'border-success/60' : a.status === 'checked_in' ? 'border-warn/60' : 'border-line')}>
              <span className="flex items-center justify-between gap-2">
                <span className="truncate font-medium">{a.patient.name}</span>
                <Badge tone={STATUS_META[a.status].tone}>{STATUS_META[a.status].label}</Badge>
              </span>
              <span className="text-xs text-muted">
                <span className="lb-numeric">{minutesToHm(toLocal(a.startsAt, tz).minutes)}</span> · {doctorName.get(a.doctorId) ?? ''}
                {a.reason ? ` · ${a.reason}` : ''}
              </span>
              {a.patient.allergies && <span className="flex items-center gap-1 text-xs text-danger"><AlertTriangle className="h-3 w-3" aria-hidden="true" /> {a.patient.allergies}</span>}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
