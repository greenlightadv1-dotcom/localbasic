import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ReceiptText } from 'lucide-react';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { PageHeader } from '@/components/patterns/page-header';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Money } from '@/components/patterns/money';
import { EmptyState } from '@/components/patterns/states';

export const metadata = { title: 'الإيصالات' };
export const dynamic = 'force-dynamic';

const STATUS: Record<string, { label: string; tone: 'neutral' | 'success' | 'warn' | 'danger' }> = {
  draft: { label: 'مسودة', tone: 'neutral' },
  issued: { label: 'غير محصّل', tone: 'warn' },
  partially_paid: { label: 'محصّل جزئيًا', tone: 'warn' },
  paid: { label: 'محصّل', tone: 'success' },
  void: { label: 'ملغي', tone: 'danger' },
};

/**
 * Receipts issued to guests. The word is deliberate: these are receipts
 * (إيصالات), not tax invoices, and nothing here claims tax-authority status.
 */
export default async function ReceiptsPage({
  params,
}: {
  params: { orgSlug: string; branchSlug: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  if (!can(ctx, 'invoice.read')) notFound();

  const supabase = createSupabaseServerClient();
  const { data: receipts } = await supabase
    .from('invoices')
    .select('id, number, status, total_cents, paid_cents, created_at, source, customer_id')
    .eq('organization_id', ctx.organizationId)
    .eq('branch_id', ctx.branchId)
    .order('created_at', { ascending: false })
    .limit(100);

  const base = `/${ctx.organizationSlug}/${ctx.branchSlug}`;
  const rows = receipts ?? [];
  const total = rows
    .filter((r) => r.status === 'paid')
    .reduce((sum, r) => sum + r.total_cents, 0);

  return (
    <div className="space-y-5">
      <PageHeader
        title="الإيصالات"
        description={`${rows.length} إيصال — إجمالي المحصّل ${(total / 100).toLocaleString('ar-EG')} ${ctx.currency}`}
      />

      <Card>
        {rows.length === 0 ? (
          <EmptyState
            icon={ReceiptText}
            title="لا توجد إيصالات"
            description="سيصدر إيصال تلقائيًا عند تحصيل أي طلب."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">الإيصالات الصادرة</caption>
              <thead>
                <tr className="border-b border-line text-xs text-muted">
                  <th scope="col" className="p-3 text-start font-medium">رقم الإيصال</th>
                  <th scope="col" className="p-3 text-start font-medium">المصدر</th>
                  <th scope="col" className="p-3 text-start font-medium">الإجمالي</th>
                  <th scope="col" className="p-3 text-start font-medium">المحصّل</th>
                  <th scope="col" className="p-3 text-start font-medium">الحالة</th>
                  <th scope="col" className="p-3 text-start font-medium">التاريخ</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((receipt) => {
                  const status = STATUS[receipt.status] ?? STATUS.issued!;
                  return (
                    <tr key={receipt.id} className="border-b border-line last:border-0 hover:bg-surface">
                      <td className="p-3">
                        <Link
                          href={`${base}/invoices/${receipt.id}`}
                          className="lb-numeric font-semibold text-primary hover:underline"
                        >
                          {receipt.number}
                        </Link>
                      </td>
                      <td className="p-3 text-muted">
                        {receipt.source === 'restaurant' ? 'طلب مطعم' : receipt.source}
                      </td>
                      <td className="p-3">
                        <Money cents={receipt.total_cents} currency={ctx.currency} />
                      </td>
                      <td className="p-3">
                        <Money cents={receipt.paid_cents} currency={ctx.currency} />
                      </td>
                      <td className="p-3">
                        <Badge tone={status.tone}>{status.label}</Badge>
                      </td>
                      <td className="p-3 lb-numeric text-muted">
                        {new Date(receipt.created_at).toLocaleString('ar-EG', {
                          day: '2-digit',
                          month: '2-digit',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
