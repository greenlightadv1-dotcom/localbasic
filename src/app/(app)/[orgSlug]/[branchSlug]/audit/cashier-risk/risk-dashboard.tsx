'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, ShieldAlert, ShieldCheck, SlidersHorizontal, RotateCcw } from 'lucide-react';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Field, Input } from '@/components/ui/field';
import { ConfirmDialog } from '@/components/ui/confirm';
import { useToast } from '@/components/ui/toast';
import { formatMoney } from '@/lib/money';
import { fromCents, toCents } from '@/lib/amount-input';
import { cn } from '@/lib/cn';
import {
  RISK_EVENTS, RISK_EVENT_LABELS, RISK_EVENT_POINTS, RISK_FLAG_THRESHOLD,
  type RiskLogEntry, type RiskRow,
} from '@/modules/restaurant/risk/events';
import { resetRiskAction, setLimitsAction } from './actions';

type Scope = { organizationSlug: string; branchSlug: string };
const when = (iso: string) => new Date(iso).toLocaleString('ar-EG', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/**
 * The owner's view: who is flagged, what made up each score, the event log,
 * and the two manager acts — clear a score (own PIN re-entered) and set a
 * person's daily refund/discount caps.
 */
export function RiskDashboard({ scope, basePath, currency, days, selectedUser, myUserId, rows, log, canReset }: {
  scope: Scope; basePath: string; currency: string; days: number; selectedUser: string | null; myUserId: string;
  rows: RiskRow[]; log: RiskLogEntry[]; canReset: boolean;
}) {
  const money = (c: number) => formatMoney(c, currency);
  const [resetting, setResetting] = useState<RiskRow | null>(null);
  const [limiting, setLimiting] = useState<RiskRow | null>(null);
  const flagged = rows.filter((r) => r.flagged);
  const events = rows.reduce((s, r) => s + RISK_EVENTS.reduce((t, e) => t + r.counts[e], 0), 0);
  const refunds = rows.reduce((s, r) => s + r.refundCents, 0);
  const voids = rows.reduce((s, r) => s + r.counts.void_after_print, 0);
  const names = new Map(rows.map((r) => [r.userId, r.name]));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-1" role="group" aria-label="الفترة">
        {[1, 7, 30, 90].map((d) => (
          <Link key={d} href={`${basePath}?days=${d}${selectedUser ? `&user=${selectedUser}` : ''}`}
            className={cn('rounded border px-3 py-1.5 text-sm', d === days ? 'border-primary bg-primary-soft text-primary' : 'border-line')}>
            {d === 1 ? 'اليوم' : `آخر ${d} يوم`}
          </Link>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="risk-kpis">
        <Kpi label="موظفون مُعلَّمون" value={String(flagged.length)} tone={flagged.length ? 'danger' : 'neutral'}
          icon={flagged.length ? <ShieldAlert className="h-5 w-5" aria-hidden="true" /> : <ShieldCheck className="h-5 w-5" aria-hidden="true" />} />
        <Kpi label="أحداث المخاطر في الفترة" value={String(events)} />
        <Kpi label="إلغاء بعد الطباعة" value={String(voids)} tone={voids ? 'warn' : 'neutral'} />
        <Kpi label="إجمالي المسترد" value={money(refunds)} />
      </div>

      <Card>
        <CardHeader><CardTitle>الموظفون</CardTitle></CardHeader>
        <CardBody className="p-0">
          {rows.length === 0 ? <p className="p-5 text-center text-sm text-muted">لا أحداث مخاطر بعد.</p> : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="risk-table">
                <thead className="border-b border-line text-xs text-muted">
                  <tr>
                    <th className="p-2 text-start">الموظف</th>
                    <th className="p-2 text-start">النقاط</th>
                    {RISK_EVENTS.map((e) => <th key={e} className="p-2 text-center" title={`${RISK_EVENT_POINTS[e]} نقطة لكل حدث`}>{RISK_EVENT_LABELS[e]}</th>)}
                    <th className="p-2 text-end">المسترد</th>
                    <th className="p-2 text-start">الحدود اليومية</th>
                    <th className="p-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {rows.map((r) => (
                    <tr key={r.userId} className={cn(r.flagged && 'bg-red-50/60 dark:bg-red-950/20', selectedUser === r.userId && 'ring-1 ring-inset ring-primary')}>
                      <td className="p-2">
                        <Link href={`${basePath}?days=${days}&user=${r.userId}`} className="font-medium hover:underline">{r.name}</Link>
                        {r.flagged && <p className="flex items-center gap-1 text-xs text-danger"><AlertTriangle className="h-3 w-3" aria-hidden="true" /> مُعلَّم {r.flaggedAt ? when(r.flaggedAt) : ''}</p>}
                        {r.lastResetAt && <p className="text-xs text-muted">آخر تصفير {when(r.lastResetAt)}</p>}
                      </td>
                      <td className="p-2"><ScoreMeter points={r.points} /></td>
                      {RISK_EVENTS.map((e) => (
                        <td key={e} className={cn('lb-numeric p-2 text-center', r.counts[e] === 0 && 'text-muted')}>{r.counts[e]}</td>
                      ))}
                      <td className="lb-numeric p-2 text-end">{r.refundCents ? money(r.refundCents) : '—'}</td>
                      <td className="p-2 text-xs">
                        <p>استرداد: <span className="lb-numeric">{r.refundLimitCents === null ? 'بدون حد' : money(r.refundLimitCents)}</span></p>
                        <p>خصم: <span className="lb-numeric">{r.discountLimitCents === null ? 'بدون حد' : money(r.discountLimitCents)}</span></p>
                      </td>
                      <td className="p-2 text-end">
                        {canReset && r.userId !== myUserId && (
                          <div className="flex justify-end gap-1">
                            <Button size="sm" variant="ghost" onClick={() => setLimiting(r)} aria-label={`حدود ${r.name}`}><SlidersHorizontal className="h-4 w-4" aria-hidden="true" /></Button>
                            <Button size="sm" variant={r.flagged ? 'secondary' : 'ghost'} disabled={r.points === 0} onClick={() => setResetting(r)} data-testid="risk-reset">
                              <RotateCcw className="h-4 w-4" aria-hidden="true" /> تصفير
                            </Button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>سجل الأحداث{selectedUser ? ` — ${names.get(selectedUser) ?? ''}` : ''}</CardTitle>
          {selectedUser && <Link href={`${basePath}?days=${days}`} className="text-sm text-primary">كل الموظفين</Link>}
        </CardHeader>
        <CardBody className="p-0">
          {log.length === 0 ? <p className="p-5 text-center text-sm text-muted">لا أحداث في هذه الفترة.</p> : (
            <ul className="divide-y divide-line text-sm" data-testid="risk-log">
              {log.map((e) => (
                <li key={e.id} className="flex flex-wrap items-start justify-between gap-2 p-3">
                  <div>
                    <p className="font-medium">
                      {RISK_EVENT_LABELS[e.event]} <Badge tone={e.points >= 3 ? 'danger' : 'warn'}>+{e.points}</Badge>
                      {e.orderNumber && <span className="text-xs text-muted"> · طلب #{e.orderNumber}</span>}
                    </p>
                    <p className="text-xs text-muted">
                      {names.get(e.userId) ?? 'موظف'}{e.branchName ? ` · ${e.branchName}` : ''}{e.reason ? ` · ${e.reason}` : ''}
                      {e.approvedBy ? ` · بموافقة ${e.approvedBy}` : ''}
                    </p>
                  </div>
                  <div className="text-end text-xs">
                    {e.amountCents !== null && <p className="lb-numeric font-medium">{money(e.amountCents)}</p>}
                    <p className="text-muted">{when(e.at)}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      {resetting && <ResetDialog scope={scope} row={resetting} onClose={() => setResetting(null)} />}
      {limiting && <LimitsDialog scope={scope} row={limiting} onClose={() => setLimiting(null)} />}
    </div>
  );
}

function Kpi({ label, value, tone = 'neutral', icon }: { label: string; value: string; tone?: 'neutral' | 'warn' | 'danger'; icon?: React.ReactNode }) {
  return (
    <Card>
      <CardBody className="flex items-start justify-between gap-2">
        <div>
          <p className="text-xs text-muted">{label}</p>
          <p className="lb-numeric text-2xl font-bold">{value}</p>
        </div>
        {icon && <span className={cn(tone === 'danger' ? 'text-danger' : tone === 'warn' ? 'text-warn' : 'text-success')}>{icon}</span>}
      </CardBody>
    </Card>
  );
}

/** Points against the flag line: the bar fills to the threshold; the label carries the state, not the colour. */
function ScoreMeter({ points }: { points: number }) {
  const pct = Math.min(points / RISK_FLAG_THRESHOLD, 1) * 100;
  const state = points >= RISK_FLAG_THRESHOLD ? 'مُعلَّم' : points >= RISK_FLAG_THRESHOLD * 0.6 ? 'مرتفع' : points > 0 ? 'منخفض' : 'سليم';
  return (
    <div className="min-w-28" role="meter" aria-valuemin={0} aria-valuemax={RISK_FLAG_THRESHOLD} aria-valuenow={points} aria-label={`نقاط المخاطر ${points} من ${RISK_FLAG_THRESHOLD}`}>
      <div className="flex items-baseline justify-between text-xs">
        <span className="lb-numeric text-base font-bold text-fg">{points}</span>
        <span className="text-muted">{state}</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-line">
        <div className={cn('h-full rounded-full', points >= RISK_FLAG_THRESHOLD ? 'bg-danger' : points >= RISK_FLAG_THRESHOLD * 0.6 ? 'bg-warn' : 'bg-success')}
          style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function ResetDialog({ scope, row, onClose }: { scope: Scope; row: RiskRow; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [pin, setPin] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  function confirm() {
    setError(null);
    start(async () => {
      const r = await resetRiskAction(scope, { userId: row.userId, pin, note });
      if (!r.ok) { setError(r.fieldErrors ? Object.values(r.fieldErrors).flat()[0] ?? r.error : r.error); return; }
      toast.success(`تم تصفير نقاط ${row.name}`);
      onClose(); router.refresh();
    });
  }

  return (
    <ConfirmDialog open title={`تصفير نقاط ${row.name}`} tone="primary" busy={pending} confirmLabel="تصفير"
      description={`النقاط الحالية ${row.points}. يبقى سجل الأحداث كما هو، ويُسجَّل التصفير باسمك.`}
      onCancel={onClose} onConfirm={confirm}>
      <div className="space-y-2" data-testid="risk-reset-dialog">
        <Input aria-label="سبب التصفير" placeholder="سبب التصفير (مطلوب)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
        <Input aria-label="رمز الموافقة الخاص بك" placeholder="رمز الموافقة (PIN)" type="password" inputMode="numeric" autoComplete="off"
          dir="ltr" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))} />
        {error && <p className="text-sm text-danger" role="alert">{error}</p>}
      </div>
    </ConfirmDialog>
  );
}

function LimitsDialog({ scope, row, onClose }: { scope: Scope; row: RiskRow; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [refund, setRefund] = useState(row.refundLimitCents === null ? '' : fromCents(row.refundLimitCents));
  const [discount, setDiscount] = useState(row.discountLimitCents === null ? '' : fromCents(row.discountLimitCents));

  function save() {
    const rc = refund.trim() ? toCents(refund) : null;
    const dc = discount.trim() ? toCents(discount) : null;
    if ((refund.trim() && rc === null) || (discount.trim() && dc === null)) { toast.error('المبلغ غير صالح'); return; }
    start(async () => {
      const r = await setLimitsAction(scope, { userId: row.userId, refundLimitCents: rc, discountLimitCents: dc });
      if (!r.ok) { toast.error(r.error); return; }
      toast.success('تم حفظ الحدود'); onClose(); router.refresh();
    });
  }

  return (
    <ConfirmDialog open title={`الحدود اليومية — ${row.name}`} tone="primary" busy={pending} confirmLabel="حفظ"
      description="فوق الحد يحتاج الموظف موافقة مدير برمز PIN، ويُسجَّل الخصم فوق الحد كحدث مخاطرة. اتركه فارغًا لعدم وضع حد."
      onCancel={onClose} onConfirm={save}>
      <div className="space-y-2">
        <Field label="حد الاسترداد اليومي">{(p) => <Input {...p} dir="ltr" inputMode="decimal" value={refund} onChange={(e) => setRefund(e.target.value)} placeholder="بدون حد" />}</Field>
        <Field label="حد الخصم اليدوي اليومي">{(p) => <Input {...p} dir="ltr" inputMode="decimal" value={discount} onChange={(e) => setDiscount(e.target.value)} placeholder="بدون حد" />}</Field>
      </div>
    </ConfirmDialog>
  );
}
