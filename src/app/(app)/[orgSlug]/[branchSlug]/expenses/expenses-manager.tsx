'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Receipt } from 'lucide-react';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { Money } from '@/components/patterns/money';
import { EmptyState } from '@/components/patterns/states';
import { useToast } from '@/components/ui/toast';
import { recordExpenseAction } from '../restaurant-actions';

const CATEGORIES: Record<string, string> = {
  supplies: 'مستلزمات',
  maintenance: 'صيانة',
  utilities: 'مرافق',
  salary: 'رواتب',
  rent: 'إيجار',
  other: 'أخرى',
};

type Expense = {
  id: string;
  amount_cents: number;
  category: string;
  reason: string | null;
  occurred_at: string;
};

/** Expenses are treasury movements: recorded once, never edited or deleted. */
export function ExpensesManager({
  expenses,
  currency,
  canRecord,
  organizationSlug,
  branchSlug,
}: {
  expenses: Expense[];
  currency: string;
  canRecord: boolean;
  organizationSlug: string;
  branchSlug: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [isPending, startTransition] = useTransition();

  function submit(formData: FormData) {
    const amount = String(formData.get('amount') ?? '').trim();
    if (!/^\d+(\.\d{0,2})?$/.test(amount)) {
      toast.error('أدخل مبلغًا صحيحًا.');
      return;
    }
    const [whole = '0', fraction = ''] = amount.split('.');
    const amountCents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));

    startTransition(async () => {
      const result = await recordExpenseAction(
        { organizationSlug, branchSlug },
        {
          amountCents,
          category: formData.get('category'),
          reason: formData.get('reason'),
        },
      );
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success('تم تسجيل المصروف');
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      {canRecord && (
        <Card>
          <CardHeader>
            <CardTitle>تسجيل مصروف</CardTitle>
          </CardHeader>
          <CardBody>
            <form action={submit} className="grid gap-3 sm:grid-cols-4">
              <Field label={`المبلغ (${currency})`} required>
                {(p) => (
                  <Input {...p} name="amount" inputMode="decimal" dir="ltr" required placeholder="0.00" />
                )}
              </Field>
              <Field label="النوع" required>
                {(p) => (
                  <Select {...p} name="category" defaultValue="supplies">
                    {Object.entries(CATEGORIES).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <div className="sm:col-span-2">
                <Field label="السبب" required>
                  {(p) => <Input {...p} name="reason" required maxLength={300} />}
                </Field>
              </div>
              <div className="sm:col-span-4 flex justify-end">
                <Button type="submit" disabled={isPending}>
                  {isPending ? 'جارٍ التسجيل…' : 'تسجيل المصروف'}
                </Button>
              </div>
            </form>
          </CardBody>
        </Card>
      )}

      <Card>
        {expenses.length === 0 ? (
          <EmptyState
            icon={Receipt}
            title="لا توجد مصروفات"
            description="سجّل المصروفات لتظهر في التقارير وصافي الحركة."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">سجل المصروفات</caption>
              <thead>
                <tr className="border-b border-line text-xs text-muted">
                  <th scope="col" className="p-3 text-start font-medium">التاريخ</th>
                  <th scope="col" className="p-3 text-start font-medium">النوع</th>
                  <th scope="col" className="p-3 text-start font-medium">السبب</th>
                  <th scope="col" className="p-3 text-start font-medium">المبلغ</th>
                </tr>
              </thead>
              <tbody>
                {expenses.map((expense) => (
                  <tr key={expense.id} className="border-b border-line last:border-0">
                    <td className="p-3 lb-numeric text-muted">
                      {new Date(expense.occurred_at).toLocaleDateString('ar-EG')}
                    </td>
                    <td className="p-3">{CATEGORIES[expense.category] ?? expense.category}</td>
                    <td className="p-3">{expense.reason ?? '—'}</td>
                    <td className="p-3">
                      <Money cents={expense.amount_cents} currency={currency} tone="negative" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
