'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { MessageCircle, Search, ShieldOff, Users } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Input, Textarea } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { EmptyState } from '@/components/patterns/states';
import { normalizeArabic } from '@/components/menu/category-icon';
import { formatMoney } from '@/lib/money';
import {
  MAX_OFFER_LENGTH, OFFER_TEMPLATES, OFFER_VARIABLES, buildOfferMessage, whatsappOfferUrl,
} from '@/modules/restaurant/customers/offer';
import type { DirectoryRow } from '@/modules/restaurant/customers/service';
import { resetCustomerAction } from './actions';

type Filter = 'all' | 'points' | 'inactive' | 'verified';
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'الكل' },
  { id: 'points', label: 'لديهم نقاط' },
  { id: 'inactive', label: 'لم يطلبوا منذ 30 يومًا' },
  { id: 'verified', label: 'جهاز مؤكَّد' },
];
const DAY = 86_400_000;

const dateLabel = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('ar-EG', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

export function CustomerDirectory({
  rows, truncated, currency, orgSlug, storeName, canManage, scope,
}: {
  rows: DirectoryRow[];
  truncated: boolean;
  currency: string;
  orgSlug: string;
  storeName: string;
  canManage: boolean;
  scope: { organizationSlug: string; branchSlug: string };
}) {
  const router = useRouter();
  const toast = useToast();
  const [isPending, startTransition] = useTransition();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [offerFor, setOfferFor] = useState<DirectoryRow | null>(null);
  const [resetFor, setResetFor] = useState<DirectoryRow | null>(null);
  const [alsoRemove, setAlsoRemove] = useState(true);

  const visible = useMemo(() => {
    const q = normalizeArabic(query);
    const qDigits = query.replace(/\D/g, '');
    const now = Date.now();
    return rows.filter((r) => {
      if (q) {
        const byName = normalizeArabic(r.name).includes(q);
        const byPhone = qDigits.length >= 3 && r.phone.replace(/\D/g, '').includes(qDigits);
        if (!byName && !byPhone) return false;
      }
      if (filter === 'points') return r.points > 0;
      if (filter === 'verified') return r.devices > 0;
      if (filter === 'inactive') return !r.lastOrderAt || now - new Date(r.lastOrderAt).getTime() > 30 * DAY;
      return true;
    });
  }, [rows, query, filter]);

  const totalSpent = rows.reduce((n, r) => n + r.spentCents, 0);
  const withPoints = rows.filter((r) => r.points > 0).length;

  function startReset(r: DirectoryRow) {
    setAlsoRemove(true);
    setResetFor(r);
  }

  function confirmReset() {
    if (!resetFor) return;
    const target = resetFor;
    startTransition(async () => {
      const result = await resetCustomerAction(scope, { phone: target.phone, removeCustomer: alsoRemove });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      const { devicesRemoved, customersRemoved } = result.data;
      toast.success(
        devicesRemoved + customersRemoved === 0
          ? 'لا توجد بصمة جهاز مرتبطة بهذا الرقم.'
          : `تمت الإزالة (${devicesRemoved} جهاز${customersRemoved ? ' + سجل العميل' : ''}). سيؤكّد العميل رقمه من جديد.`,
      );
      setResetFor(null);
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        <Stat label="العملاء" value={rows.length.toLocaleString('ar-EG')} />
        <Stat label="إجمالي المبيعات" value={formatMoney(totalSpent, currency)} />
        <Stat label="لديهم نقاط" value={withPoints.toLocaleString('ar-EG')} />
      </div>

      <div className="space-y-3">
        <div className="relative">
          <Search className="pointer-events-none absolute inset-y-0 start-3 my-auto h-4 w-4 text-muted" aria-hidden="true" />
          <label htmlFor="customer-search" className="sr-only">بحث بالاسم أو رقم الهاتف</label>
          <Input
            id="customer-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="ابحث بالاسم أو رقم الهاتف…" className="ps-9" data-testid="customer-search"
          />
        </div>
        <ul className="flex flex-wrap gap-2" aria-label="تصفية">
          {FILTERS.map((f) => (
            <li key={f.id}>
              <button
                type="button" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}
                className={`h-9 rounded-full border px-3.5 text-sm font-semibold transition-colors ${
                  filter === f.id ? 'border-primary bg-primary text-primary-fg' : 'border-line bg-elevated text-fg hover:border-primary/50'
                }`}
              >
                {f.label}
              </button>
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted" role="status" aria-live="polite">
          {visible.length.toLocaleString('ar-EG')} من {rows.length.toLocaleString('ar-EG')}
          {truncated ? ' — يظهر أحدث 1000 عميل فقط' : ''}
        </p>
      </div>

      <Card>
        {visible.length === 0 ? (
          <EmptyState
            icon={Users}
            title={rows.length === 0 ? 'لا يوجد عملاء بعد' : 'لا نتائج مطابقة'}
            description={rows.length === 0 ? 'يظهر هنا كل من طلب من المتجر أو الكاشير.' : 'جرّب اسمًا أو رقمًا آخر، أو غيّر التصفية.'}
          />
        ) : (
          <>
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full text-sm">
              <caption className="sr-only">دليل العملاء</caption>
              <thead>
                <tr className="border-b border-line text-xs text-muted">
                  <th scope="col" className="p-3 text-start font-medium">العميل</th>
                  <th scope="col" className="p-3 text-start font-medium">الطلبات</th>
                  <th scope="col" className="p-3 text-start font-medium">الإنفاق</th>
                  <th scope="col" className="p-3 text-start font-medium">النقاط</th>
                  <th scope="col" className="p-3 text-start font-medium">آخر طلب</th>
                  <th scope="col" className="p-3 text-start font-medium">إجراءات</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => (
                  <tr key={r.phone} className="border-b border-line last:border-0 align-top" data-testid="customer-row">
                    <td className="p-3">
                      <p className="font-semibold">{r.name || 'بدون اسم'}</p>
                      <p dir="ltr" className="lb-numeric text-start text-xs text-muted">{r.phone}</p>
                      {r.devices > 0 ? <Badge tone="success" className="mt-1">جهاز مؤكَّد</Badge> : null}
                    </td>
                    <td className="p-3 lb-numeric">{r.orders.toLocaleString('ar-EG')}</td>
                    <td className="p-3 lb-numeric">{formatMoney(r.spentCents, currency)}</td>
                    <td className="p-3 lb-numeric">{r.loyaltyEnabled ? r.points.toLocaleString('ar-EG') : '—'}</td>
                    <td className="p-3 text-muted">{dateLabel(r.lastOrderAt)}</td>
                    <td className="p-3">
                      <RowActions row={r} canManage={canManage} onOffer={setOfferFor} onReset={startReset} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Phones: one card per customer, so the actions are never scrolled away. */}
          <ul className="divide-y divide-line md:hidden">
            {visible.map((r) => (
              <li key={r.phone} className="space-y-3 p-4" data-testid="customer-card">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-bold">{r.name || 'بدون اسم'}</p>
                    <p dir="ltr" className="lb-numeric text-start text-xs text-muted">{r.phone}</p>
                  </div>
                  {r.devices > 0 ? <Badge tone="success">جهاز مؤكَّد</Badge> : null}
                </div>
                <dl className="grid grid-cols-3 gap-2 text-center">
                  <div className="rounded-lg bg-surface p-2"><dt className="text-[11px] text-muted">الطلبات</dt><dd className="lb-numeric font-bold">{r.orders.toLocaleString('ar-EG')}</dd></div>
                  <div className="rounded-lg bg-surface p-2"><dt className="text-[11px] text-muted">الإنفاق</dt><dd className="lb-numeric truncate text-sm font-bold">{formatMoney(r.spentCents, currency)}</dd></div>
                  <div className="rounded-lg bg-surface p-2"><dt className="text-[11px] text-muted">النقاط</dt><dd className="lb-numeric font-bold">{r.loyaltyEnabled ? r.points.toLocaleString('ar-EG') : '—'}</dd></div>
                </dl>
                <p className="text-xs text-muted">آخر طلب: {dateLabel(r.lastOrderAt)}</p>
                <RowActions row={r} canManage={canManage} onOffer={setOfferFor} onReset={startReset} />
              </li>
            ))}
          </ul>
          </>
        )}
      </Card>

      {offerFor ? (
        <OfferDialog
          key={offerFor.phone} customer={offerFor} currency={currency} orgSlug={orgSlug} storeName={storeName}
          onClose={() => setOfferFor(null)}
        />
      ) : null}

      <ConfirmDialog
        open={resetFor !== null}
        title="إزالة العميل وبصمة الجهاز"
        description={`سيُحذف ربط الأجهزة المؤكَّدة برقم ${resetFor?.phone ?? ''}، فيضطر العميل لتأكيد رقمه عبر واتساب من جديد عند فتح حسابه أو طلبه القادم. سجل طلباته ومبيعاتك يبقى كما هو.`}
        confirmLabel="إزالة"
        busy={isPending}
        onCancel={() => setResetFor(null)}
        onConfirm={confirmReset}
      >
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" checked={alsoRemove} onChange={(e) => setAlsoRemove(e.target.checked)} className="mt-0.5 h-4 w-4 accent-primary" />
          <span>إزالة سجل العميل المسجَّل يدويًا أيضًا (إن وُجد)</span>
        </label>
      </ConfirmDialog>
    </div>
  );
}

function RowActions({
  row, canManage, onOffer, onReset,
}: { row: DirectoryRow; canManage: boolean; onOffer: (r: DirectoryRow) => void; onReset: (r: DirectoryRow) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      <Button size="sm" onClick={() => onOffer(row)} className="bg-[#25D366] text-white hover:bg-[#1fb857]">
        <MessageCircle className="h-4 w-4" aria-hidden="true" /> إرسال عرض
      </Button>
      {canManage ? (
        <Button size="sm" variant="ghost" className="text-danger" onClick={() => onReset(row)}>
          <ShieldOff className="h-4 w-4" aria-hidden="true" /> إزالة العميل وبصمة الجهاز
        </Button>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line bg-elevated p-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="lb-numeric mt-0.5 truncate text-lg font-extrabold text-fg">{value}</p>
    </div>
  );
}

function OfferDialog({
  customer, currency, orgSlug, storeName, onClose,
}: {
  customer: DirectoryRow; currency: string; orgSlug: string; storeName: string; onClose: () => void;
}) {
  const toast = useToast();
  const [body, setBody] = useState(OFFER_TEMPLATES[0]!.body);
  const [templateId, setTemplateId] = useState<string>(OFFER_TEMPLATES[0]!.id);
  const [includeLink, setIncludeLink] = useState(true);
  const [link, setLink] = useState('');
  const [error, setError] = useState<string | null>(null);

  // The default link is this store's public menu.
  useEffect(() => { setLink(`${window.location.origin}/r/${orgSlug}`); }, [orgSlug]);

  const message = buildOfferMessage(body, {
    name: customer.name,
    store: storeName,
    points: customer.loyaltyEnabled ? customer.points : null,
    link: includeLink && link.trim() ? link.trim() : null,
  });
  const url = whatsappOfferUrl(customer.phone, message, currency);

  function send() {
    if (!url) {
      setError(
        !message ? 'اكتب نص الرسالة.'
        : message.length > MAX_OFFER_LENGTH ? `الرسالة أطول من ${MAX_OFFER_LENGTH} حرفًا.`
        : 'رقم هاتف العميل غير صالح لواتساب.',
      );
      return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
    toast.success('تم فتح واتساب بالرسالة جاهزة للإرسال');
    onClose();
  }

  return (
    <ConfirmDialog
      open
      tone="primary"
      title={`إرسال عرض إلى ${customer.name || customer.phone}`}
      description="تُفتح محادثة واتساب بالرسالة جاهزة، وأنت من يضغط إرسال. أرسل العروض لعملاء يقبلون استقبالها."
      confirmLabel="فتح واتساب"
      onCancel={onClose}
      onConfirm={send}
    >
      <div className="space-y-3">
        <ul className="flex flex-wrap gap-1.5" aria-label="قوالب جاهزة">
          {OFFER_TEMPLATES.map((t) => (
            <li key={t.id}>
              <button
                type="button" aria-pressed={templateId === t.id}
                onClick={() => { setTemplateId(t.id); setBody(t.body); setError(null); }}
                className={`h-8 rounded-full border px-3 text-xs font-bold ${
                  templateId === t.id ? 'border-primary bg-primary-soft text-primary' : 'border-line text-muted'
                }`}
              >
                {t.label}
              </button>
            </li>
          ))}
        </ul>

        <div>
          <label htmlFor="offer-body" className="mb-1 block text-xs font-semibold">نص الرسالة</label>
          <Textarea
            id="offer-body" value={body} maxLength={MAX_OFFER_LENGTH}
            onChange={(e) => { setBody(e.target.value); setTemplateId(''); setError(null); }}
            className="min-h-28" data-testid="offer-body"
          />
          <p className="mt-1 flex flex-wrap gap-1 text-[11px] text-muted">
            أدرج:
            {OFFER_VARIABLES.map((v) => (
              <button
                key={v.token} type="button" title={v.hint}
                onClick={() => setBody((b) => `${b}${b.endsWith(' ') || b.endsWith('\n') || b === '' ? '' : ' '}${v.token}`)}
                className="rounded bg-surface px-1.5 py-0.5 font-sans text-fg"
              >
                <bdi>{v.token}</bdi>
              </button>
            ))}
          </p>
        </div>

        <div className="space-y-1.5">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={includeLink} onChange={(e) => setIncludeLink(e.target.checked)} className="h-4 w-4 accent-primary" />
            إضافة رابط المتجر / الكوبون
          </label>
          {includeLink ? (
            <Input value={link} onChange={(e) => setLink(e.target.value)} dir="ltr" inputMode="url" aria-label="الرابط" placeholder="https://…" />
          ) : null}
        </div>

        <div>
          <p className="mb-1 text-xs font-semibold">معاينة</p>
          <pre
            className="max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-[#dcf8c6] p-3 font-sans text-sm leading-relaxed text-black"
            data-testid="offer-preview"
          >
            {message || '—'}
          </pre>
          <p className="lb-numeric mt-1 text-end text-[11px] text-muted">{message.length}/{MAX_OFFER_LENGTH}</p>
        </div>
        {error ? <p className="text-sm text-danger" role="alert">{error}</p> : null}
      </div>
    </ConfirmDialog>
  );
}
