import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  getOrganizationByCode, listSubscriptionHistory, listPlans,
  listCustomerBranches, listCustomerModules, listCustomerAudit, listCustomerDomains,
} from '@/modules/platform/billing/service';
import { listCustomerStaff, listCustomerRoleCatalog } from '@/modules/platform/staff/service';
import {
  AdminHeading, Panel, CustomerCode, ExpiryBadge, StatusBadge,
  formatDate, periodLabel, money,
} from '../../ui';
import { RenewForm } from './renew-form';
import { AdjustDaysForm, SwitchPlanForm } from './subscription-ops-form';
import { DangerZone } from './danger-zone';
import { StaffRoles } from './staff-roles';

import { getPlatformContext } from '@/modules/platform/admin/context';

/**
 * The customer code is the title here, so it must not appear for anyone who is
 * not an admin — a tenant probing a code would otherwise see it echoed back.
 */
export async function generateMetadata({ params }: { params: { code: string } }) {
  const ctx = await getPlatformContext();
  if (!ctx) return { title: 'الصفحة غير موجودة', robots: { index: false, follow: false } };
  return { title: params.code, robots: { index: false, follow: false } };
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

/** A labelled value. The profile is a reference screen, so density beats flair. */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 px-5 py-2.5">
      <dt className="shrink-0 text-muted">{label}</dt>
      <dd className="text-end font-semibold text-fg">{children}</dd>
    </div>
  );
}

function Yes({ on, yes = 'مفعّل', no = 'غير مفعّل' }: { on: boolean; yes?: string; no?: string }) {
  return (
    <span className={on ? 'text-success' : 'text-muted'}>{on ? yes : no}</span>
  );
}

/**
 * The customer profile: the operator's central screen.
 *
 * Every section is a separate admin-gated database function returning an
 * explicit projection, so the page holds exactly what it shows. It carries no
 * organization id in its URL, no branch ids at all, and nothing from inside the
 * customer's own business — no menu, no orders, no end-customers.
 */
