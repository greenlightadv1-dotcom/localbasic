import Link from 'next/link';
import { listExpiring, listOrganizations, EXPIRY_WARNING_DAYS } from '@/modules/platform/billing/service';
import { AdminHeading, Panel, CustomerCode, ExpiryBadge, StatusBadge, formatDate } from './ui';
import { adminMetadata } from '@/modules/platform/admin/metadata';

export const generateMetadata = adminMetadata('لوحة المنصة');

export default async function PlatformDashboard() {
  const [orgs, expiring] = await Promise.all([listOrganizations(), listExpiring(EXPIRY_WARNING_DAYS)]);

  const active = orgs.filter((o) => o.subscriptionStatus === 'active').length;
  const trialing = orgs.filter((o) => o.subscriptionStatus === 'trialing').length;
  const lapsed = orgs.filter((o) => o.daysLeft !== null && o.daysLeft < 0).length;

  return (
    <>
      <AdminHeading title="لوحة المنصة" lead="نظرة عامة على العملاء والاشتراكات." />

      <div className="grid gap-4 sm:grid-cols-4">
        {[
          ['إجمالي العملاء', orgs.length],
          ['اشتراكات نشطة', active],
          ['تجريبي', trialing],
          ['منتهية', lapsed],
        ].map(([label, value]) => (
          <Panel key={label as string} className="p-4">
            <p className="text-xs text-muted">{label}</p>
            <p className="mt-1 text-2xl font-extrabold text-fg">{value as number}</p>
          </Panel>
        ))}
      </div>

      <Panel className="mt-6">
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <h2 className="text-sm font-bold text-fg">
            اشتراكات تنتهي خلال {EXPIRY_WARNING_DAYS} أيام أو أقل
          </h2>
          <Link href="/admin/subscriptions" className="text-xs font-semibold text-primary hover:underline">
            كل الاشتراكات
          </Link>
        </div>

        {expiring.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-muted">
            لا توجد اشتراكات على وشك الانتهاء.
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {expiring.map((e) => (
              <li key={e.organizationId} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <CustomerCode code={e.customerCode} />
                <Link
                  href={`/admin/organizations/${e.customerCode}`}
                  className="font-semibold text-fg hover:text-primary"
                >
                  {e.organizationName}
                </Link>
                <StatusBadge status={e.status} />
                <span className="text-xs text-muted">حتى {formatDate(e.currentPeriodEnd)}</span>
                <span className="ms-auto"><ExpiryBadge daysLeft={e.daysLeft} /></span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
}
