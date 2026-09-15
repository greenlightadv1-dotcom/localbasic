import Link from 'next/link';
import { listOrganizations } from '@/modules/platform/billing/service';
import { AdminHeading, Panel, CustomerCode, ExpiryBadge, StatusBadge, formatDate, periodLabel } from '../ui';
import { adminMetadata } from '@/modules/platform/admin/metadata';

export const generateMetadata = adminMetadata('العملاء');

export default async function OrganizationsPage({
  searchParams,
}: {
  searchParams: { q?: string };
}) {
  const q = searchParams.q?.trim() ?? '';
  const orgs = await listOrganizations(q || undefined);

  return (
    <>
      <AdminHeading title="العملاء" lead="ابحث بكود العميل أو الاسم أو المعرّف." />

      {/* GET form: the search term lives in the URL, so a result list is
          shareable and the back button behaves. */}
      <form className="mb-4 flex gap-2" action="/admin/organizations">
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="LB-000125 أو اسم المطعم"
          className="h-11 flex-1 rounded border border-line bg-elevated px-3 text-sm text-fg outline-none focus-visible:border-primary"
        />
        <button
          type="submit"
          className="h-11 rounded bg-primary px-5 text-sm font-semibold text-primary-fg hover:bg-primary/90"
        >
          بحث
        </button>
      </form>

      <Panel>
        {orgs.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-muted">
            {q ? `لا نتائج لـ «${q}».` : 'لا يوجد عملاء بعد.'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-line bg-surface text-xs text-muted">
                <tr>
                  <th className="px-4 py-2.5 text-start font-semibold">كود العميل</th>
                  <th className="px-4 py-2.5 text-start font-semibold">المطعم</th>
                  <th className="px-4 py-2.5 text-start font-semibold">الباقة</th>
                  <th className="px-4 py-2.5 text-start font-semibold">المدة</th>
                  <th className="px-4 py-2.5 text-start font-semibold">الحالة</th>
                  <th className="px-4 py-2.5 text-start font-semibold">ينتهي</th>
                  <th className="px-4 py-2.5 text-start font-semibold">المتبقي</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {orgs.map((o) => (
                  <tr key={o.id} className="hover:bg-surface">
                    <td className="px-4 py-3"><CustomerCode code={o.customerCode} /></td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/admin/organizations/${o.customerCode}`}
                        className="font-semibold text-fg hover:text-primary"
                      >
                        {o.name}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-muted">{o.planNameAr ?? '—'}</td>
                    <td className="px-4 py-3 text-muted">{periodLabel(o.billingPeriod)}</td>
                    <td className="px-4 py-3"><StatusBadge status={o.subscriptionStatus} /></td>
                    <td className="px-4 py-3 text-muted">{formatDate(o.currentPeriodEnd)}</td>
                    <td className="px-4 py-3"><ExpiryBadge daysLeft={o.daysLeft} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