export default async function CustomerProfilePage({
  params,
  searchParams,
}: {
  params: { code: string };
  searchParams: { created?: string };
}) {
  const code = decodeURIComponent(params.code);
  const platformCtx = await getPlatformContext();
  const org = await getOrganizationByCode(code);
  if (!org) notFound();
  const justCreated = searchParams.created === '1';

  const [history, plans, branches, modules, audit, domains, staff, roleCatalog] = await Promise.all([
    listSubscriptionHistory(org.id),
    listPlans(),
    listCustomerBranches(code),
    listCustomerModules(code),
    listCustomerAudit(code, 30),
    listCustomerDomains(code),
    listCustomerStaff(code),
    listCustomerRoleCatalog(code),
  ]);

  const currentPlanId = plans.find((p) => p.key === org.planKey)?.id ?? null;
  const siteHref = `/r/${org.slug}`;

  return (
    <>
      <AdminHeading title={org.name} />

      {justCreated ? (
        <p className="mb-6 rounded border border-success/30 bg-success/10 px-4 py-3 text-sm font-semibold text-success">
          تم إنشاء مساحة العمل. كود العميل: {org.customerCode}
        </p>
      ) : null}

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <CustomerCode code={org.customerCode} />
        <StatusBadge status={org.subscriptionStatus} />
        <ExpiryBadge daysLeft={org.daysLeft} />
        <span className="text-xs text-muted" dir="ltr">/{org.slug}</span>
        {org.status !== 'active' ? (
          <span className="rounded bg-danger/10 px-2 py-0.5 text-xs font-bold text-danger">
            المنشأة {org.status}
          </span>
        ) : null}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel>
          <h2 className="border-b border-line px-5 py-3 text-sm font-bold text-fg">بيانات العميل</h2>
          <dl className="divide-y divide-line text-sm">
            <Row label="الاسم">{org.name}</Row>
            <Row label="الاسم التجاري">{org.displayName ?? '—'}</Row>
            <Row label="المعرّف"><span dir="ltr">{org.slug}</span></Row>
            <Row label="العملة"><span dir="ltr">{org.currency}</span></Row>
            <Row label="بداية التعامل">{formatDate(org.createdAt)}</Row>
          </dl>
        </Panel>

        <Panel>
          <h2 className="border-b border-line px-5 py-3 text-sm font-bold text-fg">المالك</h2>
          <dl className="divide-y divide-line text-sm">
            <Row label="الاسم">{org.ownerName ?? '—'}</Row>
            <Row label="البريد الإلكتروني">
              <span dir="ltr">{org.ownerEmail ?? '—'}</span>
            </Row>
            <Row label="هاتف المالك"><span dir="ltr">{org.ownerPhone ?? '—'}</span></Row>
            <Row label="هاتف المنشأة"><span dir="ltr">{org.contactPhone ?? '—'}</span></Row>
            <Row label="واتساب"><span dir="ltr">{org.contactWhatsapp ?? '—'}</span></Row>
            <Row label="بريد المنشأة"><span dir="ltr">{org.contactEmail ?? '—'}</span></Row>
          </dl>
        </Panel>

        <Panel>
          <h2 className="border-b border-line px-5 py-3 text-sm font-bold text-fg">الخدمات</h2>
          {modules.length === 0 ? (
            <p className="px-5 py-6 text-center text-sm text-muted">لا توجد خدمات مفعّلة.</p>
          ) : (
            <ul className="divide-y divide-line text-sm">
              {modules.map((m) => (
                <li key={m.moduleKey} className="flex items-center gap-3 px-5 py-2.5">
                  <span className="font-semibold text-fg">{m.nameAr}</span>
                  {m.isPrimary ? (
                    <span className="rounded bg-primary-soft px-2 py-0.5 text-xs font-semibold text-primary">
                      أساسية
                    </span>
                  ) : null}
                  <span className="ms-auto text-xs"><Yes on={m.enabled} /></span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel>
          <h2 className="border-b border-line px-5 py-3 text-sm font-bold text-fg">
            الموقع والطلبات
          </h2>
          <dl className="divide-y divide-line text-sm">
            <Row label="الموقع العام"><Yes on={org.websiteEnabled} yes="منشور" no="غير منشور" /></Row>
            <Row label="الطلب أونلاين"><Yes on={org.orderingEnabled} /></Row>
            <Row label="الشعار"><Yes on={Boolean(org.logoUrl)} yes="مرفوع" no="لا يوجد" /></Row>
            <Row label="اللون الأساسي">
              <span className="inline-flex items-center gap-2" dir="ltr">
                <span
                  aria-hidden
                  className="inline-block h-3 w-3 rounded-full border border-line"
                  style={{ backgroundColor: org.primaryColor }}
                />
                {org.primaryColor}
              </span>
            </Row>
            <Row label="إخفاء علامة Local Basic"><Yes on={org.whiteLabel} yes="نعم" no="لا" /></Row>
            <div className="px-5 py-2.5">
              {org.websiteEnabled ? (
                <Link
                  href={siteHref}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm font-semibold text-primary hover:underline"
                >
                  فتح موقع العميل ↗
                </Link>
              ) : (
                <span className="text-sm text-muted">
                  لم ينشر العميل موقعه بعد، فلا يوجد رابط عام.
                </span>
              )}
            </div>
          </dl>
        </Panel>

        <Panel>
          <h2 className="border-b border-line px-5 py-3 text-sm font-bold text-fg">
            النطاقات
            <span className="ms-2 font-normal text-muted">للاطلاع فقط</span>
          </h2>
          {domains.length === 0 ? (
            <p className="px-5 py-6 text-center text-sm text-muted">
              لا توجد نطاقات مخصّصة.
            </p>
          ) : (
            <ul className="divide-y divide-line text-sm">
              {domains.map((d) => (
                <li key={d.hostname} className="flex flex-wrap items-center gap-2 px-5 py-2.5">
                  <span className="font-mono text-fg" dir="ltr">{d.hostname}</span>
                  {d.isPrimary ? (
                    <span className="rounded bg-primary-soft px-2 py-0.5 text-xs font-semibold text-primary">
                      الأساسي
                    </span>
                  ) : null}
                  <span
                    className={
                      'ms-auto rounded px-2 py-0.5 text-xs font-semibold ' +
                      (d.status === 'active'
                        ? 'bg-success/15 text-success'
                        : d.status === 'disabled'
                          ? 'bg-danger/10 text-danger'
                          : 'bg-warn/15 text-warn')
                    }
                  >
                    {d.status}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel>
          <h2 className="border-b border-line px-5 py-3 text-sm font-bold text-fg">
            الفروع
            <span className="ms-2 font-normal text-muted">{org.branchCount}</span>
          </h2>
          {branches.length === 0 ? (
            <p className="px-5 py-6 text-center text-sm text-muted">لا توجد فروع.</p>
          ) : (
            <ul className="divide-y divide-line text-sm">
              {branches.map((b) => (
                <li key={b.slug} className="px-5 py-2.5">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-fg">{b.name}</span>
                    <span className="text-xs text-muted" dir="ltr">/{b.slug}</span>
                    {!b.isActive ? (
                      <span className="ms-auto rounded bg-danger/10 px-2 py-0.5 text-xs font-semibold text-danger">
                        موقوف
                      </span>
                    ) : null}
                  </div>
                  {b.address ? <p className="text-xs text-muted">{b.address}</p> : null}
                  {b.phone ? <p className="text-xs text-muted" dir="ltr">{b.phone}</p> : null}
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel>
          <h2 className="border-b border-line px-5 py-3 text-sm font-bold text-fg">
            الاشتراك الحالي
          </h2>
          <dl className="divide-y divide-line text-sm">
            <Row label="الباقة">{org.planNameAr ?? '—'}</Row>
            <Row label="المدة">{periodLabel(org.billingPeriod)}</Row>
            <Row label="بدأ في">{formatDate(org.currentPeriodStart)}</Row>
            <Row label="ينتهي في">{formatDate(org.currentPeriodEnd)}</Row>
            <Row label="الحالة"><StatusBadge status={org.subscriptionStatus} /></Row>
            <Row label="المتبقي"><ExpiryBadge daysLeft={org.daysLeft} /></Row>
          </dl>
        </Panel>
      </div>

      <Panel className="mt-6">
        <h2 className="border-b border-line px-5 py-3 text-sm font-bold text-fg">
          تجديد الاشتراك
          <span className="ms-2 font-normal text-muted">
            السعر والمدة والخصم تُحسب على الخادم
          </span>
        </h2>
        <RenewForm organizationId={org.id} plans={plans} currentPlanId={currentPlanId} />
      </Panel>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Panel>
          <h2 className="border-b border-line px-5 py-3 text-sm font-bold text-fg">
            تعديل المدة المتبقية
            <span className="ms-2 font-normal text-muted">بدون دفع</span>
          </h2>
          <AdjustDaysForm organizationId={org.id} />
        </Panel>

        <Panel>
          <h2 className="border-b border-line px-5 py-3 text-sm font-bold text-fg">
            تبديل الباقة (يلغي المتبقي)
          </h2>
          <SwitchPlanForm organizationId={org.id} plans={plans} currentPlanId={currentPlanId} />
        </Panel>
      </div>

      <Panel className="mt-6">
        <h2 className="border-b border-line px-5 py-3 text-sm font-bold text-fg">
          فريق العمل والأدوار
          <span className="ms-2 font-normal text-muted">إدارة أدوار الموظفين من لوحة المنصة</span>
        </h2>
        <StaffRoles
          customerCode={org.customerCode}
          staff={staff}
          roles={roleCatalog}
          isPlatformOwner={platformCtx?.role === 'owner'}
        />
      </Panel>

      <Panel className="mt-6 border-danger/30">
        <h2 className="border-b border-danger/30 bg-danger/5 px-5 py-3 text-sm font-bold text-danger">
          منطقة الخطر
        </h2>
        <DangerZone
          organizationId={org.id}
          customerCode={org.customerCode}
          isOwner={platformCtx?.role === 'owner'}
        />
      </Panel>

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

      <Panel className="mt-6">
        <h2 className="border-b border-line px-5 py-3 text-sm font-bold text-fg">
          النشاط
          <span className="ms-2 font-normal text-muted">آخر 30 حدثًا لهذا العميل</span>
        </h2>
        {audit.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-muted">لا يوجد نشاط مسجّل.</p>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {audit.map((a, i) => (
              <li key={`${a.createdAt}-${i}`} className="flex flex-wrap items-center gap-3 px-5 py-2.5">
                <span className="whitespace-nowrap text-xs text-muted">{formatDate(a.createdAt)}</span>
                <span className="font-semibold text-fg" dir="ltr">{a.action}</span>
                {a.entityType ? (
                  <span className="text-xs text-muted" dir="ltr">{a.entityType}</span>
                ) : null}
                <span className="ms-auto text-xs text-muted">{a.actorLabel ?? '—'}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
}
