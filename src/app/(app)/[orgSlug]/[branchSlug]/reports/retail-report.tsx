import { BarChart3 } from 'lucide-react';
import type { TenantContext } from '@/modules/core/tenancy/context';
import { getRetailReport } from '@/modules/retail/reports/service';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Money } from '@/components/patterns/money';
import { EmptyState } from '@/components/patterns/states';

const METHOD_LABELS: Record<string, string> = {
  cash: 'نقدي',
  card: 'بطاقة',
  transfer: 'تحويل',
  wallet: 'محفظة',
  online: 'أونلاين',
  other: 'أخرى',
};

const SOURCE_LABELS: Record<string, string> = {
  pos: 'نقطة البيع',
  online: 'المتجر الإلكتروني',
  back_office: 'إدخال يدوي',
};

function Stat({
  label, children, tone, hint,
}: {
  label: string;
  children: React.ReactNode;
  tone?: 'positive' | 'negative';
  hint?: string;
}) {
  return (
    <Card>
      <CardBody className="space-y-1">
        <p className="text-xs font-medium text-muted">{label}</p>
        <p
          className={
            tone === 'positive'
              ? 'text-xl font-bold text-success'
              : tone === 'negative'
                ? 'text-xl font-bold text-danger'
                : 'text-xl font-bold'
          }
        >
          {children}
        </p>
        {hint ? <p className="text-xs text-muted">{hint}</p> : null}
      </CardBody>
    </Card>
  );
}

/**
 * Retail analytics.
 *
 * Every number here was read back from a table that already held it — the
 * payments and treasury ledgers for money, the stock ledger for goods. None of
 * it is estimated, and a section the member may not see is simply absent
 * rather than blanked out.
 */
