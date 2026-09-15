import Link from 'next/link';
import { listPlans } from '@/modules/platform/billing/service';
import { listAvailableServices } from '@/modules/platform/services/service';
import { listLeads } from '@/modules/platform/leads/service';
import { ownerProvisioningAvailable, SERVICE_ROLE_ENV } from '@/modules/platform/onboarding/service';
import { adminMetadata } from '@/modules/platform/admin/metadata';
import { AdminHeading, Panel } from '../ui';
import { OnboardForm } from './onboard-form';

export const generateMetadata = adminMetadata('عميل جديد');

export default async function OnboardPage() {
  const [plans, services, leads] = await Promise.all([
    listPlans(),
    listAvailableServices(),
    listLeads({ status: 'qualified' }),
  ]);
  const canInvite = ownerProvisioningAvailable();

  return (
    <>
      <AdminHeading
        title="عميل جديد"
        lead="إنشاء مساحة عمل كاملة: المالك، الخدمة، الباقة، ومدة الاشتراك — في عملية واحدة."
      />

      {/* A missing credential is reported plainly. Nothing is faked, and the
          rest of the screen still works for an owner who already has an
          account. */}
      {!canInvite ? (
        <div className="mb-6 rounded-lg border border-warn/40 bg-warn/10 p-4">
          <h2 className="text-sm font-bold text-warn">إنشاء حسابات المالكين غير مُهيأ</h2>
          <p className="mt-1.5 text-sm leading-relaxed text-fg">
            دعوة مالك جديد بالبريد تحتاج مفتاح الخدمة على الخادم. اضبط متغير البيئة{' '}
            <code className="rounded bg-surface px-1.5 py-0.5 font-mono text-xs" dir="ltr">
              {SERVICE_ROLE_ENV}
            </code>{' '}
            في بيئة الخادم فقط — لا يُسبق أبدًا بـ{' '}
            <code className="rounded bg-surface px-1.5 py-0.5 font-mono text-xs" dir="ltr">
              NEXT_PUBLIC_
            </code>{' '}
            ولا يُودَع في المستودع.
          </p>
          <p className="mt-2 text-sm text-muted">
            حتى ذلك الحين يمكنك إنشاء مساحة عمل لمالك <strong className="text-fg">لديه حساب بالفعل</strong>.
          </p>
        </div>
      ) : null}

      {services.length === 0 ? (
        <Panel className="p-8 text-center">
          <p className="text-sm text-muted">
            لا توجد خدمة متاحة للبيع.{' '}
            <Link href="/admin/services" className="font-semibold text-primary hover:underline">
              أتِح خدمة أولًا
            </Link>
            .
          </p>
        </Panel>
      ) : (
        <Panel>
          <OnboardForm plans={plans} services={services} leads={leads} canInvite={canInvite} />
        </Panel>
      )}
    </>
  );
}
