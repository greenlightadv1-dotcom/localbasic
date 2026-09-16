import Link from 'next/link';
import {
  listExpiring, getDashboardStats, listRecentActivity, EXPIRY_WARNING_DAYS,
} from '@/modules/platform/billing/service';
import { AdminHeading, Panel, CustomerCode, ExpiryBadge, StatusBadge, formatDate } from './ui';
import { adminMetadata } from '@/modules/platform/admin/metadata';

export const generateMetadata = adminMetadata('لوحة المنصة');

/**
 * The operator's home screen.
 *
 * Every number here is counted in the database when the page is rendered —
 * there is no stored total, no cached aggregate and no sampled figure. A card
 * showing zero means zero rows matched, not that a metric is missing.
 */
export default async function PlatformDashboard() {
  const [stats, expiring, activity] = await Promise.all([
    getDashboardStats(EXPIRY_WARNING_DAYS),
    listExpiring(EXPIRY_WARNING_DAYS),
    listRecentActivity(12),
  ]);

  const cards: { label: string; value: number; tone?: 'danger' | 'warn' | 'success' }[] = [
    { label: 'إجمالي العملاء', value: stats.totalCustomers },
    { label: 'اشتراكات نشطة', value: stats.activeCustomers, tone: 'success' },
    { label: 'تجريبي', value: stats.trialing },
    {
      label: `تنتهي خلال ${EXPIRY_WARNING_DAYS} أيام`,
      value: stats.expiringSoon,
      tone: stats.expiringSoon > 0 ? 'warn' : undefined,
    },
    {
      label: 'منتهية',
      value: stats.expired,
      tone: stats.expired > 0 ? 'danger' : undefined,
    },
    { label: 'بلا اشتراك', value: stats.withoutSubscription },
    { label: 'إجمالي الفروع', value: stats.branchesTotal },
  ];

  return (
    <>
      <AdminHeading title="لوحة المنصة" lead="نظرة عامة على العملاء والاشتراكات." />

      <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {cards.map((c) => (
          <Panel key={c.label} className="p-4">
            <p className="text-xs text-muted">{c.label}</p>
            <p
              className={
                'mt-1 text-2xl font-extrabold ' +
                (c.tone === 'danger' ? 'text-danger'
                  : c.tone === 'warn' ? 'text-warn'
                  : c.tone === 'success' ? 'text-success'
                  : 'text-fg')
              }
            >
              {c.value.toLocaleString('ar-EG')}
            </p>
          </Panel>
        ))}
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Panel>
          <div className="flex items-center justify-between border-b border-line px-5 py-3">
            <h2 className="text-sm font-bold text-fg">
              اشتراكات تنتهي خلال {EXPIRY_WARNING_DAYS} أيام أو أقل
            </h2>
            <Link
              href="/admin/subscriptions"
              className="text-xs font-semibold text-primary hover:underline"
            >
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
                    href={`/admin/customers/${e.customerCode}`}
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

        <Panel>
          <div className="flex items-center justify-between border-b border-line px-5 py-3">
            <h2 className="text-sm font-bold text-fg">آخر نشاط على المنصة</h2>
            <Link href="/admin/audit" className="text-xs font-semibold text-primary hover:underline">
              السجل الكامل
            </Link>
          </div>

          {activity.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-muted">لا توجد أحداث بعد.</p>
          ) : (
            <ul className="divide-y divide-line">
              {activity.map((a, i) => (
                <li key={`${a.createdAt}-${i}`} className="flex flex-wrap items-center gap-2 px-5 py-2.5">
                  <span className="text-xs font-semibold text-fg" dir="ltr">{a.action}</span>
                  {a.customerCode ? (
                    <Link
                      href={`/admin/customers/${a.customerCode}`}
                      className="text-xs text-primary hover:underline"
                    >
                      {a.customerName ?? a.customerCode}
                    </Link>
                  ) : null}
                  <span className="ms-auto whitespace-nowrap text-xs text-muted">
                    {formatDate(a.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </>
  );
}
