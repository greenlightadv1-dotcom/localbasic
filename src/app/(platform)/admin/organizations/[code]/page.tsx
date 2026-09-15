import { notFound } from 'next/navigation';
import {
  getOrganizationByCode, listSubscriptionHistory, listPlans,
} from '@/modules/platform/billing/service';
import {
  AdminHeading, Panel, CustomerCode, ExpiryBadge, StatusBadge,
  formatDate, periodLabel, money,
} from '../../ui';
import { RenewForm } from './renew-form';

export async function generateMetadata({ params }: { params: { code: string } }) {
  return { title: params.code };
}

const EVENT_LABEL: Record<string, string> = {
  created: 'إنشاء',
  renewed: 'تجديد',
  plan_changed: 'تغيير باقة',
  trial_granted: 'منح تجربة',
  cancelled: 'إلغاء',
  expired: 'انتهاء',
};

const METHOD_LABEL: Record<string, string> = {
  cash: 'نقدي', card: 'بطاقة', wallet: 'محفظة',
  transfer: 'تحويل', gateway: 'بوابة دفع', none: '—',
};

export default async function CustomerProfilePage({ params }: { params: { code: string } }) {
  const org = await getOrganizationByCode(decodeURIComponent(params.code));
  if (!org) notFound();

  const [history, plans] = await Promise.all([
    listSubscriptionHistory(org.id),
    listPlans(),
  ]);

  const currentPlanId = plans.find((p) => p.key === org.planKey)?.id ?? null;

  return (
    <>
      <AdminHeading title={org.name} />

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <CustomerCode code={org.customerCode} />
        <StatusBadge status={org.subscriptionStatus} />
        <ExpiryBadge daysLeft={org.daysLeft} />
        <span className="text-xs text-muted">/{org.slug}</span>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_1.2fr]">
        <Panel>
          <h2 className="border-b border-line px-5 py-3 text-sm font-bold text-fg">
            الاشتراك الحالي
          </h2>
          <dl className="divide-y divide-line text-sm">
            {[
              ['الباقة', org.planNameAr ?? '—'],
              ['المدة', periodLabel(org.billingPeriod)],
              ['ينتهي في', formatDate(org.currentPeriodEnd)],
              ['الخدمة', org.primaryModule === 'restaurant' ? 'مطاعم وكافيهات' : org.primaryModule],
              ['بداية التعامل', formatDate(org.createdAt)],
            ].map(([k, v]) => (
              <div key={k} className="flex items-center justify-between px-5 py-2.5">
                <dt className="text-muted">{k}</dt>
                <dd className="font-semibold text-fg">{v}</dd>
              </div>
            ))}
          </dl>
        </Panel>

        <Panel>
          <h2 className="border-b border-line px-5 py-3 text-sm font-bold text-fg">
            تجديد الاشتراك
          </h2>
          <RenewForm organizationId={org.id} plans={plans} currentPlanId={currentPlanId} />
        </Panel>
      </div>

      <Panel className="mt-6">
        <h2 className="border-b border-line px-5 py-3 text-sm font-bold text-fg">
          سجل الاشتراكات
          <span className="ms-2 font-normal text-muted">لا يُعدّل ولا يُحذف</span>
        </h2>
        {history.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-muted">لا يوجد سجل بعد.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-line bg-surface text-xs text-muted">
                <tr>
                  <th className="px-4 py-2.5 text-start font-semibold">التاريخ</th>
                  <th className="px-4 py-2.5 text-start font-semibold">الحدث</th>
                  <th className="px-4 py-2.5 text-start font-semibold">الباقة</th>
                  <th className="px-4 py-2.5 text-start font-semibold">المدة</th>
                  <th className="px-4 py-2.5 text-start font-semibold">حتى</th>
                  <th className="px-4 py-2.5 text-start font-semibold">الإجمالي</th>
                  <th className="px-4 py-2.5 text-start font-semibold">الخصم</th>
                  <th className="px-4 py-2.5 text-start font-semibold">المدفوع</th>
                  <th className="px-4 py-2.5 text-start font-semibold">الطريقة</th>
                  <th className="px-4 py-2.5 text-start font-semibold">الرمز</th>
                  <th className="px-4 py-2.5 text-start font-semibold">بواسطة</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {history.map((e) => (
                  <tr key={e.id} className="hover:bg-surface">
                    <td className="whitespace-nowrap px-4 py-3 text-muted">{formatDate(e.createdAt)}</td>
                    <td className="px-4 py-3 font-semibold text-fg">{EVENT_LABEL[e.eventType] ?? e.eventType}</td>
                    <td className="px-4 py-3 text-muted">{e.planNameAr ?? '—'}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-muted">{periodLabel(e.billingPeriod)}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-muted">{formatDate(e.periodEnd)}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-muted">{money(e.grossCents, e.currency)}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-muted">
                      {e.discountCents > 0 ? `− ${money(e.discountCents, e.currency)}` : '—'}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 font-bold text-fg">{money(e.netCents, e.currency)}</td>
                    <td className="px-4 py-3 text-muted">{METHOD_LABEL[e.paymentMethod] ?? e.paymentMethod}</td>
                    <td className="px-4 py-3 text-muted" dir="ltr">{e.promoCode ?? '—'}</td>
                    <td className="px-4 py-3 text-muted">{e.createdByLabel ?? '—'}</td>
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
