import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowRight } from 'lucide-react';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { getBranding } from '@/modules/core/branding/service';
import { Button } from '@/components/ui/button';
import { Money } from '@/components/patterns/money';
import { PrintButton } from '../../tables/[tableId]/qr/print-button';
import { RECEIPT_DISCLAIMER_AR } from '@/modules/core/legal/receipt';

export const metadata = { title: 'إيصال' };
export const dynamic = 'force-dynamic';

const METHODS: Record<string, string> = {
  cash: 'نقدي',
  card: 'بطاقة',
  transfer: 'تحويل',
  wallet: 'محفظة',
  online: 'أونلاين',
  other: 'أخرى',
};

/**
 * A printable receipt, laid out for an 80mm thermal roll.
 *
 * It is a RECEIPT (إيصال): a record of what the guest paid. It does not
 * present itself as an Egyptian tax invoice and makes no tax-authority claim,
 * and since this is the document actually handed to a customer it carries the
 * disclaimer saying so — the same wording every other customer-facing
 * financial surface uses, from one definition in Core.
 *
 * Every figure below is read from `invoices` and `payments` by this Server
 * Component. Nothing is passed in, computed in the browser, or recovered from
 * a URL: the receipt says what the database recorded.
 */
export default async function ReceiptPage({
  params,
}: {
  params: { orgSlug: string; branchSlug: string; invoiceId: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  if (!can(ctx, 'invoice.read')) notFound();

  const supabase = createSupabaseServerClient();

  const { data: receipt } = await supabase
    .from('invoices')
    .select(
      'id, number, status, currency, subtotal_cents, discount_cents, tax_cents, total_cents, paid_cents, notes, created_at',
    )
    .eq('organization_id', ctx.organizationId)
    .eq('id', params.invoiceId)
    .maybeSingle();

  if (!receipt) notFound();

  const [{ data: items }, { data: payments }, branding] = await Promise.all([
    supabase
      .from('invoice_items')
      .select('id, description, quantity, unit_price_cents, total_cents')
      .eq('invoice_id', receipt.id)
      .order('position'),
    can(ctx, 'payment.read')
      ? supabase
          .from('payments')
          .select('id, method, amount_cents, kind, created_at')
          .eq('invoice_id', receipt.id)
          .order('created_at')
      : Promise.resolve({ data: [] }),
    getBranding(ctx),
  ]);

  const base = `/${ctx.organizationSlug}/${ctx.branchSlug}`;

  return (
    <div className="mx-auto max-w-sm space-y-4">
      <div className="flex items-center justify-between print:hidden">
        <Link href={`${base}/invoices`}>
          <Button variant="ghost" size="sm">
            <ArrowRight className="h-4 w-4 lb-flip" aria-hidden="true" />
            الإيصالات
          </Button>
        </Link>
        <PrintButton />
      </div>

      <article className="rounded-lg border border-line bg-white p-6 text-[#0E1330] print:border-0 print:p-0">
        <header className="border-b border-dashed border-current/20 pb-4 text-center">
          <h1 className="text-lg font-bold">{branding.displayName}</h1>
          <p className="text-sm opacity-70">{ctx.branchName}</p>
          {branding.phone && (
            <p className="lb-numeric text-xs opacity-70">{branding.phone}</p>
          )}
          <p className="mt-3 text-sm font-semibold">إيصال</p>
          <p className="lb-numeric text-xs opacity-70">{receipt.number}</p>
          <p className="lb-numeric text-xs opacity-70">
            {new Date(receipt.created_at).toLocaleString('ar-EG')}
          </p>
        </header>

        <table className="my-4 w-full text-sm">
          <caption className="sr-only">أصناف الإيصال</caption>
          <tbody>
            {(items ?? []).map((item) => (
              <tr key={item.id} className="align-top">
                <td className="py-1">
                  <span className="lb-numeric me-1">{Number(item.quantity)}×</span>{' '}
                  <bdi>{item.description}</bdi>
                </td>
                <td className="py-1 text-end">
                  <Money cents={item.total_cents} currency={receipt.currency} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <dl className="space-y-1 border-t border-dashed border-current/20 pt-3 text-sm">
          <div className="flex justify-between">
            <dt className="opacity-70">المجموع</dt>
            <dd>
              <Money cents={receipt.subtotal_cents} currency={receipt.currency} />
            </dd>
          </div>
          {receipt.discount_cents > 0 && (
            <div className="flex justify-between">
              <dt className="opacity-70">الخصم</dt>
              <dd>
                − <Money cents={receipt.discount_cents} currency={receipt.currency} />
              </dd>
            </div>
          )}
          <div className="flex justify-between">
            <dt className="opacity-70">الضريبة</dt>
            <dd>
              <Money cents={receipt.tax_cents} currency={receipt.currency} />
            </dd>
          </div>
          <div className="flex justify-between border-t border-current/20 pt-2 text-base font-bold">
            <dt>الإجمالي</dt>
            <dd>
              <Money cents={receipt.total_cents} currency={receipt.currency} />
            </dd>
          </div>
        </dl>

        {(payments ?? []).length > 0 && (
          <ul className="mt-3 space-y-1 border-t border-dashed border-current/20 pt-3 text-sm">
            {(payments ?? []).map((payment) => (
              <li key={payment.id} className="flex justify-between">
                <span className="opacity-70">
                  {payment.kind === 'refund' ? 'مرتجع' : 'مدفوع'} · {METHODS[payment.method] ?? payment.method}
                </span>
                <Money cents={Math.abs(payment.amount_cents)} currency={receipt.currency} />
              </li>
            ))}
          </ul>
        )}

        {receipt.total_cents > receipt.paid_cents && (
          <p className="mt-3 flex justify-between border-t border-current/20 pt-2 text-sm font-bold">
            <span>المتبقي</span>
            <Money cents={receipt.total_cents - receipt.paid_cents} currency={receipt.currency} />
          </p>
        )}

        {/*
          Required wording on every customer-facing financial document.
          LocalBasic issues receipts, never Egyptian tax invoices, and says so
          in print as well as on screen. Do not reword without instruction —
          see src/modules/core/legal/receipt.ts.
        */}
        <p
          className="mt-4 border-t border-dashed border-current/20 pt-3 text-[10px] leading-relaxed opacity-70"
          data-testid="receipt-disclaimer"
        >
          {RECEIPT_DISCLAIMER_AR}
        </p>

        <footer className="mt-5 border-t border-dashed border-current/20 pt-4 text-center text-xs opacity-70">
          <p>شكرًا لزيارتكم</p>
          {!branding.whiteLabel && (
            <p className="mt-2">مدعوم بواسطة LocalBasic — A Green Light Company</p>
          )}
        </footer>
      </article>
    </div>
  );
}
