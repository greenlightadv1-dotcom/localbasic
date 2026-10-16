'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Minus, Plus, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { useApproval } from '@/components/patterns/approval-dialog';
import { cn } from '@/lib/cn';
import { formatMoney } from '@/lib/money';
import type { CheckLine } from '@/modules/restaurant/floor/service';
import { checkLinesAction, setSeatAction, splitCheckAction } from './actions';

type Scope = { organizationSlug: string; branchSlug: string };

/**
 * Split a check three ways:
 *   · by items  — pick lines (or part of a line) for the new check;
 *   · by seat   — tag lines with a seat, then take a whole seat at once;
 *   · evenly    — no new check: the share per guest, collected as separate
 *                 partial payments at the cashier (the order takes them).
 * Moving lines needs a manager PIN for anyone without approval rights.
 */
export function SplitDialog({ scope, currency, orderId, orderNumber, onClose }: {
  scope: Scope; currency: string; orderId: string; orderNumber: string; onClose: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const approval = useApproval(scope);
  const [pending, start] = useTransition();
  const ref = useRef<HTMLDialogElement>(null);
  const [lines, setLines] = useState<CheckLine[] | null>(null);
  const [take, setTake] = useState<Record<string, number>>({});
  const [tab, setTab] = useState<'items' | 'even'>('items');
  const [guests, setGuests] = useState(2);

  useEffect(() => { ref.current?.showModal(); }, []);
  async function load() {
    const r = await checkLinesAction(scope, { orderId });
    if (r.ok) setLines(r.data); else { toast.error(r.error); onClose(); }
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [orderId]);

  const total = (lines ?? []).reduce((s, l) => s + l.lineTotalCents, 0);
  const moving = (lines ?? []).reduce((s, l) => s + Math.round((l.lineTotalCents / l.quantity) * (take[l.id] ?? 0)), 0);
  const seats = useMemo(() => [...new Set((lines ?? []).map((l) => l.seatNo).filter((s): s is number => s !== null))].sort((a, b) => a - b), [lines]);
  const units = (lines ?? []).reduce((s, l) => s + l.quantity, 0);
  const movingUnits = Object.values(take).reduce((s, v) => s + v, 0);

  function setQty(l: CheckLine, q: number) {
    setTake((t) => ({ ...t, [l.id]: Math.min(Math.max(q, 0), l.quantity) }));
  }

  function setSeat(l: CheckLine, seat: number | null) {
    start(async () => {
      const r = await setSeatAction(scope, { itemIds: [l.id], seat });
      if (!r.ok) { toast.error(r.error); return; }
      setLines((ls) => (ls ?? []).map((x) => (x.id === l.id ? { ...x, seatNo: seat } : x)));
    });
  }

  function takeSeat(seat: number) {
    setTake(Object.fromEntries((lines ?? []).filter((l) => l.seatNo === seat).map((l) => [l.id, l.quantity])));
  }

  function submit() {
    const payload = Object.entries(take).filter(([, q]) => q > 0).map(([itemId, qty]) => ({ itemId, qty }));
    if (payload.length === 0) { toast.error('اختر الأصناف المراد فصلها'); return; }
    if (movingUnits >= units) { toast.error('يجب أن يبقى صنف واحد على الأقل في الفاتورة الأصلية'); return; }
    const go = async () => {
      const r = await splitCheckAction(scope, { orderId, lines: payload });
      if (!r.ok) {
        if (r.code === 'approval_required') { approval.request('check.split', orderId, null, go); return; }
        toast.error(r.error);
        return;
      }
      toast.success(`تم فصل فاتورة جديدة رقم ${r.data.number}`);
      router.refresh();
      onClose();
    };
    start(go);
  }

  return (
    <dialog ref={ref} onClose={onClose} onCancel={onClose} aria-labelledby="split-title"
      className="w-[min(36rem,calc(100vw-2rem))] rounded-lg border border-line bg-elevated p-0 text-fg backdrop:bg-fg/40"
      data-testid="split-dialog">
      <div className="space-y-4 p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 id="split-title" className="text-base font-bold">تقسيم الفاتورة <bdi className="lb-numeric">#{orderNumber}</bdi></h2>
          <span className="text-sm text-muted lb-numeric">{formatMoney(total, currency)}</span>
        </div>
        <div className="flex gap-2">
          {([['items', 'بالأصناف أو المقعد'], ['even', 'بالتساوي']] as const).map(([k, label]) => (
            <button key={k} type="button" onClick={() => setTab(k)}
              className={cn('rounded border px-3 py-1.5 text-sm', tab === k ? 'border-primary bg-primary-soft text-primary' : 'border-line')}>
              {label}
            </button>
          ))}
        </div>

        {lines === null ? <p className="text-sm text-muted">جارٍ التحميل…</p> : tab === 'items' ? (
          <>
            {seats.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-muted">فاتورة لمقعد:</span>
                {seats.map((s) => (
                  <Button key={s} size="sm" variant="outline" onClick={() => takeSeat(s)}>مقعد {s}</Button>
                ))}
              </div>
            )}
            <ul className="max-h-[50vh] divide-y divide-line overflow-y-auto rounded border border-line">
              {lines.map((l) => (
                <li key={l.id} className="flex flex-wrap items-center gap-2 p-2 text-sm">
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">
                      <span className="lb-numeric text-primary">{l.quantity}×</span> <bdi>{l.productName}</bdi>
                      {l.variantName !== 'default' && <span className="text-muted"> — {l.variantName}</span>}
                    </p>
                    {l.modifiers.length > 0 && <p className="text-xs text-muted">{l.modifiers.join('، ')}</p>}
                  </div>
                  <select aria-label="المقعد" value={l.seatNo ?? ''} disabled={pending}
                    onChange={(e) => setSeat(l, e.target.value ? Number(e.target.value) : null)}
                    className="h-8 rounded border border-line bg-elevated px-1 text-xs">
                    <option value="">بدون مقعد</option>
                    {Array.from({ length: 12 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>مقعد {n}</option>)}
                  </select>
                  <span className="flex items-center gap-1" aria-label={`الكمية المنقولة من ${l.productName}`}>
                    <button type="button" className="grid h-8 w-8 place-items-center rounded border border-line" onClick={() => setQty(l, (take[l.id] ?? 0) - 1)} aria-label="أقل">
                      <Minus className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                    <span className="w-6 text-center font-bold lb-numeric">{take[l.id] ?? 0}</span>
                    <button type="button" className="grid h-8 w-8 place-items-center rounded border border-line" onClick={() => setQty(l, (take[l.id] ?? 0) + 1)} aria-label="أكثر"
                      data-testid={`take-${l.productName}`}>
                      <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </span>
                </li>
              ))}
            </ul>
            <div className="flex items-center justify-between text-sm">
              <span>الفاتورة الجديدة</span>
              <span className="font-bold lb-numeric">{formatMoney(moving, currency)}</span>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={onClose} disabled={pending}>إلغاء</Button>
              <Button onClick={submit} disabled={pending || movingUnits === 0} data-testid="split-submit">فصل في فاتورة جديدة</Button>
            </div>
          </>
        ) : (
          <div className="space-y-3 text-sm">
            <label className="flex items-center gap-3">
              <Users className="h-4 w-4 text-muted" aria-hidden="true" />
              عدد الأشخاص
              <input type="number" min={2} max={30} value={guests} onChange={(e) => setGuests(Math.min(Math.max(Number(e.target.value) || 2, 2), 30))}
                className="h-9 w-20 rounded border border-line bg-elevated px-2 text-center lb-numeric" dir="ltr" />
            </label>
            <ul className="space-y-1 rounded border border-line p-3 lb-numeric">
              {Array.from({ length: guests }, (_, i) => {
                // Cents divide unevenly: the first guests carry the remainder.
                const base = Math.floor(total / guests);
                const share = base + (i < total - base * guests ? 1 : 0);
                return <li key={i} className="flex justify-between"><span>الشخص {i + 1}</span><span className="font-semibold">{formatMoney(share, currency)}</span></li>;
              })}
            </ul>
            <p className="text-xs text-muted">حصّل كل حصة كدفعة منفصلة على نفس الطلب من شاشة الكاشير؛ يبقى الطلب مفتوحًا حتى يُسدَّد بالكامل.</p>
            <div className="flex justify-end"><Button variant="outline" onClick={onClose}>إغلاق</Button></div>
          </div>
        )}
      </div>
      {approval.dialog}
    </dialog>
  );
}
