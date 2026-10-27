'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import {
  AlertTriangle, CalendarDays, CalendarPlus, ChevronLeft, ChevronRight, Clock, Loader2, Plus, Settings2,
  Stethoscope, UserCheck, Users,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/field';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/components/ui/toast';
import { EmptyState } from '@/components/patterns/states';
import { cn } from '@/lib/cn';
import type { AppointmentStatus, CalendarAppointment, ClinicWorkspace } from '@/modules/clinic/service';
import {
  WEEKDAYS_AR, addDays, hmToMinutes, minutesToHm, toLocal, weekdayOf, type LocalDate,
} from '@/modules/clinic/time';
import { setAppointmentStatusAction } from './actions';
import { ACTIVE, STATUS_META, failure, type ClinicPermissions, type Scope } from './shared';
import { BookModal, type BookPrefill } from './book-modal';
import { VisitModal } from './visit-modal';
import { ShiftsModal } from './shifts-modal';

const PX_PER_MIN = 1.6;

export function ClinicCalendar({
  scope, currency, workspace, view, date, rangeStart, today, doctorFilter, appointments, todaysAppointments, serverNow, permissions,
}: {
  scope: Scope;
  currency: string;
  workspace: ClinicWorkspace;
  view: 'day' | 'week';
  date: LocalDate;
  rangeStart: LocalDate;
  today: LocalDate;
  doctorFilter: string | null;
  appointments: CalendarAppointment[];
  todaysAppointments: CalendarAppointment[];
  serverNow: string;
  permissions: ClinicPermissions;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [navigating, startNav] = useTransition();
  const [booking, setBooking] = useState<BookPrefill | null>(null);
  const [visitId, setVisitId] = useState<string | null>(null);
  const [shiftsOpen, setShiftsOpen] = useState(false);
  // "Now" ticks on the client only, from the server's clock, so waiting times
  // and the red now-line move without a hydration mismatch.
  const [now, setNow] = useState(() => Date.parse(serverNow));
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);

  const tz = workspace.timezone;
  const isClinicBranch = workspace.branchModule === 'medical';
  const doctors = workspace.doctors.filter((d) => !doctorFilter || d.id === doctorFilter);
  const all = useMemo(() => {
    const map = new Map<string, CalendarAppointment>();
    for (const a of [...appointments, ...todaysAppointments]) map.set(a.id, a);
    return map;
  }, [appointments, todaysAppointments]);
  const visit = visitId ? all.get(visitId) ?? null : null;

  function go(next: { date?: LocalDate; view?: 'day' | 'week'; doctor?: string | null }) {
    const q = new URLSearchParams();
    q.set('date', next.date ?? date);
    q.set('view', next.view ?? view);
    const d = next.doctor === undefined ? doctorFilter : next.doctor;
    if (d) q.set('doctor', d);
    startNav(() => router.push(`${pathname}?${q.toString()}`));
  }
  const step = view === 'week' ? 7 : 1;
  const title = view === 'week'
    ? `${formatDate(rangeStart)} — ${formatDate(addDays(rangeStart, 6))}`
    : `${WEEKDAYS_AR[weekdayOf(date)]} ${formatDate(date)}`;

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="min-w-0 space-y-3">
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="me-auto flex items-center gap-2 text-xl font-bold">
            <CalendarDays className="h-5 w-5 text-primary" aria-hidden="true" /> مواعيد العيادة
            {navigating && <Loader2 className="h-4 w-4 animate-spin text-muted" aria-label="جارٍ التحميل" />}
          </h1>
          {permissions.manageShifts && (
            <Button variant="outline" onClick={() => setShiftsOpen(true)}><Settings2 className="h-4 w-4" aria-hidden="true" /> مواعيد الأطباء</Button>
          )}
          {permissions.book && isClinicBranch && workspace.doctors.length > 0 && (
            <Button onClick={() => setBooking({ date })} data-testid="book-open"><CalendarPlus className="h-4 w-4" aria-hidden="true" /> حجز موعد</Button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-elevated p-2">
          <div className="flex items-center gap-1">
            {/* RTL: "previous" points right. */}
            <Button size="icon" variant="ghost" aria-label="السابق" onClick={() => go({ date: addDays(date, -step) })}><ChevronRight className="h-5 w-5" /></Button>
            <Button size="sm" variant="outline" onClick={() => go({ date: today })} disabled={date === today}>اليوم</Button>
            <Button size="icon" variant="ghost" aria-label="التالي" onClick={() => go({ date: addDays(date, step) })}><ChevronLeft className="h-5 w-5" /></Button>
          </div>
          <span className="font-semibold">{title}</span>
          <div className="ms-auto flex flex-wrap items-center gap-2">
            <Select aria-label="الطبيب" value={doctorFilter ?? ''} onChange={(e) => go({ doctor: e.target.value || null })} className="h-9 w-auto">
              <option value="">كل الأطباء</option>
              {workspace.doctors.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </Select>
            <div className="flex overflow-hidden rounded border border-line text-sm" role="radiogroup" aria-label="العرض">
              {(['day', 'week'] as const).map((v) => (
                <button key={v} type="button" role="radio" aria-checked={view === v} onClick={() => go({ view: v })}
                  className={cn('px-3 py-1.5', view === v ? 'bg-primary text-primary-fg' : 'bg-elevated hover:bg-surface')}>
                  {v === 'day' ? 'يوم' : 'أسبوع'}
                </button>
              ))}
            </div>
          </div>
        </div>

        {!isClinicBranch && <Alert tone="warn">هذا الفرع لا يعمل في وضع العيادة؛ الحجز متوقف. غيّر نشاط الفرع من الإعدادات ← الفروع.</Alert>}

        {workspace.doctors.length === 0 ? (
          <div className="rounded-lg border border-line bg-elevated">
            <EmptyState icon={Stethoscope} title="لا يوجد أطباء بعد"
              description={permissions.manageShifts ? 'أضف طبيبًا وحدّد مواعيده لتظهر خانات الحجز.' : 'اطلب من المدير إضافة الأطباء ومواعيدهم.'}
              action={permissions.manageShifts ? { label: 'إضافة طبيب', onClick: () => setShiftsOpen(true) } : undefined} />
          </div>
        ) : view === 'day' ? (
          <DayGrid
            date={date} today={today} now={now} tz={tz} workspace={workspace} doctors={doctors}
            appointments={appointments} canBook={permissions.book && isClinicBranch}
            onSlot={(doctorId, minutes) => setBooking({ date, doctorId, minutes })}
            onOpen={setVisitId}
          />
        ) : (
          <WeekGrid
            rangeStart={rangeStart} today={today} tz={tz} workspace={workspace} doctors={doctors} appointments={appointments}
            onDay={(d) => go({ date: d, view: 'day' })} onOpen={setVisitId}
          />
        )}
      </div>

      <QueueSidebar
        scope={scope} tz={tz} now={now} workspace={workspace} items={todaysAppointments}
        permissions={permissions} onOpen={setVisitId}
      />

      {booking && (
        <BookModal
          scope={scope} currency={currency} workspace={workspace} prefill={booking} permissions={permissions}
          onClose={() => setBooking(null)}
        />
      )}
      {visit && (
        <VisitModal
          scope={scope} currency={currency} workspace={workspace} appointment={visit} permissions={permissions}
          onClose={() => setVisitId(null)}
        />
      )}
      {permissions.manageShifts && (
        <ShiftsModal open={shiftsOpen} scope={scope} workspace={workspace} onClose={() => setShiftsOpen(false)} />
      )}
    </div>
  );
}

function formatDate(d: LocalDate) {
  const [y, m, day] = d.split('-').map(Number) as [number, number, number];
  return new Intl.DateTimeFormat('ar-EG', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, day)))
    + (y !== new Date().getUTCFullYear() ? ` ${y}` : '');
}

