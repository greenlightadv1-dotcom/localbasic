'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CheckCircle2, ExternalLink, FileText, Loader2, RefreshCw, ShoppingCart, Truck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/patterns/states';
import { useToast } from '@/components/ui/toast';
import { formatMoney } from '@/lib/money';
import type { ReorderSuggestion } from '@/modules/retail/operations/service';
import { generateReorderAction } from './actions';
import type { Scope } from './inventory-workspace';

const qty = (n: number) => new Intl.NumberFormat('ar-EG', { maximumFractionDigits: 3 }).format(n);
const NO_SUPPLIER = '__none__';

/**
 * Variants at or under their reorder point here, grouped by preferred
 * supplier. "Create purchase orders" writes one draft per group in the
 * database (retail_reorder_generate); items already on an open order for this
 * branch are left out, so pressing it twice creates nothing new.
 */
export function ReorderPanel({ scope, currency, suggestions, suppliers, canGenerate }: {
  scope: Scope; currency: string; suggestions: ReorderSuggestion[]; suppliers: Record<string, string>; canGenerate: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<{ orderId: string; number: string; supplierId: string | null; lines: number }[] | null>(null);
  const money = (c: number) => formatMoney(c, currency);

  const groups = useMemo(() => {
    const map = new Map<string, ReorderSuggestion[]>();
    for (const s of suggestions) {
      const key = s.supplierId ?? NO_SUPPLIER;
      map.set(key, [...(map.get(key) ?? []), s]);
    }
    return [...map].map(([key, rows]) => ({
      key,
      name: key === NO_SUPPLIER ? 'بدون مورد مفضل' : suppliers[key] ?? 'مورد',
      rows,
      totalCents: rows.reduce((sum, r) => sum + Math.round(r.suggestedQty * r.unitCostCents), 0),
    })).sort((a, b) => (a.key === NO_SUPPLIER ? 1 : b.key === NO_SUPPLIER ? -1 : a.name.localeCompare(b.name, 'ar')));
  }, [suggestions, suppliers]);

  const grand = groups.reduce((s, g) => s + g.totalCents, 0);

  async function generate() {
    setBusy(true);
    setError(null);
    const r = await generateReorderAction(scope, {});
    setBusy(false);
    if (!r.ok) {
      setError(r.code === 'forbidden' || r.code === 'not_found' ? 'لا تملك صلاحية إنشاء أوامر الشراء.' : r.error);
      return;
    }
    setDrafts(r.data);
    toast.success(r.data.length ? `أُنشئ ${r.data.length} أمر شراء بالمسودة` : 'لا جديد: الأصناف على أوامر مفتوحة بالفعل');
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-elevated p-4">
        <div className="space-y-0.5">
          <p className="font-semibold">{suggestions.length} صنف تحت حد إعادة الطلب</p>
          <p className="text-sm text-muted">القيمة التقديرية بسعر التكلفة <span className="lb-numeric font-medium text-fg">{money(grand)}</span> · {groups.length} مورد</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" disabled={refreshing} onClick={() => { setRefreshing(true); router.refresh(); setTimeout(() => setRefreshing(false), 600); }}>
            <RefreshCw className={refreshing ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} aria-hidden="true" /> تحديث
          </Button>
          {canGenerate && (
            <Button disabled={busy || suggestions.length === 0} onClick={() => void generate()} data-testid="reorder-generate">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <FileText className="h-4 w-4" aria-hidden="true" />} إنشاء أوامر الشراء
            </Button>
          )}
        </div>
      </div>

      {error && <Alert tone="danger">{error}</Alert>}
      {!canGenerate && suggestions.length > 0 && <Alert tone="info">إنشاء أوامر الشراء يحتاج صلاحية إدارة المشتريات.</Alert>}

      {drafts && drafts.length > 0 && (
        <Alert tone="success" title="أوامر شراء جديدة (مسودة)">
          <ul className="mt-1 space-y-1">
            {drafts.map((d) => (
              <li key={d.orderId} className="flex flex-wrap items-center gap-2">
                <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                <span className="lb-numeric font-semibold">{d.number}</span>
                <span>· {d.supplierId ? suppliers[d.supplierId] ?? 'مورد' : 'بدون مورد'} · {d.lines} صنف</span>
              </li>
            ))}
          </ul>
          <Link href={`/${scope.organizationSlug}/${scope.branchSlug}/purchases`} className="mt-2 inline-flex items-center gap-1 text-sm font-medium underline">
            مراجعة وإرسال من المشتريات <ExternalLink className="h-3 w-3" aria-hidden="true" />
          </Link>
        </Alert>
      )}

      {suggestions.length === 0 ? (
        <div className="rounded-lg border border-line bg-elevated">
          <EmptyState icon={ShoppingCart} title="لا أصناف تحت حد إعادة الطلب"
            description="حدّد حد إعادة الطلب وكمية الطلب والمورد المفضل من صفحة الصنف لتظهر الاقتراحات هنا." />
        </div>
      ) : (
        groups.map((g) => (
          <section key={g.key} className="overflow-hidden rounded-lg border border-line bg-elevated" aria-label={g.name}>
            <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-surface px-4 py-2.5">
              <h3 className="flex items-center gap-2 text-sm font-semibold">
                <Truck className="h-4 w-4 text-primary" aria-hidden="true" /> {g.name}
                <Badge>{g.rows.length}</Badge>
                {g.key === NO_SUPPLIER && <Badge tone="warn">يُعيَّن المورد في المسودة</Badge>}
              </h3>
              <span className="text-sm">الإجمالي <span className="lb-numeric font-semibold">{money(g.totalCents)}</span></span>
            </header>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[40rem] text-sm">
                <thead className="text-xs text-muted">
                  <tr>
                    <th className="px-4 py-2 text-start font-medium">الصنف</th>
                    <th className="px-4 py-2 text-start font-medium">الرصيد</th>
                    <th className="px-4 py-2 text-start font-medium">حد الطلب</th>
                    <th className="px-4 py-2 text-start font-medium">المقترح</th>
                    <th className="px-4 py-2 text-start font-medium">تكلفة الوحدة</th>
                    <th className="px-4 py-2 text-start font-medium">القيمة</th>
                  </tr>
                </thead>
                <tbody>
                  {g.rows.map((r) => (
                    <tr key={r.variantId} className="border-t border-line">
                      <td className="px-4 py-2">{r.productName}{r.variantName !== 'default' && <span className="text-muted"> — {r.variantName}</span>}</td>
                      <td className={r.onHand <= 0 ? 'px-4 py-2 lb-numeric font-semibold text-danger' : 'px-4 py-2 lb-numeric text-warn'}>{qty(r.onHand)}</td>
                      <td className="px-4 py-2 lb-numeric text-muted">{qty(r.reorderPoint)}</td>
                      <td className="px-4 py-2 lb-numeric font-semibold">{qty(r.suggestedQty)}</td>
                      <td className="px-4 py-2 lb-numeric">{money(r.unitCostCents)}</td>
                      <td className="px-4 py-2 lb-numeric">{money(Math.round(r.suggestedQty * r.unitCostCents))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))
      )}
    </div>
  );
}
