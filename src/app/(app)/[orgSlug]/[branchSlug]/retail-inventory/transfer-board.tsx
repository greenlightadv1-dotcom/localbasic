'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle, ArrowLeft, ArrowLeftRight, Ban, CheckCircle2, Clock, Inbox, Loader2, PackageCheck,
  Plus, Search, Send, ThumbsDown, ThumbsUp, Trash2, Truck, XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/field';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Modal } from '@/components/ui/modal';
import { useToast } from '@/components/ui/toast';
import { EmptyState } from '@/components/patterns/states';
import { cn } from '@/lib/cn';
import type {
  BranchOption, RetailPosCatalog, TransferStatus, TransferView,
} from '@/modules/retail/operations/service';
import {
  cancelTransferAction, decideTransferAction, dispatchTransferAction, receiveTransferAction, requestTransferAction,
} from './actions';
import type { InventoryPermissions, Scope } from './inventory-workspace';

const STATUS: Record<TransferStatus, { label: string; tone: 'neutral' | 'info' | 'success' | 'warn' | 'danger'; icon: typeof Clock }> = {
  requested: { label: 'بانتظار الموافقة', tone: 'warn', icon: Clock },
  approved: { label: 'معتمد للشحن', tone: 'info', icon: ThumbsUp },
  in_transit: { label: 'في الطريق', tone: 'info', icon: Truck },
  received: { label: 'مستلم', tone: 'success', icon: CheckCircle2 },
  cancelled: { label: 'ملغى', tone: 'neutral', icon: Ban },
  rejected: { label: 'مرفوض', tone: 'danger', icon: XCircle },
};

const OPEN_COLUMNS: { status: TransferStatus; title: string; hint: string }[] = [
  { status: 'requested', title: 'طلبات', hint: 'تنتظر موافقة فرع المصدر' },
  { status: 'approved', title: 'اعتماد', hint: 'جاهزة للشحن من المصدر' },
  { status: 'in_transit', title: 'في الطريق', hint: 'تنتظر الاستلام في الوجهة' },
];

const qty = (n: number) => new Intl.NumberFormat('ar-EG', { maximumFractionDigits: 3 }).format(n);
const parseQty = (s: string) => (s.trim() === '' ? NaN : Number(s.replace(',', '.')));

type Mode = { kind: 'create' } | { kind: 'decide' | 'dispatch' | 'receive' | 'cancel'; transfer: TransferView } | null;

/**
 * The transfer board for this branch. Each card shows only the step this
 * branch can take: the source approves and ships, the destination receives,
 * the requester (or the source's approver) cancels before shipping.
 */