function hhmm(minutes: number) {
  return new Intl.NumberFormat('ar-EG', { minimumIntegerDigits: 2 }).format(Math.floor(minutes / 60))
    + ':' + new Intl.NumberFormat('ar-EG', { minimumIntegerDigits: 2 }).format(minutes % 60);
}

// ---------------------------------------------------------------------------
// Day: doctors side by side on one time axis
// ---------------------------------------------------------------------------
function DayGrid({
  date, today, now, tz, workspace, doctors, appointments, canBook, onSlot, onOpen,
}: {
  date: LocalDate; today: LocalDate; now: number; tz: string; workspace: ClinicWorkspace;
  doctors: ClinicWorkspace['doctors']; appointments: CalendarAppointment[]; canBook: boolean;
  onSlot: (doctorId: string, minutes: number) => void; onOpen: (id: string) => void;
}) {
  const weekday = weekdayOf(date);
  const dayAppts = appointments
    .filter((a) => toLocal(a.startsAt, tz).date === date)
    .map((a) => ({ a, start: toLocal(a.startsAt, tz).minutes, end: toLocal(a.endsAt, tz).minutes || 24 * 60 }));
  const shifts = workspace.shifts.filter((s) => s.weekday === weekday);

  // The axis spans clinic hours, every shift and every visit on the day.
  let lo = hmToMinutes(workspace.settings.opensAt);
  let hi = hmToMinutes(workspace.settings.closesAt);
  for (const s of shifts) { lo = Math.min(lo, hmToMinutes(s.startsAt)); hi = Math.max(hi, hmToMinutes(s.endsAt)); }
  for (const { start, end } of dayAppts) { lo = Math.min(lo, start); hi = Math.max(hi, end); }
  lo = Math.floor(lo / 60) * 60;
  hi = Math.ceil(hi / 60) * 60;
  const height = (hi - lo) * PX_PER_MIN;
  const nowLocal = date === today ? toLocal(new Date(now), tz).minutes : null;
  const hours = Array.from({ length: (hi - lo) / 60 }, (_, i) => lo + i * 60);

  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-elevated" data-testid="day-grid">
      <div className="grid" style={{ gridTemplateColumns: `3.5rem repeat(${doctors.length}, minmax(10rem, 1fr))`, minWidth: `${3.5 + doctors.length * 10}rem` }}>
        {/* Header */}
        <div className="sticky top-0 z-20 border-b border-line bg-surface" />
        {doctors.map((d) => {
          const own = shifts.filter((s) => s.doctorId === d.id);
          return (
            <div key={d.id} className="sticky top-0 z-20 border-b border-s border-line bg-surface px-2 py-2">
              <p className="flex items-center gap-1.5 truncate text-sm font-semibold">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: d.color ?? 'var(--color-primary)' }} aria-hidden="true" />
                {d.name}{d.isMe && <Badge tone="info">أنا</Badge>}
              </p>
              <p className="truncate text-xs text-muted">
                {own.length ? own.map((s) => `${s.startsAt}–${s.endsAt}`).join(' · ') : 'لا يعمل اليوم'}
              </p>
            </div>
          );
        })}

        {/* Time gutter */}
        <div className="relative" style={{ height }}>
          {hours.map((h) => (
            <span key={h} className="absolute end-1 -translate-y-1/2 text-[11px] text-muted lb-numeric" style={{ top: (h - lo) * PX_PER_MIN }}>{hhmm(h)}</span>
          ))}
        </div>

        {/* Doctor columns */}
        {doctors.map((d) => {
          const own = shifts.filter((s) => s.doctorId === d.id);
          const mine = dayAppts.filter(({ a }) => a.doctorId === d.id && ACTIVE.concat('completed').includes(a.status));
          const taken = mine.filter(({ a }) => ACTIVE.includes(a.status));
          const free: { start: number; len: number }[] = [];
          if (canBook) {
            for (const s of own) {
              for (let t = hmToMinutes(s.startsAt); t + s.slotMinutes <= hmToMinutes(s.endsAt); t += s.slotMinutes) {
                const clash = taken.some(({ start, end }) => start < t + s.slotMinutes && t < end);
                const past = nowLocal !== null && t < nowLocal;
                const pastDay = date < today;
                if (!clash && !past && !pastDay) free.push({ start: t, len: s.slotMinutes });
              }
            }
          }
          return (
            <div key={d.id} className="relative border-s border-line bg-[repeating-linear-gradient(135deg,transparent,transparent_6px,rgb(0_0_0/0.03)_6px,rgb(0_0_0/0.03)_12px)]" style={{ height }}>
              {hours.map((h) => <div key={h} className="absolute inset-x-0 border-t border-line/60" style={{ top: (h - lo) * PX_PER_MIN }} aria-hidden="true" />)}
              {own.map((s) => (
                <div key={s.id} className="absolute inset-x-0 bg-elevated" aria-hidden="true"
                  style={{ top: (hmToMinutes(s.startsAt) - lo) * PX_PER_MIN, height: (hmToMinutes(s.endsAt) - hmToMinutes(s.startsAt)) * PX_PER_MIN }} />
              ))}
              {free.map((f) => (
                <button key={f.start} type="button" onClick={() => onSlot(d.id, f.start)}
                  aria-label={`حجز ${d.name} الساعة ${minutesToHm(f.start)}`}
                  className="group absolute inset-x-1 flex items-center justify-center rounded text-xs text-transparent hover:bg-primary-soft hover:text-primary focus-visible:bg-primary-soft focus-visible:text-primary"
                  style={{ top: (f.start - lo) * PX_PER_MIN + 1, height: f.len * PX_PER_MIN - 2 }}>
                  <Plus className="h-3 w-3" aria-hidden="true" /> {minutesToHm(f.start)}
                </button>
              ))}
              {mine.map(({ a, start, end }) => (
                <button key={a.id} type="button" onClick={() => onOpen(a.id)}
                  className={cn('absolute inset-x-1 z-10 overflow-hidden rounded border px-2 py-1 text-start text-xs shadow-sm', STATUS_META[a.status].block)}
                  style={{ top: (start - lo) * PX_PER_MIN + 1, height: Math.max((end - start) * PX_PER_MIN - 2, 22) }}
                  data-testid="appointment-block">
                  <span className="flex items-center justify-between gap-1 font-semibold">
                    <span className="truncate text-fg">{a.patient.name}</span>
                    <span className="lb-numeric shrink-0">{minutesToHm(start)}</span>
                  </span>
                  <span className="block truncate">{a.services.map((s) => s.name).join('، ') || a.reason || STATUS_META[a.status].label}</span>
                  {a.patient.allergies && <AlertTriangle className="absolute bottom-1 end-1 h-3 w-3 text-danger" aria-label="حساسية" />}
                </button>
              ))}
              {nowLocal !== null && nowLocal >= lo && nowLocal <= hi && (
                <div className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-danger" style={{ top: (nowLocal - lo) * PX_PER_MIN }} aria-hidden="true" />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Week: doctors × days
// ---------------------------------------------------------------------------
function WeekGrid({ rangeStart, today, tz, workspace, doctors, appointments, onDay, onOpen }: {
  rangeStart: LocalDate; today: LocalDate; tz: string; workspace: ClinicWorkspace; doctors: ClinicWorkspace['doctors'];
  appointments: CalendarAppointment[]; onDay: (d: LocalDate) => void; onOpen: (id: string) => void;
}) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(rangeStart, i));
  const byCell = new Map<string, CalendarAppointment[]>();
  for (const a of appointments) {
    if (a.status === 'cancelled') continue;
    const key = `${a.doctorId}|${toLocal(a.startsAt, tz).date}`;
    byCell.set(key, [...(byCell.get(key) ?? []), a]);
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-elevated" data-testid="week-grid">
      <table className="w-full min-w-[56rem] table-fixed text-sm">
        <thead>
          <tr className="bg-surface text-xs">
            <th className="w-40 px-3 py-2 text-start font-medium text-muted">الطبيب</th>
            {days.map((d) => (
              <th key={d} className={cn('px-2 py-2 text-start font-medium', d === today && 'text-primary')}>
                <button type="button" onClick={() => onDay(d)} className="hover:underline">
                  {WEEKDAYS_AR[weekdayOf(d)]} <span className="text-muted">{formatDate(d)}</span>
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {doctors.map((doc) => (
            <tr key={doc.id} className="border-t border-line align-top">
              <th scope="row" className="px-3 py-2 text-start font-medium">{doc.name}</th>
              {days.map((d) => {
                const shifts = workspace.shifts.filter((s) => s.doctorId === doc.id && s.weekday === weekdayOf(d));
                const items = (byCell.get(`${doc.id}|${d}`) ?? []).sort((x, y) => x.startsAt.localeCompare(y.startsAt));
                return (
                  <td key={d} className={cn('px-2 py-2', shifts.length === 0 && 'bg-surface/60')}>
                    <button type="button" onClick={() => onDay(d)} className="mb-1 block text-xs text-muted hover:text-primary">
                      {shifts.length ? shifts.map((s) => `${s.startsAt}–${s.endsAt}`).join(' · ') : 'إجازة'}
                    </button>
                    <ul className="space-y-1">
                      {items.slice(0, 4).map((a) => (
                        <li key={a.id}>
                          <button type="button" onClick={() => onOpen(a.id)}
                            className={cn('w-full truncate rounded border px-1.5 py-0.5 text-start text-xs', STATUS_META[a.status].block)}>
                            <span className="lb-numeric">{minutesToHm(toLocal(a.startsAt, tz).minutes)}</span> {a.patient.name}
                          </button>
                        </li>
                      ))}
                      {items.length > 4 && <li><button type="button" onClick={() => onDay(d)} className="text-xs text-primary">+{items.length - 4} أخرى</button></li>}
                    </ul>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Today's waiting room
// ---------------------------------------------------------------------------
function QueueSidebar({ scope, tz, now, workspace, items, permissions, onOpen }: {
  scope: Scope; tz: string; now: number; workspace: ClinicWorkspace; items: CalendarAppointment[];
  permissions: ClinicPermissions; onOpen: (id: string) => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const doctorName = new Map(workspace.doctors.map((d) => [d.id, d.name]));

  const waiting = items.filter((a) => a.status === 'checked_in').sort((x, y) => (x.checkedInAt ?? '').localeCompare(y.checkedInAt ?? ''));
  const inSession = items.filter((a) => a.status === 'in_session');
  const upcoming = items.filter((a) => a.status === 'booked').sort((x, y) => x.startsAt.localeCompare(y.startsAt));
  const done = items.filter((a) => ['completed', 'cancelled', 'no_show'].includes(a.status));
  const unpaid = items.filter((a) => a.invoice && a.invoice.totalCents > a.invoice.paidCents).length;

  async function move(a: CalendarAppointment, status: AppointmentStatus) {
    setBusy(a.id);
    const r = await setAppointmentStatusAction(scope, { appointmentId: a.id, status });
    setBusy(null);
    if (!r.ok) { toast.error(failure(r)); return; }
    toast.success(`${a.patient.name}: ${STATUS_META[status].label}`);
    router.refresh();
  }

  function row(a: CalendarAppointment) {
    const start = toLocal(a.startsAt, tz).minutes;
    const waited = a.checkedInAt ? Math.max(Math.round((now - Date.parse(a.checkedInAt)) / 60000), 0) : null;
    const canStart = a.status === 'checked_in' && permissions.clinical;
    const canFinish = a.status === 'in_session' && permissions.clinical;
    const canArrive = a.status === 'booked' && permissions.book;
    return (
      <li key={a.id} className="rounded border border-line bg-elevated p-2">
        <button type="button" onClick={() => onOpen(a.id)} className="block w-full text-start">
          <span className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-medium">{a.patient.name}</span>
            <span className="lb-numeric text-xs text-muted">{minutesToHm(start)}</span>
          </span>
          <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted">
            <span>{doctorName.get(a.doctorId) ?? ''}</span>
            {waited !== null && a.status === 'checked_in' && (
              <span className={cn('flex items-center gap-0.5', waited >= 30 ? 'text-danger' : waited >= 15 ? 'text-warn' : '')}>
                <Clock className="h-3 w-3" aria-hidden="true" /> ينتظر {waited} د
              </span>
            )}
            {a.patient.allergies && <span className="flex items-center gap-0.5 text-danger"><AlertTriangle className="h-3 w-3" aria-hidden="true" /> حساسية</span>}
          </span>
        </button>
        {(canArrive || canStart || canFinish) && (
          <div className="mt-2 flex gap-1">
            {canArrive && <Button size="sm" variant="secondary" disabled={busy === a.id} onClick={() => void move(a, 'checked_in')}><UserCheck className="h-4 w-4" aria-hidden="true" /> وصل</Button>}
            {canStart && <Button size="sm" disabled={busy === a.id} onClick={() => void move(a, 'in_session')}><Stethoscope className="h-4 w-4" aria-hidden="true" /> بدء الكشف</Button>}
            {canFinish && <Button size="sm" variant="secondary" disabled={busy === a.id} onClick={() => onOpen(a.id)}>إنهاء ومحاسبة</Button>}
            {busy === a.id && <Loader2 className="my-auto h-4 w-4 animate-spin text-muted" aria-hidden="true" />}
          </div>
        )}
      </li>
    );
  }

  return (
    <aside className="space-y-3 xl:sticky xl:top-20 xl:max-h-[calc(100dvh-6rem)] xl:overflow-y-auto" aria-label="طابور اليوم">
      <div className="rounded-lg border border-line bg-elevated p-3">
        <h2 className="flex items-center gap-2 font-semibold"><Users className="h-5 w-5 text-primary" aria-hidden="true" /> طابور اليوم</h2>
        <dl className="mt-2 grid grid-cols-4 gap-1 text-center text-xs">
          {[['انتظار', waiting.length, 'text-warn'], ['في الكشف', inSession.length, 'text-success'], ['قادم', upcoming.length, 'text-primary'], ['انتهى', done.filter((a) => a.status === 'completed').length, 'text-muted']].map(([l, n, c]) => (
            <div key={l as string} className="rounded bg-surface py-1.5">
              <dd className={cn('lb-numeric text-lg font-bold', c as string)}>{n as number}</dd>
              <dt className="text-muted">{l as string}</dt>
            </div>
          ))}
        </dl>
        {permissions.billing && unpaid > 0 && <p className="mt-2 text-xs text-warn">{unpaid} زيارة عليها مبالغ غير محصّلة.</p>}
      </div>

      <QueueGroup title="في الانتظار" empty="لا أحد في الانتظار">{waiting.map(row)}</QueueGroup>
      <QueueGroup title="في الكشف" empty="لا توجد زيارة جارية">{inSession.map(row)}</QueueGroup>
      <QueueGroup title="القادمون اليوم" empty="لا مواعيد أخرى اليوم">{upcoming.map(row)}</QueueGroup>
      {done.length > 0 && (
        <details className="rounded-lg border border-line bg-elevated p-3">
          <summary className="cursor-pointer text-sm font-semibold">المنتهية والملغاة ({done.length})</summary>
          <ul className="mt-2 space-y-1">
            {done.map((a) => (
              <li key={a.id}>
                <button type="button" onClick={() => onOpen(a.id)} className="flex w-full items-center justify-between gap-2 rounded px-1 py-1 text-start text-sm hover:bg-surface">
                  <span className="truncate">{a.patient.name}</span>
                  <span className="flex items-center gap-1">
                    {a.invoice && a.invoice.totalCents > a.invoice.paidCents && <Badge tone="warn">غير محصّل</Badge>}
                    <Badge tone={STATUS_META[a.status].tone}>{STATUS_META[a.status].label}</Badge>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </aside>
  );
}

function QueueGroup({ title, empty, children }: { title: string; empty: string; children: React.ReactNode[] }) {
  return (
    <section className="space-y-2" aria-label={title}>
      <h3 className="text-xs font-semibold text-muted">{title} {children.length > 0 && <span className="lb-numeric">({children.length})</span>}</h3>
      {children.length ? <ul className="space-y-2">{children}</ul> : <p className="rounded border border-dashed border-line py-3 text-center text-xs text-muted">{empty}</p>}
    </section>
  );
}
