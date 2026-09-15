import Link from 'next/link';
import { listOrganizations, listExpiring, EXPIRY_WARNING_DAYS } from '@/modules/platform/billing/service';
import { AdminHeading, Panel, CustomerCode, ExpiryBadge, StatusBadge, formatDate, periodLabel } from '../ui';
import { adminMetadata } from '@/modules/platform/admin/metadata';

export const generateMetadata = adminMetadata('الاشتراكات');

export default async function SubscriptionsPage() {
  const [orgs, expiring] = await Promise.all([listOrganizations(), listExpiring(EXPIRY_WARNING_DAYS)]);
  const expiringIds = new Set(expiring.map((e) => e.organizationId));

  // Soonest expiry first: the ones needing a call today are at the top.
  const rows = [...orgs]
    .filter((o) => o.subscriptionStatus !== null)
    .sort((a, b) => (a.daysLeft ?? 1e9) - (b.daysLeft ?? 1e9));

  return (
    <>
      <AdminHeading
        title="الاشتراكات"
        lead={`مرتبة بالأقرب انتهاءً. التنبيه يظهر عند ${EXPIRY_WARNING_DAYS} أيام أو أقل.`}
      />
      <Panel>
        {rows.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-muted">لا توجد اشتراكات.</p>
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
                  <th className="px-4 py-2.5 text-start font-semibold"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((o) => (
                  <tr key={o.id} className={expiringIds.has(o.id) ? 'bg-danger/5' : 'hover:bg-surface'}>
                    <td className="px-4 py-3"><CustomerCode code={o.customerCode} /></td>
                    <td className="px-4 py-3 font-semibold text-fg">{o.name}</td>
                    <td className="px-4 py-3 text-muted">{o.planNameAr ?? '—'}</td>
                    <td className="px-4 py-3 text-muted">{periodLabel(o.billingPeriod)}</td>
                    <td className="px-4 py-3"><StatusBadge status={o.subscriptionStatus} /></td>
                    <td className="whitespace-nowrap px-4 py-3 text-muted">{formatDate(o.currentPeriodEnd)}</td>
                    <td className="px-4 py-3"><ExpiryBadge daysLeft={o.daysLeft} /></td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/admin/organizations/${o.customerCode}`}
                        className="text-xs font-semibold text-primary hover:underline"
                      >
                        تجديد
                      </Link>
                    </td>
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
