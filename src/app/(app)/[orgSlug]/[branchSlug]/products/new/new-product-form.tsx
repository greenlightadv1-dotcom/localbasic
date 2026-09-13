'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Trash2 } from 'lucide-react';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Alert } from '@/components/ui/alert';
import { createProductAction } from '../../actions';

type VariantRow = {
  key: number;
  name: string;
  sku: string;
  barcode: string;
  price: string;
  cost: string;
  reorderPoint: string;
  openingQuantity: string;
};

const emptyVariant = (key: number): VariantRow => ({
  key,
  name: 'default',
  sku: '',
  barcode: '',
  price: '',
  cost: '',
  reorderPoint: '0',
  openingQuantity: '0',
});

export function NewProductForm({
  categories,
  currency,
  organizationSlug,
  branchSlug,
}: {
  categories: { id: string; name: string }[];
  currency: string;
  organizationSlug: string;
  branchSlug: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [variants, setVariants] = useState<VariantRow[]>([emptyVariant(0)]);

  function updateVariant(key: number, patch: Partial<VariantRow>) {
    setVariants((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function onSubmit(formData: FormData) {
    setError(null);
    setFieldErrors({});

    const input = {
      name: formData.get('name'),
      categoryId: formData.get('categoryId') || null,
      description: formData.get('description') || undefined,
      unit: formData.get('unit'),
      taxRatePercent: formData.get('taxRatePercent'),
      isOnline: formData.get('isOnline') === 'on',
      variants: variants.map((v) => ({
        name: v.name || 'default',
        sku: v.sku,
        barcode: v.barcode,
        priceCents: v.price || '0',
        costCents: v.cost || '0',
        reorderPoint: v.reorderPoint || '0',
        openingQuantity: v.openingQuantity || '0',
      })),
    };

    startTransition(async () => {
      const result = await createProductAction({ organizationSlug, branchSlug }, input);
      if (!result.ok) {
        setError(result.error);
        setFieldErrors(result.fieldErrors ?? {});
        return;
      }
      router.push(`/${organizationSlug}/${branchSlug}/products`);
      router.refresh();
    });
  }

  return (
    <form action={onSubmit} className="space-y-4">
      {error && <Alert tone="danger">{error}</Alert>}

      <Card>
        <CardHeader>
          <CardTitle>بيانات المنتج</CardTitle>
        </CardHeader>
        <CardBody className="grid gap-4 sm:grid-cols-2">
          <Field label="اسم المنتج" required error={fieldErrors.name}>
            {(p) => <Input {...p} name="name" required maxLength={200} autoFocus />}
          </Field>

          <Field label="التصنيف">
            {(p) => (
              <Select {...p} name="categoryId" defaultValue="">
                <option value="">بدون تصنيف</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <Field label="وحدة البيع">
            {(p) => (
              <Select {...p} name="unit" defaultValue="piece">
                <option value="piece">قطعة</option>
                <option value="kg">كيلوجرام</option>
                <option value="gram">جرام</option>
                <option value="litre">لتر</option>
                <option value="metre">متر</option>
                <option value="box">علبة</option>
                <option value="pack">باكت</option>
              </Select>
            )}
          </Field>

          <Field label="نسبة الضريبة %" hint="اتركها صفرًا إذا كان المنتج معفى">
            {(p) => (
              <Input {...p} name="taxRatePercent" type="number" min={0} max={100} step="0.01" defaultValue="0" dir="ltr" />
            )}
          </Field>

          <div className="sm:col-span-2">
            <Field label="الوصف">
              {(p) => <Textarea {...p} name="description" maxLength={2000} />}
            </Field>
          </div>

          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input type="checkbox" name="isOnline" defaultChecked className="h-4 w-4" />
            إتاحة المنتج في المتجر الإلكتروني
          </label>
        </CardBody>
      </Card>

      <Card>
        <CardHeader className="flex items-center justify-between">
          <CardTitle>الأسعار والمخزون</CardTitle>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setVariants((rows) => [...rows, emptyVariant(Date.now())])}
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            إضافة نوع
          </Button>
        </CardHeader>
        <CardBody className="space-y-4">
          {variants.map((v, index) => (
            <fieldset key={v.key} className="rounded border border-line p-3">
              <legend className="px-1 text-xs font-medium text-muted">
                {variants.length > 1 ? `النوع ${index + 1}` : 'السعر والمخزون'}
              </legend>
              <div className="grid gap-3 sm:grid-cols-3">
                {variants.length > 1 && (
                  <Field label="اسم النوع">
                    {(p) => (
                      <Input
                        {...p}
                        value={v.name === 'default' ? '' : v.name}
                        placeholder="مثال: كبير"
                        onChange={(e) => updateVariant(v.key, { name: e.target.value || 'default' })}
                      />
                    )}
                  </Field>
                )}
                <Field label={`سعر البيع (${currency})`} required>
                  {(p) => (
                    <Input
                      {...p}
                      value={v.price}
                      onChange={(e) => updateVariant(v.key, { price: e.target.value })}
                      inputMode="decimal"
                      dir="ltr"
                      required
                      placeholder="0.00"
                    />
                  )}
                </Field>
                <Field label={`سعر التكلفة (${currency})`}>
                  {(p) => (
                    <Input
                      {...p}
                      value={v.cost}
                      onChange={(e) => updateVariant(v.key, { cost: e.target.value })}
                      inputMode="decimal"
                      dir="ltr"
                      placeholder="0.00"
                    />
                  )}
                </Field>
                <Field label="الكمية الافتتاحية">
                  {(p) => (
                    <Input
                      {...p}
                      value={v.openingQuantity}
                      onChange={(e) => updateVariant(v.key, { openingQuantity: e.target.value })}
                      inputMode="decimal"
                      dir="ltr"
                    />
                  )}
                </Field>
                <Field label="حد إعادة الطلب">
                  {(p) => (
                    <Input
                      {...p}
                      value={v.reorderPoint}
                      onChange={(e) => updateVariant(v.key, { reorderPoint: e.target.value })}
                      inputMode="decimal"
                      dir="ltr"
                    />
                  )}
                </Field>
                <Field label="الباركود">
                  {(p) => (
                    <Input
                      {...p}
                      value={v.barcode}
                      onChange={(e) => updateVariant(v.key, { barcode: e.target.value })}
                      dir="ltr"
                    />
                  )}
                </Field>
                <Field label="كود المنتج (SKU)">
                  {(p) => (
                    <Input
                      {...p}
                      value={v.sku}
                      onChange={(e) => updateVariant(v.key, { sku: e.target.value })}
                      dir="ltr"
                    />
                  )}
                </Field>
              </div>
              {variants.length > 1 && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="mt-2 text-danger"
                  onClick={() => setVariants((rows) => rows.filter((r) => r.key !== v.key))}
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                  حذف النوع
                </Button>
              )}
            </fieldset>
          ))}
        </CardBody>
      </Card>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => router.back()}>
          إلغاء
        </Button>
        <Button type="submit" disabled={isPending}>
          {isPending ? 'جارٍ الحفظ…' : 'حفظ المنتج'}
        </Button>
      </div>
    </form>
  );
}
