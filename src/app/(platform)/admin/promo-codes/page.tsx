import { listPromoCodes, listPlans } from '@/modules/platform/billing/service';
import { listServices } from '@/modules/platform/services/service';
import { CreatePromoForm, TogglePromoForm } from './promo-forms';
import { AdminHeading, Panel, formatDate, money } from '../ui';
import { adminMetadata } from '@/modules/platform/admin/metadata';

export const generateMetadata = adminMetadata('أكواد الخصم');

const KIND_LABEL: Record<string, string> = {
  percent: 'نسبة مئوية',
  fixed: 'مبلغ ثابت',
  trial_days: 'أيام تجربة',
};

function effect(c: {
  kind: string; percent_off: number | null;
  amount_off_cents: number | null; trial_days: number | null;
}): string {
  if (c.kind === 'percent') return `${c.percent_off}%`;
  if (c.kind === 'fixed') return money(c.amount_off_cents ?? 0);
  return `${c.trial_days} يوم`;
}

export default async function PromoCodesPage({
  searchParams,
}: {
  searchParams: { q?: string; created?: string };
}) {
  const q = searchParams.q?.trim().toLowerCase() ?? '';
  const [all, plans, services] = await Promise.all([listPromoCodes(), listPlans(), listServices()]);
  const codes = q ? all.filter((c) => c.code.toLowerCase().includes(q)) : all;

  return (
    <>
      <AdminHeading
        title="أكواد الخصم والتجربة"
        lead="منفصلة تمامًا عن كود العميل. يتحقق الخادم من الصلاحية وحدود الاستخدام قبل أي خصم."
      />
      {searchParams.created === '1' ? (
        <p className="mb-4 rounded border border-success/30 bg-success/10 px-4 py-3 text-sm font-semibold text-success">
          تم إنشاء الرمز.
        </p>
      ) : null}

      <Panel className="mb-6">
        <h2 className="border-b border-line px-5 py-3 text-sm font-bold text-fg">رمز جديد</h2>
        <CreatePromoForm plans={plans} services={services.filter((s) => s.isBuilt)} />
      </Panel>

      <form className="mb-4 flex gap-2" action="/admin/promo-codes">
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="ابحث برمز"
          dir="ltr"
          className="h-10 flex-1 rounded border border-line bg-elevated px-3 text-sm text-fg"
        />
        <button type="submit" className="h-10 rounded bg-primary px-4 text-sm font-semibold text-primary-fg">
          بحث
        </button>
      </form>

      <Panel>
        {codes.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-muted">لا توجد أكواد مطابقة.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-line bg-surface text-xs text-muted">
                <tr>
                  <th className="px-4 py-2.5 text-start font-semibold">الرمز</th>
                  <th className="px-4 py-2.5 text-start font-semibold">النوع</th>
                  <th className="px-4 py-2.5 text-start font-semibold">القيمة</th>
                  <th className="px-4 py-2.5 text-start font-semibold">يبدأ</th>
                  <th className="px-4 py-2.5 text-start font-semibold">ينتهي</th>
                  <th className="px-4 py-2.5 text-start font-semibold">الاستخدام</th>
                  <th className="px-4 py-2.5 text-start font-semibold">عملاء جدد فقط</th>
                  <th className="px-4 py-2.5 text-start font-semibold">الحالة</th>
                  <th className="px-4 py-2.5 text-start font-semibold"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {codes.map((c) => (
                  <tr key={c.id} className="hover:bg-surface">
                    <td className="px-4 py-3">
                      <span className="rounded bg-surface px-2 py-0.5 font-mono text-xs font-bold text-fg" dir="ltr">
                        {c.code}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-muted">{KIND_LABEL[c.kind] ?? c.kind}</td>
                    <td className="px-4 py-3 font-semibold text-fg">{effect(c)}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-muted">{formatDate(c.starts_at)}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-muted">{formatDate(c.ends_at)}</td>
                    <td className="px-4 py-3 text-muted">
                      {c.redeemed_count}{c.max_redemptions ? ` / ${c.max_redemptions}` : ''}
                    </td>
                    <td className="px-4 py-3 text-muted">{c.new_customers_only ? 'نعم' : 'لا'}</td>
                    <td className="px-4 py-3">
                      <span className={
                        c.is_active
                          ? 'rounded bg-success/15 px-2 py-0.5 text-xs font-semibold text-success'
                          : 'rounded bg-danger/10 px-2 py-0.5 text-xs font-semibold text-danger'
                      }>
                        {c.is_active ? 'نشط' : 'موقوف'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <TogglePromoForm id={c.id} isActive={c.is_active} />
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
