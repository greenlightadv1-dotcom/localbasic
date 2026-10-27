'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarClock, Copy, Loader2, Plus, Save, Trash2, UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/field';
import { Alert } from '@/components/ui/alert';
import { Modal } from '@/components/ui/modal';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import type { ClinicWorkspace } from '@/modules/clinic/service';
import { WEEKDAYS_AR, hmToMinutes } from '@/modules/clinic/time';
import { saveDoctorAction, setShiftsAction } from './actions';
import { WEEK_ORDER, failure, type Scope } from './shared';

type Range = { key: string; weekday: number; startsAt: string; endsAt: string; roomId: string; slotMinutes: string };
let seq = 0;
const key = () => `r${++seq}`;

/**
 * Weekly working hours per doctor in this branch. Saving replaces the
 * doctor's whole week here (clinic_doctor_set_shifts); the database refuses
 * overlapping ranges, including against the doctor's shifts in other
 * branches (LB409). Also adds a doctor, who starts with the clinic's hours.
 */
export function ShiftsModal({ open, scope, workspace, onClose }: { open: boolean; scope: Scope; workspace: ClinicWorkspace; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [doctorId, setDoctorId] = useState(workspace.doctors[0]?.id ?? '');
  const [ranges, setRanges] = useState<Range[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(workspace.doctors.length === 0);
  const [draft, setDraft] = useState({ name: '', specialty: '', commission: '' });

  useEffect(() => {
    if (!open) return;
    setError(null);
    setRanges(workspace.shifts.filter((s) => s.doctorId === doctorId).map((s) => ({
      key: key(), weekday: s.weekday, startsAt: s.startsAt, endsAt: s.endsAt, roomId: s.roomId ?? '', slotMinutes: String(s.slotMinutes),
    })));
  }, [open, doctorId, workspace.shifts]);

  const problems = useMemo(() => {
    const out = new Map<string, string>();
    for (const r of ranges) {
      if (!/^\d{2}:\d{2}$/.test(r.startsAt) || !/^\d{2}:\d{2}$/.test(r.endsAt) || hmToMinutes(r.endsAt) <= hmToMinutes(r.startsAt)) {
        out.set(r.key, 'النهاية بعد البداية');
        continue;
      }
      const slot = Number(r.slotMinutes);
      if (!(slot >= 5 && slot <= 240)) out.set(r.key, 'مدة الخانة من 5 إلى 240 دقيقة');
      const clash = ranges.some((o) => o.key !== r.key && o.weekday === r.weekday
        && hmToMinutes(o.startsAt) < hmToMinutes(r.endsAt) && hmToMinutes(r.startsAt) < hmToMinutes(o.endsAt));
      if (clash) out.set(r.key, 'متداخلة مع فترة أخرى');
    }
    return out;
  }, [ranges]);

  function addRange(weekday: number) {
    const last = ranges.filter((r) => r.weekday === weekday).at(-1);
    setRanges((rs) => [...rs, {
      key: key(), weekday,
      startsAt: last ? last.endsAt : workspace.settings.opensAt,
      endsAt: last ? workspace.settings.closesAt : workspace.settings.closesAt,
      roomId: '', slotMinutes: String(workspace.settings.slotMinutes),
    }]);
  }

  function fillClinicHours() {
    setRanges(workspace.settings.workDays.map((d) => ({
      key: key(), weekday: d, startsAt: workspace.settings.opensAt, endsAt: workspace.settings.closesAt,
      roomId: '', slotMinutes: String(workspace.settings.slotMinutes),
    })));
  }

  async function save() {
    setBusy(true);
    setError(null);
    const r = await setShiftsAction(scope, {
      doctorId,
      shifts: ranges.map((x) => ({ weekday: x.weekday, startsAt: x.startsAt, endsAt: x.endsAt, roomId: x.roomId || null, slotMinutes: Number(x.slotMinutes) })),
    });
    setBusy(false);
    if (!r.ok) { setError(r.code === 'conflict' ? `${r.error} (قد تكون متداخلة مع مواعيده في فرع آخر).` : failure(r)); return; }
    toast.success(`حُفظت ${r.data.count} فترة عمل`);
    router.refresh();
  }

  async function addDoctor() {
    setBusy(true);
    setError(null);
    const pct = draft.commission.trim() === '' ? null : Number(draft.commission);
    const r = await saveDoctorAction(scope, {
      displayName: draft.name, specialty: draft.specialty || undefined,
      commissionMode: pct ? 'percent' : 'none', commissionPercent: pct, defaultShifts: true,
    });
    setBusy(false);
    if (!r.ok) { setError(failure(r)); return; }
    toast.success(`أضيف ${draft.name} بمواعيد العيادة الافتراضية`);
    setDraft({ name: '', specialty: '', commission: '' });
    setAdding(false);
    setDoctorId(r.data.id);
    router.refresh();
  }

  const doctor = workspace.doctors.find((d) => d.id === doctorId);
  const weekly = workspace.doctors.map((d) => ({
    d, days: WEEK_ORDER.map((w) => workspace.shifts.filter((s) => s.doctorId === d.id && s.weekday === w)),
  }));

  return (
    <Modal open={open} onClose={onClose} busy={busy} size="lg" icon={CalendarClock} title="مواعيد عمل الأطباء"
      description="الحجز يُقبل داخل هذه الفترات فقط عندما يكون فرض المواعيد مفعّلًا." testId="shifts-modal"
      footer={!adding && doctor ? <>
        <Button variant="outline" onClick={onClose} disabled={busy}>إغلاق</Button>
        <Button onClick={() => void save()} disabled={busy || problems.size > 0} data-testid="shifts-save">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Save className="h-4 w-4" aria-hidden="true" />} حفظ مواعيد {doctor.name}
        </Button>
      </> : undefined}>
      {error && <Alert tone="danger">{error}</Alert>}

      {/* Week overview */}
      {workspace.doctors.length > 0 && (
        <div className="overflow-x-auto rounded border border-line">
          <table className="w-full min-w-[40rem] table-fixed text-xs">
            <thead className="bg-surface text-muted">
              <tr><th className="w-28 px-2 py-1.5 text-start font-medium">الطبيب</th>{WEEK_ORDER.map((w) => <th key={w} className="px-1 py-1.5 text-start font-medium">{WEEKDAYS_AR[w]}</th>)}</tr>
            </thead>
            <tbody>
              {weekly.map(({ d, days }) => (
                <tr key={d.id} className={cn('cursor-pointer border-t border-line hover:bg-surface', d.id === doctorId && 'bg-primary-soft/50')}
                  onClick={() => { setDoctorId(d.id); setAdding(false); }}>
                  <th scope="row" className="truncate px-2 py-1.5 text-start font-medium">{d.name}</th>
                  {days.map((list, i) => (
                    <td key={i} className="px-1 py-1.5 lb-numeric">{list.length ? list.map((s) => `${s.startsAt}–${s.endsAt}`).join(' ') : <span className="text-muted">—</span>}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {adding ? (
        <div className="space-y-3 rounded border border-line p-3">
          <h3 className="flex items-center gap-2 text-sm font-semibold"><UserPlus className="h-4 w-4 text-primary" aria-hidden="true" /> طبيب جديد</h3>
          <div className="grid gap-2 sm:grid-cols-3">
            <Input autoFocus aria-label="اسم الطبيب" placeholder="الاسم (مثل د. أحمد)" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} maxLength={120} />
            <Input aria-label="التخصص" placeholder="التخصص" value={draft.specialty} onChange={(e) => setDraft({ ...draft, specialty: e.target.value })} maxLength={120} />
            <Input aria-label="نسبة العمولة" placeholder="عمولة % (اختياري)" value={draft.commission} onChange={(e) => setDraft({ ...draft, commission: e.target.value.replace(/[^\d.]/g, '') })} inputMode="decimal" dir="ltr" />
          </div>
          <p className="text-xs text-muted">يبدأ بمواعيد العيادة ({workspace.settings.opensAt}–{workspace.settings.closesAt}) في أيام العمل، وتعدّلها بعد الإضافة. لربط حساب دخول بالطبيب استخدم إدارة الأطباء.</p>
          <div className="flex justify-end gap-2">
            {workspace.doctors.length > 0 && <Button size="sm" variant="ghost" onClick={() => setAdding(false)} disabled={busy}>رجوع</Button>}
            <Button size="sm" onClick={() => void addDoctor()} disabled={busy || draft.name.trim().length < 2 || (draft.commission !== '' && !(Number(draft.commission) <= 100))}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <UserPlus className="h-4 w-4" aria-hidden="true" />} إضافة الطبيب
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Select aria-label="الطبيب" value={doctorId} onChange={(e) => setDoctorId(e.target.value)} className="w-auto">
              {workspace.doctors.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </Select>
            <Button size="sm" variant="outline" onClick={fillClinicHours}><Copy className="h-4 w-4" aria-hidden="true" /> مواعيد العيادة</Button>
            <Button size="sm" variant="ghost" onClick={() => setAdding(true)} className="ms-auto"><UserPlus className="h-4 w-4" aria-hidden="true" /> طبيب جديد</Button>
          </div>

          <ul className="space-y-2">
            {WEEK_ORDER.map((w) => {
              const list = ranges.filter((r) => r.weekday === w);
              return (
                <li key={w} className="rounded border border-line p-2">
                  <div className="flex items-center justify-between">
                    <span className={cn('text-sm font-medium', list.length === 0 && 'text-muted')}>{WEEKDAYS_AR[w]}{list.length === 0 && ' — إجازة'}</span>
                    <Button size="sm" variant="ghost" onClick={() => addRange(w)}><Plus className="h-4 w-4" aria-hidden="true" /> فترة</Button>
                  </div>
                  {list.map((r) => (
                    <div key={r.key} className="mt-2 flex flex-wrap items-center gap-2">
                      <Input type="time" aria-label="من" value={r.startsAt} dir="ltr" className="h-9 w-28" step={300}
                        onChange={(e) => setRanges((rs) => rs.map((x) => (x.key === r.key ? { ...x, startsAt: e.target.value } : x)))} />
                      <span className="text-xs text-muted">إلى</span>
                      <Input type="time" aria-label="إلى" value={r.endsAt} dir="ltr" className="h-9 w-28" step={300}
                        onChange={(e) => setRanges((rs) => rs.map((x) => (x.key === r.key ? { ...x, endsAt: e.target.value } : x)))} />
                      <Select aria-label="الغرفة" value={r.roomId} className="h-9 w-36"
                        onChange={(e) => setRanges((rs) => rs.map((x) => (x.key === r.key ? { ...x, roomId: e.target.value } : x)))}>
                        <option value="">بدون غرفة</option>
                        {workspace.rooms.map((room) => <option key={room.id} value={room.id}>{room.name}</option>)}
                      </Select>
                      <label className="flex items-center gap-1 text-xs text-muted">
                        خانة
                        <Input aria-label="مدة الخانة بالدقائق" value={r.slotMinutes} inputMode="numeric" dir="ltr" className="h-9 w-16 text-center"
                          onChange={(e) => setRanges((rs) => rs.map((x) => (x.key === r.key ? { ...x, slotMinutes: e.target.value.replace(/\D/g, '') } : x)))} />
                        د
                      </label>
                      <Button size="icon" variant="ghost" aria-label="حذف الفترة" onClick={() => setRanges((rs) => rs.filter((x) => x.key !== r.key))}><Trash2 className="h-4 w-4" /></Button>
                      {problems.get(r.key) && <span className="text-xs text-danger" role="alert">{problems.get(r.key)}</span>}
                    </div>
                  ))}
                </li>
              );
            })}
          </ul>
          {ranges.length === 0 && <Alert tone="warn">بدون أي فترة لن يقبل النظام حجز مواعيد لهذا الطبيب في هذا الفرع.</Alert>}
        </>
      )}
    </Modal>
  );
}
