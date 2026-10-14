'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Field, Input, Textarea } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { buildReceiptHtml } from '@/lib/print/receipt-html';
import { receiptSettingsSchema, type ReceiptSettingsInput } from '@/modules/restaurant/receipt/schema';
import type { ReceiptSettings } from '@/modules/restaurant/receipt/service';
import { saveReceiptSettingsAction } from './actions';

type Key = keyof ReceiptSettingsInput;

export function ReceiptSettingsForm({
  scope,
  settings,
  businessName,
  fallbackPhone,
  currency,
  whiteLabel,
}: {
  scope: { organizationSlug: string; branchSlug: string };
  settings: ReceiptSettings;
  businessName: string;
  fallbackPhone: string | null;
  currency: string;
  whiteLabel: boolean;
}) {
  const toast = useToast();
  const [isPending, startTransition] = useTransition();
  const [values, setValues] = useState<ReceiptSettingsInput>({
    legalName: settings.legalName,
    commercialRegistration: settings.commercialRegistration,
    taxId: settings.taxId,
    headerNote: settings.headerNote,
    footerNote: settings.footerNote,
    branchDisplayName: settings.branchDisplayName,
    branchAddress: settings.branchAddress,
    branchPhone: settings.branchPhone,
  });
  const [errors, setErrors] = useState<Partial<Record<Key, string>>>({});
  // The preview's sample date is formatted by the browser; rendering it only
  // after mount keeps server and client markup identical.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const set = (key: Key) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setValues((v) => ({ ...v, [key]: e.target.value }));
    setErrors((x) => ({ ...x, [key]: undefined }));
  };

  // The real receipt template with sample lines, so the owner sees exactly
  // what prints. Rendered in a sandboxed frame: no scripts can run in it.
  const preview = useMemo(
    () =>
      buildReceiptHtml({
        businessName,
        branchName: values.branchDisplayName.trim() || settings.branchName,
        phone: values.branchPhone.trim() || settings.branchDefaultPhone || fallbackPhone,
        address: values.branchAddress.trim() || settings.branchDefaultAddress,
        legalName: values.legalName.trim() || null,
        commercialRegistration: values.commercialRegistration.trim() || null,
        taxId: values.taxId.trim() || null,
        headerNote: values.headerNote.trim() || null,
        footerNote: values.footerNote.trim() || null,
        number: 'RC-000123',
        orderNumber: '000018',
        tableName: '5',
        issuedAt: new Date().toISOString(),
        currency,
        items: [
          { description: 'صنف تجريبي', quantity: 2, totalCents: 15000 },
          { description: 'مشروب', quantity: 1, totalCents: 4000 },
        ],
        subtotalCents: 19000,
        discountCents: 0,
        taxCents: 0,
        totalCents: 19000,
        payments: [{ method: 'cash', amountCents: 19000, kind: 'payment' }],
        paidCents: 19000,
        whiteLabel,
      }),
    [values, settings, businessName, fallbackPhone, currency, whiteLabel],
  );

  function save() {
    const parsed = receiptSettingsSchema.safeParse(values);
    if (!parsed.success) {
      const fe = parsed.error.flatten().fieldErrors;
      setErrors(Object.fromEntries(Object.entries(fe).map(([k, v]) => [k, v?.[0]])) as Partial<Record<Key, string>>);
      toast.error('راجع الحقول المعلَّمة');
      return;
    }
    startTransition(async () => {
      const result = await saveReceiptSettingsAction(scope, parsed.data);
      if (!result.ok) {
        if (result.fieldErrors) {
          setErrors(Object.fromEntries(Object.entries(result.fieldErrors).map(([k, v]) => [k, v?.[0]])) as Partial<Record<Key, string>>);
        }
        toast.error(result.error);
        return;
      }
      toast.success('تم حفظ بيانات الإيصال');
    });
  }

  const input = (key: Key, label: string, opts: { hint?: string; placeholder?: string; ltr?: boolean; max?: number } = {}) => (
    <Field label={label} hint={opts.hint} error={errors[key] ? [errors[key]!] : undefined}>
      {(p) => (
        <Input
          {...p}
          value={values[key]}
          onChange={set(key)}
          placeholder={opts.placeholder}
          maxLength={opts.max}
          dir={opts.ltr ? 'ltr' : undefined}
          data-testid={`receipt-${key}`}
        />
      )}
    </Field>
  );

  const note = (key: 'headerNote' | 'footerNote', label: string, hint: string) => (
    <Field label={label} hint={hint} error={errors[key] ? [errors[key]!] : undefined}>
      {(p) => (
        <Textarea {...p} rows={3} maxLength={300} value={values[key]} onChange={set(key)} data-testid={`receipt-${key}`} />
      )}
    </Field>
  );

  return (
    <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>البيانات الرسمية للنشاط</CardTitle>
          </CardHeader>
          <CardBody className="space-y-3">
            <p className="text-sm text-muted">تظهر على إيصالات كل الفروع.</p>
            {input('legalName', 'الاسم القانوني للنشاط', { hint: 'اتركه فارغًا لو مطابق لاسم المطعم', max: 120 })}
            <div className="grid gap-3 sm:grid-cols-2">
              {input('commercialRegistration', 'رقم السجل التجاري', { ltr: true, max: 32, placeholder: '123456' })}
              {input('taxId', 'رقم التسجيل الضريبي', { ltr: true, max: 32, placeholder: '123-456-789' })}
            </div>
            {note('headerNote', 'ملاحظة أعلى الإيصال', 'حتى 4 أسطر · 300 حرف')}
            {note('footerNote', 'ملاحظة أسفل الإيصال', 'تحل محل «شكرًا لزيارتكم» · حتى 4 أسطر')}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>بيانات هذا الفرع: {settings.branchName}</CardTitle>
          </CardHeader>
          <CardBody className="space-y-3">
            <p className="text-sm text-muted">لكل فرع بياناته. الحقول الفارغة تأخذ بيانات الفرع الأساسية.</p>
            {input('branchDisplayName', 'اسم الفرع على الإيصال', { placeholder: settings.branchName, max: 120 })}
            {input('branchAddress', 'العنوان', { placeholder: settings.branchDefaultAddress ?? 'مثال: 12 شارع التحرير، الدقي', max: 200 })}
            {input('branchPhone', 'رقم الهاتف', { ltr: true, placeholder: settings.branchDefaultPhone ?? fallbackPhone ?? '01000000000', max: 32 })}
          </CardBody>
        </Card>

        <Button onClick={save} disabled={isPending} className="w-full sm:w-auto sm:px-8" data-testid="receipt-save">
          {isPending ? 'جارٍ الحفظ…' : 'حفظ البيانات'}
        </Button>
      </div>

      <Card className="h-fit lg:sticky lg:top-4">
        <CardHeader>
          <CardTitle>معاينة الإيصال</CardTitle>
        </CardHeader>
        <CardBody className="space-y-2">
          <iframe
            title="معاينة الإيصال"
            sandbox=""
            srcDoc={mounted ? preview : ''}
            className="h-[560px] w-full rounded border border-line bg-white"
            data-testid="receipt-preview"
          />
          <p className="text-xs text-muted">
            هذا إيصال داخلي وليس فاتورة ضريبية. إظهار رقم التسجيل الضريبي لا يغيّر ذلك، ويبقى التنويه القانوني مطبوعًا.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