export function TransferBoard({
  scope, branchId, timezone, branches, transfers, catalog, permissions,
}: {
  scope: Scope; branchId: string; timezone: string; branches: BranchOption[];
  transfers: TransferView[]; catalog: RetailPosCatalog; permissions: InventoryPermissions;
}) {
  const [direction, setDirection] = useState<'all' | 'incoming' | 'outgoing'>('all');
  const [mode, setMode] = useState<Mode>(null);

  const when = useMemo(() => {
    const f = new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone });
    return (iso: string | null) => (iso ? f.format(new Date(iso)) : '—');
  }, [timezone]);

  const shown = transfers.filter((t) => direction === 'all' || t.direction === direction);
  const closed = shown.filter((t) => ['received', 'cancelled', 'rejected'].includes(t.status));
  const otherBranches = branches.filter((b) => b.id !== branchId);

  function actionsFor(t: TransferView) {
    const atSource = t.fromBranchId === branchId;
    const atDestination = t.toBranchId === branchId;
    return {
      decide: t.status === 'requested' && atSource && permissions.approve,
      dispatch: t.status === 'approved' && atSource && permissions.transfer,
      receive: t.status === 'in_transit' && atDestination && permissions.transfer,
      cancel: (t.status === 'requested' || t.status === 'approved')
        && ((atDestination && permissions.transfer) || (atSource && permissions.approve)),
    };
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex overflow-hidden rounded border border-line text-sm" role="radiogroup" aria-label="اتجاه التحويل">
          {([['all', 'الكل'], ['incoming', 'وارد للفرع'], ['outgoing', 'صادر من الفرع']] as const).map(([k, label]) => (
            <button key={k} type="button" role="radio" aria-checked={direction === k} onClick={() => setDirection(k)}
              className={cn('px-4 py-2', direction === k ? 'bg-primary text-primary-fg' : 'bg-elevated hover:bg-surface')}>
              {label}
            </button>
          ))}
        </div>
        {permissions.transfer && otherBranches.length > 0 && (
          <Button onClick={() => setMode({ kind: 'create' })} data-testid="transfer-new">
            <Plus className="h-4 w-4" aria-hidden="true" /> طلب تحويل
          </Button>
        )}
      </div>

      {otherBranches.length === 0 && (
        <Alert tone="info">التحويلات تحتاج فرعين على الأقل. أضف فرعًا من الإعدادات ← الفروع.</Alert>
      )}

      <div className="grid gap-3 md:grid-cols-3">
        {OPEN_COLUMNS.map((col) => {
          const cards = shown.filter((t) => t.status === col.status);
          return (
            <section key={col.status} className="flex min-w-0 flex-col gap-2 rounded-lg border border-line bg-surface p-3" aria-label={col.title}>
              <header className="flex items-center justify-between">
                <div>
                  <h3 className="flex items-center gap-2 text-sm font-semibold">{col.title} <Badge tone={STATUS[col.status].tone}>{cards.length}</Badge></h3>
                  <p className="text-xs text-muted">{col.hint}</p>
                </div>
              </header>
              {cards.length === 0 ? (
                <p className="rounded border border-dashed border-line py-6 text-center text-xs text-muted">لا يوجد</p>
              ) : (
                cards.map((t) => <TransferCard key={t.id} transfer={t} when={when} actions={actionsFor(t)} onAction={(kind) => setMode({ kind, transfer: t })} />)
              )}
            </section>
          );
        })}
      </div>

      <section className="space-y-2" aria-label="السجل">
        <h3 className="text-sm font-semibold">السجل</h3>
        {closed.length === 0 ? (
          <div className="rounded-lg border border-line bg-elevated">
            <EmptyState icon={ArrowLeftRight} title="لا توجد تحويلات منتهية بعد" description="التحويلات المستلمة والملغاة والمرفوضة تظهر هنا." />
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-line bg-elevated">
            <table className="w-full min-w-[40rem] text-sm">
              <thead className="bg-surface text-xs text-muted">
                <tr>
                  <th className="px-3 py-2 text-start font-medium">الرقم</th>
                  <th className="px-3 py-2 text-start font-medium">المسار</th>
                  <th className="px-3 py-2 text-start font-medium">الأصناف</th>
                  <th className="px-3 py-2 text-start font-medium">الحالة</th>
                  <th className="px-3 py-2 text-start font-medium">التاريخ</th>
                </tr>
              </thead>
              <tbody>
                {closed.map((t) => {
                  const shortage = t.status === 'received'
                    ? t.lines.reduce((s, l) => s + Math.max(l.quantity - (l.quantityReceived ?? l.quantity), 0), 0) : 0;
                  return (
                    <tr key={t.id} className="border-t border-line align-top">
                      <td className="px-3 py-2 lb-numeric font-medium">{t.number ?? '—'}</td>
                      <td className="px-3 py-2">{t.fromBranchName} <ArrowLeft className="inline h-3 w-3 text-muted" aria-label="إلى" /> {t.toBranchName}</td>
                      <td className="px-3 py-2 text-muted">{t.lines.length} صنف{shortage > 0 && <span className="ms-2 text-warn">عجز {qty(shortage)}</span>}</td>
                      <td className="px-3 py-2">
                        <Badge tone={STATUS[t.status].tone}>{STATUS[t.status].label}</Badge>
                        {t.cancelReason && <p className="mt-1 text-xs text-muted">{t.cancelReason}</p>}
                      </td>
                      <td className="px-3 py-2 text-muted">{when(t.receivedAt ?? t.cancelledAt ?? t.approvedAt ?? t.createdAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <CreateTransferModal open={mode?.kind === 'create'} scope={scope} branches={otherBranches} catalog={catalog} onClose={() => setMode(null)} />
      {mode && mode.kind !== 'create' && (
        <>
          <DecideModal open={mode.kind === 'decide'} scope={scope} transfer={mode.transfer} onClose={() => setMode(null)} />
          <DispatchModal open={mode.kind === 'dispatch'} scope={scope} transfer={mode.transfer} catalog={catalog} onClose={() => setMode(null)} />
          <ReceiveModal open={mode.kind === 'receive'} scope={scope} transfer={mode.transfer} onClose={() => setMode(null)} />
          <CancelModal open={mode.kind === 'cancel'} scope={scope} transfer={mode.transfer} onClose={() => setMode(null)} />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------
function TransferCard({ transfer: t, when, actions, onAction }: {
  transfer: TransferView;
  when: (iso: string | null) => string;
  actions: { decide: boolean; dispatch: boolean; receive: boolean; cancel: boolean };
  onAction: (kind: 'decide' | 'dispatch' | 'receive' | 'cancel') => void;
}) {
  const total = t.lines.reduce((s, l) => s + l.quantity, 0);
  return (
    <article className="space-y-2 rounded border border-line bg-elevated p-3 text-sm" data-testid="transfer-card">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="lb-numeric font-semibold">{t.number ?? 'تحويل'}</p>
          <p className="text-xs text-muted">{when(t.dispatchedAt ?? t.approvedAt ?? t.createdAt)}</p>
        </div>
        <Badge tone={t.direction === 'incoming' ? 'info' : 'neutral'}>{t.direction === 'incoming' ? 'وارد' : 'صادر'}</Badge>
      </div>
      <p className="flex items-center gap-1 text-xs">
        <span className="font-medium">{t.fromBranchName}</span>
        <ArrowLeft className="h-3 w-3 text-muted" aria-label="إلى" />
        <span className="font-medium">{t.toBranchName}</span>
      </p>
      <ul className="space-y-0.5 text-xs text-muted">
        {t.lines.slice(0, 3).map((l) => (
          <li key={l.variantId} className="flex justify-between gap-2"><span className="truncate">{l.name}</span><span className="lb-numeric">{qty(l.quantity)}</span></li>
        ))}
        {t.lines.length > 3 && <li>و{t.lines.length - 3} أصناف أخرى · الإجمالي <span className="lb-numeric">{qty(total)}</span></li>}
      </ul>
      {t.reason && <p className="rounded bg-surface px-2 py-1 text-xs">{t.reason}</p>}
      {(actions.decide || actions.dispatch || actions.receive || actions.cancel) && (
        <div className="flex flex-wrap gap-2 pt-1">
          {actions.decide && <Button size="sm" onClick={() => onAction('decide')}><ThumbsUp className="h-4 w-4" aria-hidden="true" /> مراجعة</Button>}
          {actions.dispatch && <Button size="sm" onClick={() => onAction('dispatch')}><Send className="h-4 w-4" aria-hidden="true" /> شحن</Button>}
          {actions.receive && <Button size="sm" onClick={() => onAction('receive')}><PackageCheck className="h-4 w-4" aria-hidden="true" /> استلام</Button>}
          {actions.cancel && <Button size="sm" variant="ghost" onClick={() => onAction('cancel')}><Ban className="h-4 w-4" aria-hidden="true" /> إلغاء</Button>}
        </div>
      )}
    </article>
  );
}

// ---------------------------------------------------------------------------
// Shared modal plumbing
// ---------------------------------------------------------------------------
function useSubmit(onClose: () => void) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run<T>(
    call: () => Promise<{ ok: true; data: T } | { ok: false; error: string; code: string }>,
    success: (data: T) => string,
  ) {
    setBusy(true);
    setError(null);
    const r = await call();
    setBusy(false);
    if (!r.ok) {
      setError(r.code === 'forbidden' || r.code === 'not_found' ? 'لا تملك صلاحية هذا الإجراء في هذا الفرع.' : r.error);
      return;
    }
    toast.success(success(r.data));
    onClose();
    router.refresh();
  }
  return { busy, error, setError, run };
}

function LinesTable({ children, heads }: { children: React.ReactNode; heads: string[] }) {
  return (
    <div className="overflow-x-auto rounded border border-line">
      <table className="w-full text-sm">
        <thead className="bg-surface text-xs text-muted">
          <tr>{heads.map((h) => <th key={h} className="px-3 py-2 text-start font-medium">{h}</th>)}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create request
// ---------------------------------------------------------------------------
function CreateTransferModal({ open, scope, branches, catalog, onClose }: {
  open: boolean; scope: Scope; branches: BranchOption[]; catalog: RetailPosCatalog; onClose: () => void;
}) {
  const [fromBranchId, setFromBranchId] = useState('');
  const [search, setSearch] = useState('');
  const [lines, setLines] = useState<{ variantId: string; name: string; quantity: string }[]>([]);
  const [reason, setReason] = useState('');
  const close = () => { setFromBranchId(''); setSearch(''); setLines([]); setReason(''); onClose(); };
  const { busy, error, run } = useSubmit(close);

  const matches = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return [];
    return catalog.items
      .filter((i) => !lines.some((l) => l.variantId === i.variantId))
      .filter((i) => i.productName.toLowerCase().includes(term) || i.variantName.toLowerCase().includes(term)
        || i.sku?.toLowerCase() === term || i.barcode === term)
      .slice(0, 8);
  }, [catalog.items, search, lines]);

  const invalid = lines.some((l) => !(parseQty(l.quantity) > 0));
  const blocker = !fromBranchId ? 'اختر الفرع المصدر.' : lines.length === 0 ? 'أضف صنفًا واحدًا على الأقل.' : invalid ? 'كل الكميات يجب أن تكون أكبر من صفر.' : null;

  return (
    <Modal open={open} onClose={close} busy={busy} size="lg" icon={ArrowLeftRight} title="طلب تحويل مخزون"
      description="يُرسل الطلب لفرع المصدر للموافقة، ثم يشحنه، وتستلمه أنت هنا." testId="transfer-create"
      footer={<>
        {blocker && <p className="me-auto text-xs text-muted">{blocker}</p>}
        <Button variant="outline" onClick={close} disabled={busy}>إلغاء</Button>
        <Button disabled={!!blocker || busy} onClick={() => void run(
          () => requestTransferAction(scope, {
            fromBranchId, reason: reason.trim() || undefined,
            items: lines.map((l) => ({ variantId: l.variantId, quantity: parseQty(l.quantity) })),
          }),
          (d) => `أُرسل الطلب ${d.number}`,
        )}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Send className="h-4 w-4" aria-hidden="true" />} إرسال الطلب
        </Button>
      </>}>
      {error && <Alert tone="danger">{error}</Alert>}
      <label className="block space-y-1.5 text-sm">
        <span className="font-medium">من فرع</span>
        <Select value={fromBranchId} onChange={(e) => setFromBranchId(e.target.value)} data-testid="transfer-from">
          <option value="">اختر الفرع الذي لديه المخزون…</option>
          {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </Select>
      </label>

      <div className="space-y-1.5">
        <span className="text-sm font-medium">الأصناف</span>
        <div className="relative">
          <Search className="pointer-events-none absolute inset-y-0 start-3 my-auto h-4 w-4 text-muted" aria-hidden="true" />
          <Input aria-label="ابحث عن صنف" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="ابحث بالاسم أو SKU أو الباركود" className="ps-9" />
        </div>
        {matches.length > 0 && (
          <ul className="max-h-48 overflow-y-auto rounded border border-line">
            {matches.map((i) => (
              <li key={i.variantId}>
                <button type="button" className="flex w-full items-center justify-between px-3 py-2 text-start text-sm hover:bg-surface"
                  onClick={() => {
                    setLines((ls) => [...ls, { variantId: i.variantId, name: i.variantName === 'default' ? i.productName : `${i.productName} — ${i.variantName}`, quantity: '1' }]);
                    setSearch('');
                  }}>
                  <span>{i.productName}{i.variantName !== 'default' && <span className="text-muted"> — {i.variantName}</span>}</span>
                  <span className="text-xs text-muted">لديك {qty(i.stock)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {lines.length > 0 && (
        <LinesTable heads={['الصنف', 'الكمية المطلوبة', '']}>
          {lines.map((l, idx) => (
            <tr key={l.variantId} className="border-t border-line">
              <td className="px-3 py-2">{l.name}</td>
              <td className="px-3 py-2">
                <Input aria-label={`كمية ${l.name}`} value={l.quantity} inputMode="decimal" dir="ltr" className="h-9 w-28 text-center"
                  onChange={(e) => setLines((ls) => ls.map((x, i) => (i === idx ? { ...x, quantity: e.target.value } : x)))} />
              </td>
              <td className="px-3 py-2 text-end">
                <Button size="icon" variant="ghost" aria-label={`حذف ${l.name}`} onClick={() => setLines((ls) => ls.filter((_, i) => i !== idx))}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </td>
            </tr>
          ))}
        </LinesTable>
      )}

      <label className="block space-y-1.5 text-sm">
        <span className="font-medium">السبب <span className="text-muted">(اختياري)</span></span>
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} rows={2} placeholder="مثال: نفاد قبل موسم العيد" />
      </label>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Approve / reject
// ---------------------------------------------------------------------------
function DecideModal({ open, scope, transfer: t, onClose }: { open: boolean; scope: Scope; transfer: TransferView; onClose: () => void }) {
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const { busy, error, run } = useSubmit(onClose);

  return (
    <Modal open={open} onClose={onClose} busy={busy} icon={ThumbsUp} title={`مراجعة ${t.number ?? 'التحويل'}`}
      description={`${t.toBranchName} يطلب من فرعك هذه الأصناف.`} testId="transfer-decide"
      footer={rejecting ? <>
        <Button variant="outline" onClick={() => setRejecting(false)} disabled={busy}>رجوع</Button>
        <Button variant="danger" disabled={busy || note.trim().length < 2}
          onClick={() => void run(() => decideTransferAction(scope, { transferId: t.id, approve: false, note: note.trim() }), () => `رُفض ${t.number ?? 'التحويل'}`)}>
          <ThumbsDown className="h-4 w-4" aria-hidden="true" /> تأكيد الرفض
        </Button>
      </> : <>
        <Button variant="outline" onClick={() => setRejecting(true)} disabled={busy}><ThumbsDown className="h-4 w-4" aria-hidden="true" /> رفض</Button>
        <Button disabled={busy}
          onClick={() => void run(() => decideTransferAction(scope, { transferId: t.id, approve: true }), () => `اعتُمد ${t.number ?? 'التحويل'} للشحن`)}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <ThumbsUp className="h-4 w-4" aria-hidden="true" />} اعتماد
        </Button>
      </>}>
      {error && <Alert tone="danger">{error}</Alert>}
      {t.reason && <p className="rounded bg-surface px-3 py-2 text-sm">السبب: {t.reason}</p>}
      <LinesTable heads={['الصنف', 'الكمية']}>
        {t.lines.map((l) => (
          <tr key={l.variantId} className="border-t border-line"><td className="px-3 py-2">{l.name}</td><td className="px-3 py-2 lb-numeric">{qty(l.quantity)}</td></tr>
        ))}
      </LinesTable>
      {rejecting && (
        <label className="block space-y-1.5 text-sm">
          <span className="font-medium">سبب الرفض <span className="text-danger">*</span></span>
          <Textarea autoFocus value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} rows={2} placeholder="مطلوب: يظهر للفرع الطالب" />
        </label>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------
function DispatchModal({ open, scope, transfer: t, catalog, onClose }: {
  open: boolean; scope: Scope; transfer: TransferView; catalog: RetailPosCatalog; onClose: () => void;
}) {
  const stock = useMemo(() => new Map(catalog.items.map((i) => [i.variantId, i.stock])), [catalog.items]);
  const [shipped, setShipped] = useState<Record<string, string>>(() => Object.fromEntries(t.lines.map((l) => [l.variantId, String(l.quantity)])));
  const { busy, error, run } = useSubmit(onClose);

  const parsed = t.lines.map((l) => ({ line: l, q: parseQty(shipped[l.variantId] ?? '') }));
  const invalid = parsed.some(({ line, q }) => !(q >= 0) || q > line.quantity);
  const short = parsed.filter(({ line, q }) => q >= 0 && q > (stock.get(line.variantId) ?? 0));
  const nothing = parsed.every(({ q }) => q === 0);

  return (
    <Modal open={open} onClose={onClose} busy={busy} size="lg" icon={Truck} title={`شحن ${t.number ?? 'التحويل'} إلى ${t.toBranchName}`}
      description="تخرج الكميات من رصيد فرعك الآن، وتدخل رصيد الوجهة عند الاستلام." testId="transfer-dispatch"
      footer={<>
        <Button variant="outline" onClick={onClose} disabled={busy}>إلغاء</Button>
        <Button disabled={busy || invalid || nothing || short.length > 0}
          onClick={() => void run(() => dispatchTransferAction(scope, {
            transferId: t.id,
            items: parsed.filter(({ line, q }) => q !== line.quantity).map(({ line, q }) => ({ variantId: line.variantId, quantity: q })),
          }), () => `شُحن ${t.number ?? 'التحويل'}`)}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Send className="h-4 w-4" aria-hidden="true" />} تأكيد الشحن
        </Button>
      </>}>
      {error && <Alert tone="danger">{error}</Alert>}
      {short.length > 0 && <Alert tone="warn">رصيد فرعك لا يكفي لـ {short.map((s) => s.line.name).join('، ')}. اخفض الكمية أو اجعلها صفرًا.</Alert>}
      {nothing && <Alert tone="warn">لا يمكن شحن تحويل كل كمياته صفر؛ ألغِه بدلًا من ذلك.</Alert>}
      <LinesTable heads={['الصنف', 'المطلوب', 'رصيدك', 'المشحون']}>
        {parsed.map(({ line, q }) => {
          const bad = !(q >= 0) || q > line.quantity;
          return (
            <tr key={line.variantId} className="border-t border-line">
              <td className="px-3 py-2">{line.name}</td>
              <td className="px-3 py-2 lb-numeric">{qty(line.quantity)}</td>
              <td className={cn('px-3 py-2 lb-numeric', (stock.get(line.variantId) ?? 0) < q && 'text-danger')}>{qty(stock.get(line.variantId) ?? 0)}</td>
              <td className="px-3 py-2">
                <Input aria-label={`الكمية المشحونة من ${line.name}`} value={shipped[line.variantId] ?? ''} inputMode="decimal" dir="ltr"
                  aria-invalid={bad} className={cn('h-9 w-24 text-center', bad && 'border-danger')}
                  onChange={(e) => setShipped((s) => ({ ...s, [line.variantId]: e.target.value }))} />
              </td>
            </tr>
          );
        })}
      </LinesTable>
      <p className="text-xs text-muted">الكمية الأقل من المطلوب تُشحن ناقصة؛ الصفر يحذف الصنف من التحويل.</p>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Receive
// ---------------------------------------------------------------------------
function ReceiveModal({ open, scope, transfer: t, onClose }: { open: boolean; scope: Scope; transfer: TransferView; onClose: () => void }) {
  const [counted, setCounted] = useState<Record<string, string>>(() => Object.fromEntries(t.lines.map((l) => [l.variantId, String(l.quantity)])));
  const [note, setNote] = useState('');
  const { busy, error, run } = useSubmit(onClose);

  const parsed = t.lines.map((l) => ({ line: l, q: parseQty(counted[l.variantId] ?? '') }));
  const invalid = parsed.some(({ line, q }) => !(q >= 0) || q > line.quantity);
  const shortages = parsed.filter(({ line, q }) => q >= 0 && q < line.quantity);
  const shortageQty = shortages.reduce((s, { line, q }) => s + (line.quantity - q), 0);

  return (
    <Modal open={open} onClose={onClose} busy={busy} size="lg" icon={PackageCheck} title={`استلام ${t.number ?? 'التحويل'} من ${t.fromBranchName}`}
      description="عُدّ ما وصل فعلًا. ما يدخل رصيد فرعك هو المستلم فقط." testId="transfer-receive"
      footer={<>
        <Button variant="outline" onClick={onClose} disabled={busy}>إلغاء</Button>
        <Button disabled={busy || invalid || (shortages.length > 0 && note.trim().length < 2)}
          onClick={() => void run(() => receiveTransferAction(scope, {
            transferId: t.id, note: note.trim() || undefined,
            items: shortages.map(({ line, q }) => ({ variantId: line.variantId, quantityReceived: q })),
          }), (d) => (d.shortageLines > 0
            ? `استُلم ${t.number ?? 'التحويل'} بعجز ${qty(d.shortageQty)} في ${d.shortageLines} صنف`
            : `استُلم ${t.number ?? 'التحويل'} كاملًا`))}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Inbox className="h-4 w-4" aria-hidden="true" />}
          {shortages.length > 0 ? 'استلام جزئي' : 'استلام كامل'}
        </Button>
      </>}>
      {error && <Alert tone="danger">{error}</Alert>}
      <LinesTable heads={['الصنف', 'المشحون', 'المستلم', 'العجز']}>
        {parsed.map(({ line, q }) => {
          const bad = !(q >= 0) || q > line.quantity;
          const gap = q >= 0 && q < line.quantity ? line.quantity - q : 0;
          return (
            <tr key={line.variantId} className={cn('border-t border-line', gap > 0 && 'bg-warn/5')}>
              <td className="px-3 py-2">{line.name}</td>
              <td className="px-3 py-2 lb-numeric">{qty(line.quantity)}</td>
              <td className="px-3 py-2">
                <Input aria-label={`الكمية المستلمة من ${line.name}`} value={counted[line.variantId] ?? ''} inputMode="decimal" dir="ltr"
                  aria-invalid={bad} className={cn('h-9 w-24 text-center', bad && 'border-danger')}
                  onChange={(e) => setCounted((s) => ({ ...s, [line.variantId]: e.target.value }))} />
              </td>
              <td className={cn('px-3 py-2 lb-numeric', gap > 0 ? 'font-semibold text-warn' : 'text-muted')}>{gap > 0 ? qty(gap) : '—'}</td>
            </tr>
          );
        })}
      </LinesTable>
      {invalid && <p className="text-xs text-danger" role="alert">المستلم لا يمكن أن يكون سالبًا أو أكبر من المشحون.</p>}
      {shortages.length > 0 && (
        <>
          <Alert tone="warn" title="عجز في الاستلام">
            <span className="flex items-start gap-2"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              ينقص {qty(shortageQty)} في {shortages.length} صنف. خرجت من رصيد {t.fromBranchName} ولن تدخل رصيدك، ويُسجَّل العجز في سجل المراجعة.</span>
          </Alert>
          <label className="block space-y-1.5 text-sm">
            <span className="font-medium">ملاحظة العجز <span className="text-danger">*</span></span>
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} rows={2} placeholder="مثال: كرتونة مفقودة، استلمها فلان" />
          </label>
        </>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------
function CancelModal({ open, scope, transfer: t, onClose }: { open: boolean; scope: Scope; transfer: TransferView; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const { busy, error, run } = useSubmit(onClose);
  return (
    <Modal open={open} onClose={onClose} busy={busy} size="sm" icon={Ban} title={`إلغاء ${t.number ?? 'التحويل'}`}
      description="لم يُشحن شيء بعد، فلا يتغير أي رصيد." testId="transfer-cancel"
      footer={<>
        <Button variant="outline" onClick={onClose} disabled={busy}>رجوع</Button>
        <Button variant="danger" disabled={busy || reason.trim().length < 2}
          onClick={() => void run(() => cancelTransferAction(scope, { transferId: t.id, reason: reason.trim() }), () => `أُلغي ${t.number ?? 'التحويل'}`)}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Ban className="h-4 w-4" aria-hidden="true" />} تأكيد الإلغاء
        </Button>
      </>}>
      {error && <Alert tone="danger">{error}</Alert>}
      <label className="block space-y-1.5 text-sm">
        <span className="font-medium">سبب الإلغاء <span className="text-danger">*</span></span>
        <Textarea autoFocus value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} rows={2} />
      </label>
    </Modal>
  );
}
