import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { getGuestOrder } from '@/modules/retail/store/service';
import { RECEIPT_DISCLAIMER_AR, RECEIPT_TERM_AR } from '@/modules/core/legal/receipt';
import { Money } from '@/components/patterns/money';
import { Badge } from '@/components/ui/badge';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'متابعة الطلب',
  // A token in a URL must never end up in a search index.
  robots: { index: false, follow: false },
};

const STATUS_AR: Record<string, string> = {
  placed: 'تم استلام الطلب',
  confirmed: 'تم تأكيد الطلب',
  packed: 'جارٍ التجهيز',
  fulfilled: 'تم التسليم',
  completed: 'مكتمل',
  cancelled: 'ملغي',
};

const FULFILLMENT_AR: Record<string, string> = {
  pickup: 'استلام من الفرع',
  delivery: 'توصيل',
};

const PAYMENT_AR: Record<string, string> = {
  cash_on_delivery: 'الدفع عند الاستلام',
  pay_on_collection: 'الدفع عند الاستلام من الفرع',
};

/**
 * One order, for the guest who placed it.
 *
 * The token in the URL is the whole authorisation, and it reaches exactly this
 * order: the database projection behind it selects by token and returns
 * nothing else — no other order, no customer record, nothing about the shop's
 * finances.
 */
export default async function TrackOrderPage({
  params,
}: {
  params: { token: string };
}) {
  const order = await getGuestOrder(params.token);
  // A wrong token and a deleted order are the same answer.
  if (!order) notFound();

  const cancelled = order.status === 'cancelled';

  return (
    <main className="mx-auto max-w-2xl px-4 py-8" dir="rtl">
      <header className="mb-5">
        <p className="text-sm text-muted">{order.organizationName}</p>
        <h1 className="text-xl font-bold text-fg">
          طلب رقم <span dir="ltr">{order.number}</span>
        </h1>
      </header>

      <div className="mb-5 flex flex-wrap items-center gap-2">
        <Badge tone={cancelled ? 'danger' : order.status === 'completed' ? 'success' : 'info'}>
          {STATUS_AR[order.status] ?? order.status}
        </Badge>
        <Badge tone="neutral">{FULFILLMENT_AR[order.fulfillment] ?? order.fulfillment}</Badge>
        <Badge tone="neutral">{PAYMENT_AR[order.paymentMethod] ?? order.paymentMethod}</Badge>
      </div>

      <section
        aria-label={RECEIPT_TERM_AR}
        className="rounded border border-line bg-elevated p-4"
      >
        <h2 className="mb-3 text-sm font-bold text-fg">{RECEIPT_TERM_AR}</h2>

        <table className="w-full text-sm">
          <caption className="sr-only">أصناف الطلب</caption>
          <thead>
            <tr className="border-b border-line text-xs text-muted">
              <th scope="col" className="py-2 text-start font-medium">الصنف</th>
              <th scope="col" className="py-2 text-start font-medium">الكمية</th>
              <th scope="col" className="py-2 text-start font-medium">الإجمالي</th>
            </tr>
          </thead>
          <tbody>
            {order.lines.map((l, i) => (
              <tr key={`${l.productName}-${i}`} className="border-b border-line last:border-0">
                <td className="py-2">
                  {l.productName}
                  {l.variantName && l.variantName !== 'default' ? (
                    <span className="text-muted"> — {l.variantName}</span>
                  ) : null}
                </td>
                <td className="py-2 lb-numeric">{l.quantity}</td>
                <td className="py-2">
                  <Money cents={l.lineTotalCents} currency={order.currency} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="mt-3 flex items-center justify-between border-t border-line pt-3 font-bold">
          <span>الإجمالي</span>
          <Money cents={order.totalCents} currency={order.currency} />
        </div>
      </section>

      {/*
        Required wording. LocalBasic issues receipts, never Egyptian tax
        invoices, and says so on every customer-facing financial document.
      */}
      <p className="mt-4 text-xs leading-relaxed text-muted">{RECEIPT_DISCLAIMER_AR}</p>
    </main>
  );
}
