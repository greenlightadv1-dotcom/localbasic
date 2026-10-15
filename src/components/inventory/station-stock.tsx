'use client';

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { AlertTriangle, ChevronDown, PackageCheck, Send, Trash2 } from 'lucide-react';
import { Card, CardBody } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input, Select } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { LinesEditor, newLine, toBaseLines, defaultInputUnit, type DraftLine } from '@/components/inventory/lines-editor';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';
import { formatQty, INPUT_UNITS, LOCATION_LABELS, toBase, WASTE_REASONS, type InputUnit } from '@/modules/restaurant/inventory/units';
import type { StationView } from '@/modules/restaurant/inventory/service';
import {
  ackAlertAction, createRequestAction, receiveAction, recordWasteAction, stationViewAction,
} from '@/app/(app)/[orgSlug]/[branchSlug]/stock/actions';

type Scope = { organizationSlug: string; branchSlug: string };

/** A short two-tone chime; silent where the browser blocks audio until a tap. */
function chime() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    [880, 660].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.15, ctx.currentTime + i * 0.25);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.25 + 0.22);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + i * 0.25);
      osc.stop(ctx.currentTime + i * 0.25 + 0.25);
    });
    setTimeout(() => void ctx.close(), 1000);
  } catch {
    /* audio is a nicety */
  }
}

/**
 * The kitchen's or bar's own stock, on its own screen: low-stock alarms the
 * moment they open, deliveries from the warehouse waiting for a blind count,
 * a one-tap replenishment request, and waste. Everything here is scoped to
 * this station by the database — the panel only chooses what to show.
 */
