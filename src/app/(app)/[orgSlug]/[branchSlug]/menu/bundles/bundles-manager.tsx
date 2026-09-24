'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Gift } from 'lucide-react';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Field, Input, Textarea } from '@/components/ui/field';
import { Badge } from '@/components/ui/badge';
import { Alert } from '@/components/ui/alert';
import { EmptyState } from '@/components/patterns/states';
import { useToast } from '@/components/ui/toast';
import { formatMoney } from '@/lib/money';
import type { Bundle } from '@/modules/restaurant/bundles/service';
import { createBundleAction, toggleBundleActiveAction } from './actions';

type Scope = { organizationSlug: string; branchSlug: string };

export function BundlesManager({
  bundles,
  currency,
  canManage,
  organizationSlug,
  branchSlug,
}: {
  bundles: Bundle[];
  currency: string;
  canManage: boolean;
  organizationSlug: string;
  branchSlug: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const scope: Scope = { organizationSlug, branchSlug };

  function addBundle(formData: FormData) {
    setError(null);
    startTransition(async () => {
      const result = await createBundleAction(scope, {
        name: formData.get('name'),
        description: formData.get('description') || '',
        imageUrl: formData.get('imageUrl') || '',
        priceCents: formData.get('price') || '0',
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast.success('تمت إضافة الباقة');
      (document.getElementById('bundle-form') as HTMLFormElement | null)?.reset();
      router.refresh();
    });
  }

  function toggleActive(bundleId: string, isActive: boolean) {
    startTransition(async () => {
      const result = await toggleBundleActiveAction(scope, { bundleId, isActive });
      if (!result.ok) toast.error(result.error);
      else router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle>باقة جديدة</CardTitle>
          </CardHeader>
          <CardBody>
            {error && (
              <Alert tone="danger" className="mb-3">
                {error}
              </Alert>
            )}
            <form id="bundle-form" action={addBundle} className="grid gap-3 sm:grid-cols-2">
              <Field label="الاسم" required>
                {(p) => <Input {...p} name="name" required maxLength={200} />}
              </Field>
              <Field label="السعر الشامل" required>
                {(p) => <Input {...p} name="price" type="text" inputMode="decimal" required />}
              </Field>
              <div className="sm:col-span-2">
                <Field label="رابط الصورة">
                  {(p) => <Input {...p} name="imageUrl" type="url" dir="ltr" placeholder="https://…" />}
                </Field>
              </div>
              <div className="sm:col-span-2">
                <Field label="وصف المحتويات">
                  {(p) => <Textarea {...p} name="description" rows={2} maxLength={1000} />}
                </Field>
              </div>
              <div className="sm:col-span-2">
                <Button type="submit" size="sm" disabled={isPending}>
                  {isPending ? '…' : 'إضافة الباقة'}
                </Button>
              </div>
            </form>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>الباقات</CardTitle>
        </CardHeader>
        {bundles.length === 0 ? (
          <EmptyState icon={Gift} title="لا توجد باقات بعد" />
        ) : (
          <CardBody className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">الباقات والعروض</caption>
                <thead>
                  <tr className="border-b border-line text-xs text-muted">
                    <th scope="col" className="p-3 text-start font-medium">الاسم</th>
                    <th scope="col" className="p-3 text-start font-medium">السعر</th>
                    {canManage && <th scope="col" className="p-3 text-start font-medium">الحالة</th>}
                  </tr>
                </thead>
                <tbody>
                  {bundles.map((b) => (
                    <tr key={b.id} className="border-b border-line last:border-0">
                      <td className="p-3">
                        <span className="font-medium">{b.name}</span>
                        {b.description && (
                          <p className="mt-0.5 text-xs text-muted">{b.description}</p>
                        )}
                      </td>
                      <td className="lb-numeric p-3">{formatMoney(b.priceCents, currency)}</td>
                      {canManage && (
                        <td className="p-3">
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={isPending}
                            onClick={() => toggleActive(b.id, !b.isActive)}
                          >
                            {b.isActive ? (
                              <Badge tone="success">مفعّلة</Badge>
                            ) : (
                              <Badge tone="neutral">موقوفة</Badge>
                            )}
                          </Button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardBody>
        )}
      </Card>
    </div>
  );
}