export async function RetailReport({
  ctx,
  range,
}: {
  ctx: TenantContext;
  range: { start: Date; end: Date };
}) {
  const report = await getRetailReport(ctx, range);

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="المبيعات المحصّلة">
          <Money cents={report.revenueCents} currency={ctx.currency} />
        </Stat>
        <Stat label="تكلفة البضاعة المباعة" hint="من التكلفة المسجّلة على كل حركة">
          <Money cents={report.cogsCents} currency={ctx.currency} />
        </Stat>
        <Stat
          label="مجمل الربح"
          tone={report.grossProfitCents >= 0 ? 'positive' : 'negative'}
        >
          <Money cents={report.grossProfitCents} currency={ctx.currency} />
        </Stat>
        <Stat label="متوسط قيمة البيع">
          <Money cents={report.averageSaleCents} currency={ctx.currency} />
        </Stat>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="عدد المبيعات">
          <span className="lb-numeric">{report.salesCount}</span>
        </Stat>
        <Stat label="وحدات بيعت">
          <span className="lb-numeric">{report.unitsSold}</span>
        </Stat>
        <Stat label="وحدات استُلمت">
          <span className="lb-numeric">{report.unitsReceived}</span>
        </Stat>
        <Stat label="مدفوعات خارجة">
          <Money cents={report.outflowCents} currency={ctx.currency} />
        </Stat>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>حسب طريقة الدفع</CardTitle>
          </CardHeader>
          {report.byPaymentMethod.length === 0 ? (
            <EmptyState icon={BarChart3} title="لا توجد مدفوعات في هذه الفترة" />
          ) : (
            <CardBody className="space-y-2 text-sm">
              {report.byPaymentMethod.map((m) => (
                <div key={m.method} className="flex justify-between">
                  <span className="text-muted">{METHOD_LABELS[m.method] ?? m.method}</span>
                  <Money cents={m.amountCents} currency={ctx.currency} />
                </div>
              ))}
            </CardBody>
          )}
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>حسب قناة البيع</CardTitle>
          </CardHeader>
          {report.bySource.length === 0 ? (
            <EmptyState icon={BarChart3} title="لا توجد مبيعات في هذه الفترة" />
          ) : (
            <CardBody className="space-y-2 text-sm">
              {report.bySource.map((s) => (
                <div key={s.source} className="flex items-center justify-between gap-2">
                  <span className="text-muted">{SOURCE_LABELS[s.source] ?? s.source}</span>
                  <span className="flex items-center gap-3">
                    <span className="lb-numeric text-xs text-muted">{s.count}</span>
                    <Money cents={s.amountCents} currency={ctx.currency} />
                  </span>
                </div>
              ))}
            </CardBody>
          )}
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>الأكثر مبيعًا</CardTitle>
          </CardHeader>
          {report.topProducts.length === 0 ? (
            <EmptyState icon={BarChart3} title="لا توجد مبيعات في هذه الفترة" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">المنتجات الأكثر مبيعًا</caption>
                <thead>
                  <tr className="border-b border-line text-xs text-muted">
                    <th scope="col" className="p-3 text-start font-medium">المنتج</th>
                    <th scope="col" className="p-3 text-start font-medium">الكمية</th>
                    <th scope="col" className="p-3 text-start font-medium">القيمة</th>
                  </tr>
                </thead>
                <tbody>
                  {report.topProducts.map((p) => (
                    <tr key={p.name} className="border-b border-line last:border-0">
                      <td className="p-3">{p.name}</td>
                      <td className="p-3 lb-numeric">{p.quantity}</td>
                      <td className="p-3">
                        <Money cents={p.amountCents} currency={ctx.currency} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>أصناف تحتاج إعادة طلب</CardTitle>
          </CardHeader>
          {report.lowStock.length === 0 ? (
            <EmptyState icon={BarChart3} title="لا توجد أصناف تحت حد إعادة الطلب" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">أصناف تحت حد إعادة الطلب</caption>
                <thead>
                  <tr className="border-b border-line text-xs text-muted">
                    <th scope="col" className="p-3 text-start font-medium">الصنف</th>
                    <th scope="col" className="p-3 text-start font-medium">المتاح</th>
                    <th scope="col" className="p-3 text-start font-medium">حد الطلب</th>
                  </tr>
                </thead>
                <tbody>
                  {report.lowStock.map((v) => (
                    <tr key={v.name} className="border-b border-line last:border-0">
                      <td className="p-3">{v.name}</td>
                      <td className="p-3 lb-numeric text-danger">{v.quantity}</td>
                      <td className="p-3 lb-numeric text-muted">{v.reorderPoint}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      {report.purchasing || report.storeOrders ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {report.purchasing ? (
            <Card>
              <CardHeader>
                <CardTitle>المشتريات</CardTitle>
              </CardHeader>
              <CardBody className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted">أوامر شراء</span>
                  <span className="lb-numeric">{report.purchasing.ordersRaised}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted">قيمة ملتزم بها</span>
                  <Money cents={report.purchasing.committedCents} currency={ctx.currency} />
                </div>
                <div className="flex justify-between">
                  <span className="text-muted">مدفوع للموردين</span>
                  <Money cents={report.purchasing.paidCents} currency={ctx.currency} />
                </div>
                <div className="flex justify-between">
                  <span className="text-muted">أوامر مفتوحة</span>
                  <span className="lb-numeric">{report.purchasing.openOrders}</span>
                </div>
              </CardBody>
            </Card>
          ) : null}

          {report.storeOrders ? (
            <Card>
              <CardHeader>
                <CardTitle>طلبات المتجر</CardTitle>
              </CardHeader>
              <CardBody className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted">طلبات واردة</span>
                  <span className="lb-numeric">{report.storeOrders.placed}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted">مكتملة</span>
                  <span className="lb-numeric text-success">{report.storeOrders.completed}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted">ملغاة</span>
                  <span className="lb-numeric text-danger">{report.storeOrders.cancelled}</span>
                </div>
              </CardBody>
            </Card>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
