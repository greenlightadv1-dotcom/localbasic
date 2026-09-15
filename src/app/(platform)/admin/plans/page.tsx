import { listPlans } from '@/modules/platform/billing/service';
import { AdminHeading, Panel, money } from '../ui';
import { BILLING_PERIODS, BILLING_PERIOD_LABELS } from '@/modules/platform/billing/schemas';

export const metadata = { title: 'الباقات' };

const MONTHS: Record<string, number> = { month: 1, quarter: 3, semiannual: 6, year: 12 };

export default async function PlansPage() {
  const plans = await listPlans();

  return (
    <>
      <AdminHeading
        title="الباقات"
        lead="السعر المخزَّن شهري. سعر كل مدة يُحسب على الخادم بضربه في عدد الشهور."
      />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {plans.map((p) => (
          <Panel key={p.id} className="p-5">
            <h2 className="font-bold text-fg">{p.name_ar}</h2>
            <p className="text-xs text-muted">{p.name_en}</p>
            <p className="mt-3 text-2xl font-extrabold text-fg">
              {money(p.price_cents, p.currency)}
            </p>
            <p className="text-xs text-muted">شهريًا</p>

            <ul className="mt-4 space-y-1 border-t border-line pt-3 text-xs text-muted">
              {BILLING_PERIODS.map((period) => (
                <li key={period} className="flex justify-between">
                  <span>{BILLING_PERIOD_LABELS[period]}</span>
                  <span className="font-semibold text-fg">
                    {money(p.price_cents * (MONTHS[period] ?? 1), p.currency)}
                  </span>
                </li>
              ))}
            </ul>
          </Panel>
        ))}
      </div>
    </>
  );
}
