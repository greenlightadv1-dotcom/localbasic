'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Trash2 } from 'lucide-react';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { Alert } from '@/components/ui/alert';
import { Money } from '@/components/patterns/money';
import { createPurchaseAction } from '../actions';

type Line = { key: number; variantId: string; quantity: string; unitCost: string };

const emptyLine = (key: number): Line => ({ key, variantId: '', quantity: '1', unitCost: '' });

/** Minor units from what a human typed, for the preview only. */
function toCents(text: string): number {
  const clean = text.trim().replace(/[,\s]/g, '');
  if (!/^\d+(\.\d{0,2})?$/.test(clean)) return 0;
  const [whole = '0', fraction = ''] = clean.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

export function NewPurchaseForm({
  suppliers, variants, currency, organizationSlug, branchSlug,
}: {
  suppliers: { id: string; name: string }[];
  variants: { id: string; label: string; costCents: number }[];
  currency: string;
  organizationSlug: string;
  branchSlug: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([emptyLine(0)]);

  function updateLine(key: number, patch: Partial<Line>) {
    setLines((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  /**
   * A preview only. The order total is computed in the database from the same
   * quantities and costs, and that is the number that is stored — this one
   * never leaves the browser.
   */
  const previewTotal = useMemo(
    () =>
      lines.reduce(
        (sum, l) => sum + Math.round((Number(l.quantity) || 0) * toCents(l.unitCost)),
        0,
      ),
    [lines],
  );

  function onSubmit(formData: FormData) {
    setError(null);

    const input = {
      supplierId: formData.get('supplierId') || null,
      expectedAt: formData.get('expectedAt') || '',
      note: formData.get('note') || '',
      lines: lines
        .filter((l) => l.variantId)
        .map((l) => ({
          variantId: l.variantId,
          quantity: l.quantity || '0',
          unitCostCents: l.unitCost || '0',
        })),
    };

    if (input.lines.length === 0) {
      setError('أضف صنفًا واحدًا على الأقل.');
      return;
    }

    startTransition(async () => {
      const result = await createPurchaseAction({ organizationSlug, branchSlug }, input);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push(`/${organizationSlug}/${branchSlug}/purchases/${result.data.id}`);
      router.refresh();
    });
  }

  return (
    <form action={onSubmit} className="space-y-4">
      {error ? <Alert tone="danger">{error}</Alert> : null}

      <Card>
        <CardHeader>
          <CardTitle>بيانات الأمر</CardTitle>
        </CardHeader>
        <CardBody className="grid gap-4 sm:grid-cols-3">
          <Field label="المورد">
            {(p) => (
              <Select {...p} name="supplierId" defaultValue="">
                <option value="">بدون مورد محدّد</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </Select>
            )}
          </Field>

          <Field label="تاريخ الاستلام المتوقّع">
            {(p) => <Input {...p} name="expectedAt" type="date" dir="ltr" />}
          </Field>

          <Field label="ملاحظات">
            {(p) => <Input {...p} name="note" maxLength={2000} />}
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>الأصناف</CardTitle>
        </CardHeader>
        <CardBody className="space-y-3">
          {variants.length === 0 ? (
            <Alert tone="warn">
              لا توجد أصناف في الكتالوج بعد. أضف منتجًا أولًا حتى تتمكّن من شرائه.
            </Alert>
          ) : null}

          {lines.map((line) => (
            <div key={line.key} className="grid gap-2 sm:grid-cols-[1fr_7rem_8rem_auto]">
              <Field label="الصنف">
                {(p) => (
                  <Select
                    {...p}
                    value={line.variantId}
                    onChange={(e) => {
                      const variant = variants.find((v) => v.id === e.target.value);
                      updateLine(line.key, {
                        variantId: e.target.value,
                        // Seed the cost from what was last paid, as a
                        // suggestion the buyer can overwrite.
                        unitCost:
                          line.unitCost ||
                          (variant && variant.costCents > 0
                            ? (variant.costCents / 100).toFixed(2)
                            : ''),
                      });
                    }}
                  >
                    <option value="">اختر صنفًا</option>
                    {variants.map((v) => (
                      <option key={v.id} value={v.id}>{v.label}</option>
                    ))}
                  </Select>
                )}
              </Field>

              <Field label="الكمية">
                {(p) => (
                  <Input
                    {...p}
                    dir="ltr"
                    inputMode="decimal"
                    value={line.quantity}
                    onChange={(e) => updateLine(line.key, { quantity: e.target.value })}
                  />
                )}
              </Field>

              <Field label="سعر الوحدة">
                {(p) => (
                  <Input
                    {...p}
                    dir="ltr"
                    inputMode="decimal"
                    placeholder="0.00"
                    value={line.unitCost}
                    onChange={(e) => updateLine(line.key, { unitCost: e.target.value })}
                  />
                )}
              </Field>

              <div className="flex items-end pb-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label="حذف السطر"
                  disabled={lines.length === 1}
                  onClick={() => setLines((rows) => rows.filter((r) => r.key !== line.key))}
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </Button>
              </div>
            </div>
          ))}

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setLines((rows) => [...rows, emptyLine(Date.now())])}
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            إضافة سطر
          </Button>
        </CardBody>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded border border-line bg-elevated p-4">
        <span className="text-sm text-muted">
          الإجمالي التقديري{' '}
          <span className="text-xs">(يُحتسب نهائيًا في الخادم)</span>
        </span>
        <Money cents={previewTotal} currency={currency} className="text-lg font-bold" />
      </div>

      <Button type="submit" disabled={isPending || variants.length === 0}>
        {isPending ? '…' : 'حفظ أمر الشراء'}
      </Button>
    </form>
  );
}