export function StationStock({
  scope, branchId, initial, can,
}: {
  scope: Scope;
  branchId: string;
  initial: StationView;
  can: { receive: boolean; request: boolean; waste: boolean };
}) {
  const toast = useToast();
  const [view, setView] = useState(initial);
  const [open, setOpen] = useState(initial.incoming.length > 0 || initial.alerts.length > 0);
  const [section, setSection] = useState<'levels' | 'request' | 'waste'>('levels');
  const known = useRef(new Set(initial.alerts.map((a) => a.id)));
  const kind = initial.kind;

  const reload = useCallback(async () => {
    const r = await stationViewAction(scope, { kind });
    if (!r.ok) return;
    const fresh = r.data;
    const newAlerts = fresh.alerts.filter((a) => !known.current.has(a.id));
    const newIncoming = fresh.incoming.length > view.incoming.length;
    if (newAlerts.length > 0 || newIncoming) {
      chime();
      setOpen(true);
    }
    for (const a of newAlerts) {
      const item = fresh.items.find((i) => i.id === a.itemId);
      toast.error(`${a.kind === 'out' ? 'نفد' : 'قارب على النفاد'}: ${item?.name ?? ''}`);
    }
    known.current = new Set(fresh.alerts.map((a) => a.id));
    setView(fresh);
  }, [scope, kind, toast, view.incoming.length]);

  const reloadRef = useRef(reload);
  reloadRef.current = reload;

  useEffect(() => { setView(initial); }, [initial]);

  // Realtime for the instant alarm, a minute poll as the backstop.
  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const nudge = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void reloadRef.current(), 300);
    };
    const channel = supabase.channel(`station-stock-${kind}-${branchId}`);
    for (const table of ['inventory_alerts', 'inventory_transfers', 'inventory_requests']) {
      channel.on('postgres_changes' as never, { event: '*', schema: 'public', table, filter: `branch_id=eq.${branchId}` } as never, nudge);
    }
    channel.subscribe();
    const poll = setInterval(nudge, 60_000);
    return () => { if (timer) clearTimeout(timer); clearInterval(poll); void supabase.removeChannel(channel); };
  }, [branchId, kind]);

  const outCount = view.alerts.filter((a) => a.kind === 'out').length;
  const hasStock = view.items.length > 0;
  if (!hasStock && view.incoming.length === 0) return null;

  return (
    <Card className={view.alerts.length > 0 ? 'border-danger/50' : ''} data-testid="station-stock">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full flex-wrap items-center justify-between gap-2 p-3 text-start"
      >
        <span className="flex items-center gap-2 font-bold">
          عهدة {LOCATION_LABELS[kind]}
          {view.alerts.length > 0 && (
            <Badge tone="danger"><AlertTriangle className="me-1 inline h-3.5 w-3.5" aria-hidden="true" />{view.alerts.length} تنبيه{outCount ? ` · ${outCount} نفد` : ''}</Badge>
          )}
          {view.incoming.length > 0 && <Badge tone="warn">{view.incoming.length} بانتظار الاستلام</Badge>}
          {view.requests.length > 0 && <Badge tone="info">{view.requests.length} طلب مفتوح</Badge>}
        </span>
        <ChevronDown className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>

      {open && (
        <CardBody className="space-y-4 border-t border-line pt-3">
          {view.alerts.length > 0 && (
            <ul className="space-y-1" role="alert" data-testid="station-alerts">
              {view.alerts.map((a) => {
                const item = view.items.find((i) => i.id === a.itemId);
                return (
                  <li key={a.id} className={`flex flex-wrap items-center justify-between gap-2 rounded px-3 py-2 text-sm ${a.kind === 'out' ? 'bg-danger/10 text-danger' : 'bg-warn/10'}`}>
                    <span className="font-semibold">{item?.name}: {a.kind === 'out' ? 'نفد' : 'منخفض'}</span>
                    <span className="flex items-center gap-2">
                      <span className="lb-numeric">{item ? formatQty(a.qty, item.unit) : a.qty} / الحد {item ? formatQty(a.minQty, item.unit) : a.minQty}</span>
                      {!a.acknowledged && (
                        <Button size="sm" variant="ghost" onClick={async () => {
                          const r = await ackAlertAction(scope, { alertId: a.id });
                          if (r.ok) void reload(); else toast.error(r.error);
                        }}>تم العلم</Button>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}

          {view.incoming.map((t) => (
            <ReceiveForm key={t.id} scope={scope} transfer={t} canReceive={can.receive} onDone={reload} />
          ))}

          {hasStock && (
            <>
              <div className="flex flex-wrap gap-2">
                {([['levels', 'الرصيد'], ...(can.request ? [['request', 'طلب من المخزن']] : []), ...(can.waste ? [['waste', 'تسجيل هالك']] : [])] as [typeof section, string][]).map(([k, label]) => (
                  <button key={k} type="button" onClick={() => setSection(k)}
                    className={`rounded border px-3 py-1 text-sm ${section === k ? 'border-primary bg-primary-soft text-primary' : 'border-line'}`}>
                    {label}
                  </button>
                ))}
              </div>
              {section === 'levels' && <Levels view={view} />}
              {section === 'request' && can.request && <RequestForm scope={scope} view={view} onDone={reload} />}
              {section === 'waste' && can.waste && <WasteForm scope={scope} view={view} onDone={reload} />}
            </>
          )}
        </CardBody>
      )}
    </Card>
  );
}

function Levels({ view }: { view: StationView }) {
  const items = view.items.filter((i) => i.isActive);
  return (
    <ul className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4" data-testid="station-levels">
      {items.map((i) => {
        const qty = view.levels[i.id] ?? 0;
        const min = view.minLevels[i.id];
        const tone = qty <= 0 ? 'text-danger' : min !== undefined && qty <= min ? 'text-warn' : '';
        return (
          <li key={i.id} className="flex items-center justify-between rounded border border-line px-3 py-2">
            <span>{i.name}</span>
            <span className={`lb-numeric font-semibold ${tone}`}>{formatQty(qty, i.unit)}</span>
          </li>
        );
      })}
    </ul>
  );
}

function ReceiveForm({ scope, transfer, canReceive, onDone }: {
  scope: Scope; transfer: StationView['incoming'][number]; canReceive: boolean; onDone: () => Promise<void>;
}) {
  const toast = useToast();
  const [pending, start] = useTransition();
  const [counts, setCounts] = useState<Record<string, { amount: string; unit: InputUnit }>>(
    () => Object.fromEntries(transfer.items.map((i) => [i.lineId, { amount: '', unit: defaultInputUnit(i.unit) }])),
  );

  function submit() {
    const lines: { lineId: string; receivedQty: number }[] = [];
    for (const i of transfer.items) {
      const c = counts[i.lineId]!;
      const n = Number(c.amount.replace(',', '.'));
      if (c.amount.trim() === '' || !Number.isFinite(n) || n < 0) { toast.error(`اكتب الكمية المستلمة فعليًا من ${i.name}`); return; }
      lines.push({ lineId: i.lineId, receivedQty: toBase(n, i.unit, c.unit) });
    }
    start(async () => {
      const r = await receiveAction(scope, { transferId: transfer.id, lines });
      if (!r.ok) { toast.error(r.error); return; }
      if (r.data.status === 'disputed') toast.error('تم الاستلام مع فرق — أُبلغ المدير لمراجعته');
      else toast.success('تم الاستلام وأصبحت الكمية في عهدتك');
      await onDone();
    });
  }

  return (
    <div className="rounded border border-warn/50 bg-warn/5 p-3" data-testid="receive-form">
      <p className="mb-2 flex items-center gap-2 text-sm font-bold">
        <PackageCheck className="h-4 w-4" aria-hidden="true" />
        صرف من المخزن <bdi>{transfer.number}</bdi> — عُدّ ما وصلك فعليًا
      </p>
      {transfer.note ? <p className="mb-2 text-xs text-muted">{transfer.note}</p> : null}
      <ul className="space-y-2">
        {transfer.items.map((i) => (
          <li key={i.lineId} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="min-w-28 font-medium">{i.name}</span>
            <Input
              aria-label={`الكمية المستلمة من ${i.name}`}
              className="h-9 w-28"
              dir="ltr"
              inputMode="decimal"
              disabled={!canReceive}
              value={counts[i.lineId]!.amount}
              onChange={(e) => setCounts({ ...counts, [i.lineId]: { ...counts[i.lineId]!, amount: e.target.value } })}
            />
            {INPUT_UNITS[i.unit].length > 1 ? (
              <Select aria-label="الوحدة" className="h-9 w-24" value={counts[i.lineId]!.unit}
                onChange={(e) => setCounts({ ...counts, [i.lineId]: { ...counts[i.lineId]!, unit: e.target.value as InputUnit } })}>
                {INPUT_UNITS[i.unit].map((u) => <option key={u.key} value={u.key}>{u.label}</option>)}
              </Select>
            ) : <span className="text-muted">{INPUT_UNITS[i.unit][0]!.label}</span>}
          </li>
        ))}
      </ul>
      {canReceive ? (
        <div className="mt-3 flex items-center gap-3">
          <Button onClick={submit} disabled={pending} data-testid="receive-submit">تأكيد الاستلام</Button>
          <span className="text-xs text-muted">بتأكيدك تصبح هذه الكميات في عهدة القسم.</span>
        </div>
      ) : <p className="mt-2 text-xs text-muted">الاستلام لشيف المطبخ أو مسؤول البار.</p>}
    </div>
  );
}

function RequestForm({ scope, view, onDone }: { scope: Scope; view: StationView; onDone: () => Promise<void> }) {
  const toast = useToast();
  const [pending, start] = useTransition();
  const items = view.items.filter((i) => i.isActive);
  const suggest = (): DraftLine[] => {
    const low = view.alerts.map((a) => a.itemId);
    return low.length ? low.map((id) => newLine(id, defaultInputUnit(items.find((i) => i.id === id)?.unit))) : [newLine()];
  };
  const [lines, setLines] = useState<DraftLine[]>(suggest);
  const [note, setNote] = useState('');

  function submit() {
    const base = toBaseLines(lines, items);
    if (!base || base.length === 0) { toast.error('اختر الخامات والكميات المطلوبة'); return; }
    start(async () => {
      const r = await createRequestAction(scope, { kind: view.kind, lines: base.map(({ itemId, qty }) => ({ itemId, qty })), note: note || undefined });
      if (!r.ok) { toast.error(r.error); return; }
      toast.success('أُرسل الطلب إلى المخزن');
      setLines([newLine()]);
      setNote('');
      await onDone();
    });
  }

  return (
    <div className="space-y-3" data-testid="request-form">
      <LinesEditor items={items} lines={lines} onChange={setLines} testId="request-lines" />
      <Input placeholder="ملاحظة للمخزن (اختياري)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
      <Button onClick={submit} disabled={pending} data-testid="request-submit"><Send className="me-1 h-4 w-4" aria-hidden="true" />إرسال الطلب</Button>
      {view.requests.length > 0 && (
        <p className="text-xs text-muted">لديك {view.requests.length} طلب لم يُصرف بعد.</p>
      )}
    </div>
  );
}

function WasteForm({ scope, view, onDone }: { scope: Scope; view: StationView; onDone: () => Promise<void> }) {
  const toast = useToast();
  const [pending, start] = useTransition();
  const items = view.items.filter((i) => i.isActive);
  const [w, setW] = useState({ itemId: '', amount: '', unit: 'kg' as InputUnit, reason: 'spoiled', note: '' });
  const item = items.find((i) => i.id === w.itemId);

  function submit() {
    const n = Number(w.amount.replace(',', '.'));
    if (!item || !Number.isFinite(n) || n <= 0) { toast.error('اختر الخامة والكمية'); return; }
    const unit = INPUT_UNITS[item.unit].some((u) => u.key === w.unit) ? w.unit : defaultInputUnit(item.unit);
    start(async () => {
      const r = await recordWasteAction(scope, {
        kind: view.kind, itemId: item.id, qty: toBase(n, item.unit, unit), reason: w.reason as never, note: w.note || undefined,
      });
      if (!r.ok) { toast.error(r.error); return; }
      toast.success('تم تسجيل الهالك');
      setW({ ...w, amount: '', note: '' });
      await onDone();
    });
  }

  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5" data-testid="station-waste">
      <Select aria-label="الخامة" value={w.itemId} onChange={(e) => {
        const next = items.find((i) => i.id === e.target.value);
        setW({ ...w, itemId: e.target.value, unit: defaultInputUnit(next?.unit) });
      }}>
        <option value="">اختر الخامة…</option>
        {items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
      </Select>
      <div className="flex gap-2">
        <Input aria-label="الكمية" dir="ltr" inputMode="decimal" value={w.amount} onChange={(e) => setW({ ...w, amount: e.target.value })} />
        {item && INPUT_UNITS[item.unit].length > 1 && (
          <Select aria-label="الوحدة" className="w-24" value={w.unit} onChange={(e) => setW({ ...w, unit: e.target.value as InputUnit })}>
            {INPUT_UNITS[item.unit].map((u) => <option key={u.key} value={u.key}>{u.label}</option>)}
          </Select>
        )}
      </div>
      <Select aria-label="السبب" value={w.reason} onChange={(e) => setW({ ...w, reason: e.target.value })}>
        {WASTE_REASONS.filter((r) => r.key !== 'order_cancelled' && r.key !== 'transit_loss').map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
      </Select>
      <Input placeholder={w.reason === 'other' ? 'السبب (مطلوب)' : 'ملاحظة'} value={w.note} onChange={(e) => setW({ ...w, note: e.target.value })} maxLength={300} />
      <Button onClick={submit} disabled={pending}><Trash2 className="me-1 h-4 w-4" aria-hidden="true" />تسجيل</Button>
    </div>
  );
}
