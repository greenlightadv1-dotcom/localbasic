'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, CalendarPlus, Check, Loader2, Search, UserPlus, UserRound, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/field';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Modal } from '@/components/ui/modal';
import { useToast } from '@/components/ui/toast';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/cn';
import type { ClinicWorkspace, PatientHit, Slot } from '@/modules/clinic/service';
import { fromLocal, minutesToHm, toLocal, type LocalDate } from '@/modules/clinic/time';
import { availableSlotsAction, bookAppointmentAction, savePatientAction, searchPatientsAction } from './actions';
import { failure, type ClinicPermissions, type Scope } from './shared';

export type BookPrefill = { date: LocalDate; doctorId?: string; minutes?: number };
type Source = 'staff' | 'phone' | 'walk_in' | 'online';

/**
 * Booking: patient → doctor and procedures → a free slot → confirm.
 *
 * Free slots come from the database (the doctor's shifts minus active visits).
 * Two receptionists can still pick the same slot at once; the second booking
 * comes back `conflict` (LB409), the message is shown, the slot list reloads
 * and the taken slot disappears.
 */
export function BookModal({ scope, currency, workspace, prefill, permissions, onClose }: {
  scope: Scope; currency: string; workspace: ClinicWorkspace; prefill: BookPrefill; permissions: ClinicPermissions; onClose: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const tz = workspace.timezone;
  const money = (c: number) => formatMoney(c, currency);

  const [patient, setPatient] = useState<PatientHit | null>(null);
  const [doctorId, setDoctorId] = useState(prefill.doctorId ?? workspace.doctors[0]?.id ?? '');
  const [serviceIds, setServiceIds] = useState<string[]>([]);
  const [roomId, setRoomId] = useState('');
  const [date, setDate] = useState<LocalDate>(prefill.date);
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [slotsError, setSlotsError] = useState<string | null>(null);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [minutes, setMinutes] = useState<number | null>(prefill.minutes ?? null);
  const [manualTime, setManualTime] = useState('');
  const [source, setSource] = useState<Source>('staff');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<{ tone: 'danger' | 'warn'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const reload = useRef(0);

  const services = workspace.services.filter((s) => serviceIds.includes(s.id));
  const duration = services.reduce((s, x) => s + x.durationMinutes, 0) || workspace.settings.slotMinutes;
  const price = services.reduce((s, x) => s + x.priceCents, 0);

  async function loadSlots() {
    if (!doctorId || !date) return;
    const seq = ++reload.current;
    setSlotsLoading(true);
    setSlotsError(null);
    const r = await availableSlotsAction(scope, { doctorId, date });
    if (seq !== reload.current) return;
    setSlotsLoading(false);
    if (!r.ok) { setSlots([]); setSlotsError(failure(r)); return; }
    setSlots(r.data);
  }
  useEffect(() => { void loadSlots(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [doctorId, date]);

  const slotMinutes = useMemo(() => (slots ?? []).map((s) => ({ ...s, minutes: toLocal(s.startsAt, tz).minutes })), [slots, tz]);
  // A prefilled time that is no longer free (or never was) is dropped once the list arrives.
  useEffect(() => {
    if (slots && minutes !== null && !manualTime && !slotMinutes.some((s) => s.minutes === minutes)) setMinutes(null);
  }, [slots, slotMinutes, minutes, manualTime]);

  const manualMinutes = /^\d{2}:\d{2}$/.test(manualTime) ? Number(manualTime.slice(0, 2)) * 60 + Number(manualTime.slice(3)) : null;
  const chosen = manualMinutes ?? minutes;

  const blocker = !patient ? 'اختر المريض.' : !doctorId ? 'اختر الطبيب.' : chosen === null ? 'اختر موعدًا.' : null;

  async function submit() {
    if (blocker || chosen === null || !patient) return;
    setBusy(true);
    setError(null);
    const startsAt = fromLocal(date, chosen, tz).toISOString();
    const r = await bookAppointmentAction(scope, {
      patientId: patient.id, doctorId, startsAt, serviceIds, roomId: roomId || null,
      reason: reason.trim() || undefined, source,
    });
    setBusy(false);
    if (!r.ok) {
      if (r.code === 'conflict') {
        setError({ tone: 'warn', text: `${r.error} اختر موعدًا آخر؛ تم تحديث المواعيد المتاحة.` });
        toast.error(r.error);
        setMinutes(null);
        setManualTime('');
        void loadSlots();
        return;
      }
      setError({ tone: 'danger', text: failure(r) });
      return;
    }
    toast.success(`تم حجز ${patient.name} الساعة ${minutesToHm(chosen)}`);
    onClose();
    router.refresh();
  }

  const doctor = workspace.doctors.find((d) => d.id === doctorId);

  return (
    <Modal open onClose={onClose} busy={busy} size="lg" icon={CalendarPlus} title="حجز موعد" testId="book-modal"
      footer={<>
        <span className="me-auto text-sm text-muted">
          {chosen !== null && <>الموعد <span className="lb-numeric font-semibold text-fg">{minutesToHm(chosen)}</span> · {duration} دقيقة</>}
          {price > 0 && <> · <span className="lb-numeric">{money(price)}</span></>}
        </span>
        <Button variant="outline" onClick={onClose} disabled={busy}>إلغاء</Button>
        <Button onClick={() => void submit()} disabled={!!blocker || busy} data-testid="book-submit">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Check className="h-4 w-4" aria-hidden="true" />} تأكيد الحجز
        </Button>
      </>}>
      {error && <Alert tone={error.tone}>{error.text}</Alert>}

      <PatientPicker scope={scope} patient={patient} onPick={setPatient} canCreate={permissions.createPatient} canSearch={permissions.readPatients} />

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1.5 text-sm">
          <span className="font-medium">الطبيب</span>
          <Select value={doctorId} onChange={(e) => { setDoctorId(e.target.value); setMinutes(null); }} data-testid="book-doctor">
            {workspace.doctors.map((d) => <option key={d.id} value={d.id}>{d.name}{d.specialty ? ` — ${d.specialty}` : ''}</option>)}
          </Select>
        </label>
        <label className="space-y-1.5 text-sm">
          <span className="font-medium">اليوم</span>
          <Input type="date" value={date} onChange={(e) => { if (e.target.value) { setDate(e.target.value); setMinutes(null); } }} dir="ltr" />
        </label>
      </div>

      <fieldset className="space-y-1.5">
        <legend className="text-sm font-medium">الخدمات</legend>
        <div className="flex flex-wrap gap-2">
          {workspace.services.map((s) => {
            const on = serviceIds.includes(s.id);
            return (
              <button key={s.id} type="button" aria-pressed={on}
                onClick={() => setServiceIds((ids) => (on ? ids.filter((x) => x !== s.id) : [...ids, s.id]))}
                className={cn('rounded-full border px-3 py-1.5 text-sm transition-colors', on ? 'border-primary bg-primary text-primary-fg' : 'border-line bg-elevated hover:border-primary')}>
                {s.name} <span className={cn('text-xs', on ? 'opacity-80' : 'text-muted')}>· {s.durationMinutes}د · {money(s.priceCents)}</span>
              </button>
            );
          })}
        </div>
        {services.length === 0 && <p className="text-xs text-muted">بدون خدمة: مدة الموعد {workspace.settings.slotMinutes} دقيقة.</p>}
      </fieldset>

      <fieldset className="space-y-1.5">
        <legend className="flex items-center gap-2 text-sm font-medium">
          المواعيد المتاحة {doctor && <span className="text-muted">لـ {doctor.name}</span>}
          {slotsLoading && <Loader2 className="h-4 w-4 animate-spin text-muted" aria-label="جارٍ التحميل" />}
        </legend>
        {slotsError && <p className="text-xs text-danger">{slotsError}</p>}
        {slots && slots.length === 0 && !slotsLoading && (
          <p className="rounded border border-dashed border-line py-3 text-center text-sm text-muted">
            لا مواعيد متاحة لهذا الطبيب في هذا اليوم.
          </p>
        )}
        {slotMinutes.length > 0 && (
          <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-6" role="radiogroup" aria-label="المواعيد">
            {slotMinutes.map((s) => (
              <button key={s.startsAt} type="button" role="radio" aria-checked={minutes === s.minutes && !manualTime}
                onClick={() => { setMinutes(s.minutes); setManualTime(''); }}
                className={cn('rounded border py-1.5 text-sm lb-numeric transition-colors',
                  minutes === s.minutes && !manualTime ? 'border-primary bg-primary text-primary-fg' : 'border-line bg-elevated hover:border-primary')}>
                {minutesToHm(s.minutes)}
              </button>
            ))}
          </div>
        )}
        {duration > (slots?.[0] ? (Date.parse(slots[0].endsAt) - Date.parse(slots[0].startsAt)) / 60000 : duration) && (
          <p className="text-xs text-warn">مدة الخدمات ({duration} دقيقة) أطول من الخانة؛ قد تتعارض مع الموعد التالي.</p>
        )}
        <label className="flex flex-wrap items-center gap-2 pt-1 text-xs text-muted">
          أو وقت محدد
          <Input type="time" value={manualTime} onChange={(e) => setManualTime(e.target.value)} dir="ltr" className="h-8 w-32" step={300} />
          {workspace.settings.enforceShifts && <span>يجب أن يقع داخل مواعيد الطبيب.</span>}
        </label>
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1.5 text-sm">
          <span className="font-medium">الغرفة</span>
          <Select value={roomId} onChange={(e) => setRoomId(e.target.value)}>
            <option value="">حسب جدول الطبيب</option>
            {workspace.rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </Select>
        </label>
        <label className="space-y-1.5 text-sm">
          <span className="font-medium">مصدر الحجز</span>
          <Select value={source} onChange={(e) => setSource(e.target.value as Source)}>
            <option value="staff">الاستقبال</option>
            <option value="phone">هاتف</option>
            <option value="walk_in">حضور مباشر</option>
          </Select>
        </label>
      </div>

      <label className="block space-y-1.5 text-sm">
        <span className="font-medium">سبب الزيارة <span className="text-muted">(اختياري)</span></span>
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} rows={2} />
      </label>
    </Modal>
  );
}

function PatientPicker({ scope, patient, onPick, canCreate, canSearch }: {
  scope: Scope; patient: PatientHit | null; onPick: (p: PatientHit | null) => void; canCreate: boolean; canSearch: boolean;
}) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<PatientHit[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ fullName: '', phone: '', gender: '' as '' | 'male' | 'female', dateOfBirth: '' });
  const [saving, setSaving] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2 || !canSearch) { setHits(null); return; }
    const id = ++seq.current;
    setLoading(true);
    const t = setTimeout(async () => {
      const r = await searchPatientsAction(scope, { query: q });
      if (id !== seq.current) return;
      setLoading(false);
      if (!r.ok) { setError(failure(r)); setHits([]); return; }
      setError(null);
      setHits(r.data);
    }, 300);
    return () => clearTimeout(t);
  }, [query, scope, canSearch]);

  async function create() {
    setSaving(true);
    setError(null);
    const r = await savePatientAction(scope, {
      fullName: draft.fullName, phone: draft.phone || undefined,
      gender: draft.gender || undefined, dateOfBirth: draft.dateOfBirth || undefined,
    });
    setSaving(false);
    if (!r.ok) { setError(failure(r)); return; }
    onPick({ id: r.data.id, fileNumber: '', name: draft.fullName.trim(), phone: draft.phone || null, gender: draft.gender || null, dateOfBirth: draft.dateOfBirth || null, allergies: null });
    setCreating(false);
  }

  if (patient) {
    return (
      <div className="flex items-start justify-between gap-2 rounded border border-primary/30 bg-primary-soft/50 p-3" data-testid="book-patient">
        <div className="min-w-0 text-sm">
          <p className="flex items-center gap-1.5 font-semibold"><UserRound className="h-4 w-4 text-primary" aria-hidden="true" />{patient.name}
            {patient.fileNumber && <Badge>{patient.fileNumber}</Badge>}</p>
          {patient.phone && <p className="text-xs text-muted" dir="ltr">{patient.phone}</p>}
          {patient.allergies && <p className="mt-1 flex items-center gap-1 text-xs font-medium text-danger"><AlertTriangle className="h-3 w-3" aria-hidden="true" /> حساسية: {patient.allergies}</p>}
        </div>
        <Button size="icon" variant="ghost" aria-label="تغيير المريض" onClick={() => onPick(null)}><X className="h-4 w-4" /></Button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <span className="text-sm font-medium">المريض</span>
      {!creating ? (
        <>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute inset-y-0 start-3 my-auto h-4 w-4 text-muted" aria-hidden="true" />
              <Input autoFocus aria-label="بحث عن مريض" value={query} onChange={(e) => setQuery(e.target.value)}
                placeholder={canSearch ? 'الاسم أو رقم الهاتف أو رقم الملف' : 'البحث عن المرضى غير متاح لصلاحيتك'} disabled={!canSearch}
                className="ps-9" data-testid="book-patient-search" />
            </div>
            {canCreate && (
              <Button variant="outline" onClick={() => { setCreating(true); setDraft((d) => ({ ...d, fullName: /\d/.test(query) ? '' : query, phone: /\d{7,}/.test(query) ? query : '' })); }}>
                <UserPlus className="h-4 w-4" aria-hidden="true" /> مريض جديد
              </Button>
            )}
          </div>
          {loading && <p className="flex items-center gap-1 text-xs text-muted"><Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> جارٍ البحث…</p>}
          {error && <p className="text-xs text-danger">{error}</p>}
          {hits && hits.length === 0 && !loading && <p className="text-xs text-muted">لا نتائج{canCreate ? '؛ سجّله كمريض جديد.' : '.'}</p>}
          {hits && hits.length > 0 && (
            <ul className="max-h-52 divide-y divide-line overflow-y-auto rounded border border-line">
              {hits.map((h) => (
                <li key={h.id}>
                  <button type="button" onClick={() => onPick(h)} className="flex w-full items-center justify-between gap-2 px-3 py-2 text-start text-sm hover:bg-surface">
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{h.name}</span>
                      <span className="text-xs text-muted"><span className="lb-numeric">{h.fileNumber}</span>{h.phone ? <> · <span dir="ltr">{h.phone}</span></> : null}</span>
                    </span>
                    {h.allergies && <AlertTriangle className="h-4 w-4 shrink-0 text-danger" aria-label="حساسية" />}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <div className="space-y-2 rounded border border-line p-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <Input autoFocus aria-label="اسم المريض" placeholder="الاسم بالكامل" value={draft.fullName} onChange={(e) => setDraft({ ...draft, fullName: e.target.value })} maxLength={160} />
            <Input aria-label="الهاتف" placeholder="الهاتف" value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} inputMode="tel" dir="ltr" />
            <Select aria-label="النوع" value={draft.gender} onChange={(e) => setDraft({ ...draft, gender: e.target.value as '' | 'male' | 'female' })}>
              <option value="">النوع</option><option value="female">أنثى</option><option value="male">ذكر</option>
            </Select>
            <Input aria-label="تاريخ الميلاد" type="date" value={draft.dateOfBirth} onChange={(e) => setDraft({ ...draft, dateOfBirth: e.target.value })} dir="ltr" />
          </div>
          {error && <p className="text-xs text-danger">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setCreating(false)} disabled={saving}>رجوع</Button>
            <Button size="sm" onClick={() => void create()} disabled={saving || draft.fullName.trim().length < 2}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <UserPlus className="h-4 w-4" aria-hidden="true" />} تسجيل واختيار
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
