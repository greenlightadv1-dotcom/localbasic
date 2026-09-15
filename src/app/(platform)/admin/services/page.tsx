import { listServices } from '@/modules/platform/services/service';
import { listPlans } from '@/modules/platform/billing/service';
import { adminMetadata } from '@/modules/platform/admin/metadata';
import { AdminHeading, Panel, money } from '../ui';
import { AvailabilityToggle } from './toggle';

export const generateMetadata = adminMetadata('الخدمات');

export default async function ServicesPage() {
  const [services, plans] = await Promise.all([listServices(), listPlans()]);

  return (
    <>
      <AdminHeading
        title="الخدمات"
        lead="ما تبيعه المنصة. إيقاف خدمة يمنع بيعها لعملاء جدد فقط، ولا يمسّ عميلًا قائمًا."
      />

      <div className="grid gap-4 lg:grid-cols-2">
        {services.map((s) => (
          <Panel key={s.moduleKey} className="p-5">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-bold text-fg">{s.nameAr}</h2>
              <span className="text-xs text-muted" dir="ltr">{s.nameEn}</span>
              {s.isBuilt ? (
                s.isAvailable ? (
                  <span className="rounded bg-success/15 px-2 py-0.5 text-xs font-semibold text-success">
                    متاح للبيع
                  </span>
                ) : (
                  <span className="rounded bg-warn/15 px-2 py-0.5 text-xs font-semibold text-warn">
                    موقوف عن البيع
                  </span>
                )
              ) : (
                <span className="rounded bg-surface px-2 py-0.5 text-xs font-semibold text-muted">
                  غير مبنية
                </span>
              )}
            </div>

            {s.descriptionAr ? (
              <p className="mt-2 text-sm leading-relaxed text-muted">{s.descriptionAr}</p>
            ) : (
              <p className="mt-2 text-sm text-muted">لم تُبنَ هذه الخدمة بعد ولا يمكن بيعها.</p>
            )}

            <dl className="mt-4 flex gap-6 border-t border-line pt-3 text-xs">
              <div>
                <dt className="text-muted">المعرّف</dt>
                <dd className="font-mono font-semibold text-fg" dir="ltr">{s.moduleKey}</dd>
              </div>
              <div>
                <dt className="text-muted">عملاء يستخدمونها</dt>
                <dd className="font-semibold text-fg">{s.organizationCount}</dd>
              </div>
            </dl>

            <div className="mt-4">
              <AvailabilityToggle
                moduleKey={s.moduleKey}
                isAvailable={s.isAvailable}
                disabled={!s.isBuilt}
              />
            </div>
          </Panel>
        ))}
      </div>

      <Panel className="mt-6">
        <h2 className="border-b border-line px-5 py-3 text-sm font-bold text-fg">
          الباقات
          <span className="ms-2 font-normal text-muted">
            الباقات مشتركة بين الخدمات — السعر شهري ويُضرب في مدة الاشتراك على الخادم
          </span>
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-line bg-surface text-xs text-muted">
              <tr>
                <th className="px-4 py-2.5 text-start font-semibold">الباقة</th>
                <th className="px-4 py-2.5 text-start font-semibold">السعر الشهري</th>
                <th className="px-4 py-2.5 text-start font-semibold">الفروع</th>
                <th className="px-4 py-2.5 text-start font-semibold">المستخدمون</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {plans.map((p) => {
                const limits = (p.limits ?? {}) as Record<string, number>;
                return (
                  <tr key={p.id}>
                    <td className="px-4 py-3 font-semibold text-fg">{p.name_ar}</td>
                    <td className="px-4 py-3 text-muted">{money(p.price_cents, p.currency)}</td>
                    <td className="px-4 py-3 text-muted">{limits['branches'] ?? '—'}</td>
                    <td className="px-4 py-3 text-muted">{limits['members'] ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}
