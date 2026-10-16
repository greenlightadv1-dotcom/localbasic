'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { BellRing, CalendarClock, Clock, UserPlus, Users } from 'lucide-react';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input, Select } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import type { FloorPlanTable, WaitlistEntry } from '@/modules/restaurant/floor/service';
import { estimateWaitAction, waitlistActAction, waitlistAddAction } from './actions';
import { minutesSince } from './floor-view';

type Scope = { organizationSlug: string; branchSlug: string };

const time = (iso: string) => new Date(iso).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });

/**
 * The hostess stand: walk-ins with a quoted wait (from this branch's own
 * table turn times and who is ahead), reservations with a time, table holds,
 * and seating. Seating and holds change the table's colour on the floor.
 */
export function WaitlistPanel({ scope, entries, seatedToday, tables }: {
  scope: Scope; entries: WaitlistEntry[]; seatedToday: number; tables: FloorPlanTable[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [form, setForm] = useState({ guestName: '', guestPhone: '', partySize: 2, kind: 'walk_in' as 'walk_in' | 'reservation', reservedFor: '', note: '' });
  const [estimate, setEstimate] = useState<number | null | undefined>(undefined);

  // Live quote while the hostess types the party size.
  useEffect(() => {
    if (form.kind !== 'walk_in' || !form.partySize) { setEstimate(undefined); return; }
    let live = true;
    const t = setTimeout(async () => {
      const r = await estimateWaitAction(scope, { partySize: form.partySize });
      if (live && r.ok) setEstimate(r.data.minutes);
    }, 300);
    return () => { live = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.partySize, form.kind, entries.length]);

  function add(e: React.FormEvent) {
    e.preventDefault();
    start(async () => {
      const r = await waitlistAddAction(scope, {
        guestName: form.guestName, guestPhone: form.guestPhone, partySize: form.partySize, kind: form.kind,
        reservedFor: form.kind === 'reservation' && form.reservedFor ? new Date(form.reservedFor).toISOString() : null,
        note: form.note || undefined,
      });
      if (!r.ok) { toast.error(r.error); return; }
      toast.success(form.kind === 'walk_in'
        ? (r.data.quotedMin === null ? 'أُضيف للقائمة' : r.data.quotedMin === 0 ? 'يوجد طاولة متاحة الآن' : `الانتظار المتوقع ${r.data.quotedMin} دقيقة`)
        : 'تم تسجيل الحجز');
      setForm({ ...form, guestName: '', guestPhone: '', note: '', reservedFor: '' });
      router.refresh();
    });
  }

  function act(entry: WaitlistEntry, action: 'assign' | 'notify' | 'seat' | 'cancel' | 'no_show', tableId?: string | null) {
    start(async () => {
      const r = await waitlistActAction(scope, { id: entry.id, action, tableId: tableId ?? null });
      if (!r.ok) { toast.error(r.error); return; }
      toast.success({ assign: 'تم حجز الطاولة', notify: 'تم تسجيل التنبيه', seat: 'تم الإجلاس', cancel: 'أُلغي', no_show: 'سُجّل عدم الحضور' }[action]);
      router.refresh();
    });
  }

  const sorted = [...entries].sort((a, b) => {
    const ka = a.kind === 'reservation' && a.reservedFor ? new Date(a.reservedFor).getTime() : new Date(a.createdAt).getTime();
    const kb = b.kind === 'reservation' && b.reservedFor ? new Date(b.reservedFor).getTime() : new Date(b.createdAt).getTime();
    return ka - kb;
  });

  return (
    <Card data-testid="waitlist">
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2"><Users className="h-5 w-5" aria-hidden="true" /> قائمة الانتظار</span>
          <span className="text-xs font-normal text-muted">أُجلس اليوم: <span className="lb-numeric">{seatedToday}</span></span>
        </CardTitle>
      </CardHeader>
      <CardBody className="space-y-4">
        <form onSubmit={add} className="space-y-2" aria-label="إضافة للقائمة">
          <div className="flex gap-1">
            {([['walk_in', 'حضور مباشر'], ['reservation', 'حجز']] as const).map(([k, label]) => (
              <button key={k} type="button" onClick={() => setForm({ ...form, kind: k })}
                className={cn('flex-1 rounded border px-2 py-1 text-xs', form.kind === k ? 'border-primary bg-primary-soft text-primary' : 'border-line')}>
                {label}
              </button>
            ))}
          </div>
          <Input aria-label="اسم الضيف" placeholder="اسم الضيف" value={form.guestName} onChange={(e) => setForm({ ...form, guestName: e.target.value })} maxLength={80} required data-testid="wl-name" />
          <div className="flex gap-2">
            <Input aria-label="الهاتف" placeholder="الهاتف" dir="ltr" inputMode="tel" value={form.guestPhone} onChange={(e) => setForm({ ...form, guestPhone: e.target.value })} maxLength={30} />
            <Input aria-label="عدد الأشخاص" type="number" min={1} max={50} dir="ltr" className="w-20 text-center" value={form.partySize}
              onChange={(e) => setForm({ ...form, partySize: Math.min(Math.max(Number(e.target.value) || 1, 1), 50) })} data-testid="wl-party" />
          </div>
          {form.kind === 'reservation' && (
            <Input aria-label="موعد الحجز" type="datetime-local" dir="ltr" value={form.reservedFor} onChange={(e) => setForm({ ...form, reservedFor: e.target.value })} required />
          )}
          {form.kind === 'walk_in' && estimate !== undefined && (
            <p className="flex items-center gap-1.5 text-xs" data-testid="wl-estimate">
              <Clock className="h-3.5 w-3.5 text-muted" aria-hidden="true" />
              {estimate === null ? 'لا توجد طاولة بهذا الحجم — اجمع طاولتين' : estimate === 0 ? 'يوجد طاولة متاحة الآن' : <>الانتظار المتوقع <strong className="lb-numeric">{estimate}</strong> دقيقة</>}
            </p>
          )}
          <Button type="submit" size="sm" block disabled={pending || !form.guestName.trim()} data-testid="wl-add">
            <UserPlus className="h-4 w-4" aria-hidden="true" /> إضافة
          </Button>
        </form>

        {sorted.length === 0 ? <p className="text-center text-sm text-muted">لا أحد ينتظر.</p> : (
          <ul className="space-y-2" data-testid="wl-entries">
            {sorted.map((e) => <Entry key={e.id} entry={e} tables={tables} pending={pending} act={act} />)}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

function Entry({ entry, tables, pending, act }: {
  entry: WaitlistEntry; tables: FloorPlanTable[]; pending: boolean;
  act: (e: WaitlistEntry, a: 'assign' | 'notify' | 'seat' | 'cancel' | 'no_show', t?: string | null) => void;
}) {
  const [tableId, setTableId] = useState(entry.tableId ?? '');
  const waited = minutesSince(entry.createdAt);
  const over = entry.kind === 'walk_in' && entry.quotedWaitMin !== null && waited > entry.quotedWaitMin;
  const fits = tables.filter((t) => !t.mergedInto && t.seats >= entry.partySize && (t.status === 'available' || t.id === entry.tableId || t.status === 'cleaning'));
  const others = tables.filter((t) => !t.mergedInto && !fits.includes(t) && (t.status === 'available' || t.status === 'cleaning'));
  const held = entry.tableId ? tables.find((t) => t.id === entry.tableId) : null;

  return (
    <li className={cn('rounded border p-2 text-sm', entry.status === 'notified' ? 'border-blue-400 bg-blue-50' : 'border-line')}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-semibold">{entry.guestName} <span className="lb-numeric text-muted">· {entry.partySize} أفراد</span></p>
          {entry.guestPhone && <p className="text-xs text-muted" dir="ltr">{entry.guestPhone}</p>}
        </div>
        {entry.kind === 'reservation' && entry.reservedFor ? (
          <Badge tone="info"><CalendarClock className="h-3 w-3" aria-hidden="true" /> {time(entry.reservedFor)}</Badge>
        ) : (
          <Badge tone={over ? 'danger' : 'neutral'}>
            <span className="lb-numeric">{waited}</span>{entry.quotedWaitMin !== null ? <> / <span className="lb-numeric">{entry.quotedWaitMin}</span></> : null} د
          </Badge>
        )}
      </div>
      {held && <p className="mt-1 text-xs">محجوز له: طاولة <bdi className="font-semibold">{held.name}</bdi></p>}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Select aria-label="الطاولة" className="h-8 w-28 text-xs" value={tableId} onChange={(e) => setTableId(e.target.value)}>
          <option value="">طاولة…</option>
          {fits.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.seats})</option>)}
          {others.length > 0 && <optgroup label="أصغر من اللازم">{others.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.seats})</option>)}</optgroup>}
        </Select>
        <Button size="sm" disabled={pending || !(tableId || entry.tableId)} onClick={() => act(entry, 'seat', tableId || null)} data-testid="wl-seat">إجلاس</Button>
        <Button size="sm" variant="outline" disabled={pending || !tableId || tableId === entry.tableId} onClick={() => act(entry, 'assign', tableId)}>حجز الطاولة</Button>
        {entry.status === 'waiting' && (
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => act(entry, 'notify')} aria-label="تم تنبيه الضيف">
            <BellRing className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        )}
        <Button size="sm" variant="ghost" className="text-danger" disabled={pending} onClick={() => act(entry, entry.kind === 'reservation' ? 'no_show' : 'cancel')}>
          {entry.kind === 'reservation' ? 'لم يحضر' : 'إلغاء'}
        </Button>
      </div>
    </li>
  );
}
