'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { LayoutGrid, QrCode, RefreshCw, Copy, Check } from 'lucide-react';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/patterns/states';
import { ConfirmDialog } from '@/components/ui/confirm';
import { useToast } from '@/components/ui/toast';
import { Money } from '@/components/patterns/money';
import type { FloorTable } from '@/modules/restaurant/tables/service';
import { TABLE_STATUSES, type TableStatus } from '@/modules/restaurant/tables/schemas';
import {
  createSectionAction,
  createTableAction,
  createTableRangeAction,
  reissueTableQrAction,
  setTableStatusAction,
} from '../restaurant-actions';

const LABELS: Record<TableStatus, string> = {
  available: 'متاحة',
  reserved: 'محجوزة',
  occupied: 'مشغولة',
  waiting_payment: 'بانتظار الدفع',
  cleaning: 'تنظيف',
};

const TONES: Record<TableStatus, 'neutral' | 'info' | 'warn' | 'success' | 'danger'> = {
  available: 'success',
  reserved: 'info',
  occupied: 'warn',
  waiting_payment: 'danger',
  cleaning: 'neutral',
};

export function TablesManager({
  floor,
  sections,
  currency,
  canManage,
  canSetStatus,
  basePath,
  organizationSlug,
  branchSlug,
}: {
  floor: FloorTable[];
  sections: { id: string; name: string }[];
  currency: string;
  canManage: boolean;
  canSetStatus: boolean;
  basePath: string;
  organizationSlug: string;
  branchSlug: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [isPending, startTransition] = useTransition();
  const [reissuing, setReissuing] = useState<FloorTable | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const scope = { organizationSlug, branchSlug };

  function run(action: Promise<{ ok: boolean; error?: string }>, success: string) {
    startTransition(async () => {
      const result = await action;
      if (!result.ok) {
        toast.error(result.error ?? 'تعذّر تنفيذ العملية.');
        return;
      }
      toast.success(success);
      router.refresh();
    });
  }

  async function copyLink(url: string, id: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(id);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      toast.error('تعذّر نسخ الرابط.');
    }
  }

  return (
    <div className="space-y-4">
      {canManage && (
        <div className="grid gap-4 lg:grid-cols-3">
          <Card>
            <CardHeader>
              <CardTitle>منطقة جديدة</CardTitle>
            </CardHeader>
            <CardBody>
              <form
                action={(formData) =>
                  run(
                    createSectionAction(scope, {
                      name: formData.get('name'),
                      sortOrder: sections.length,
                    }),
                    'تمت إضافة المنطقة',
                  )
                }
                className="flex gap-2"
              >
                <div className="flex-1">
                  <label htmlFor="section-name" className="sr-only">
                    اسم المنطقة
                  </label>
                  <Input id="section-name" name="name" placeholder="الصالة، الشرفة…" required />
                </div>
                <Button type="submit" disabled={isPending}>
                  إضافة
                </Button>
              </form>
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>طاولة جديدة</CardTitle>
            </CardHeader>
            <CardBody>
              <form
                action={(formData) =>
                  run(
                    createTableAction(scope, {
                      name: formData.get('name'),
                      sectionId: formData.get('sectionId') || null,
                      seats: formData.get('seats') || 4,
                    }),
                    'تمت إضافة الطاولة مع رمز QR',
                  )
                }
                className="space-y-2"
              >
                <div className="flex gap-2">
                  <div className="flex-1">
                    <label htmlFor="table-name" className="sr-only">
                      رقم الطاولة
                    </label>
                    <Input id="table-name" name="name" placeholder="رقم / اسم" required />
                  </div>
                  <div className="w-20">
                    <label htmlFor="table-seats" className="sr-only">
                      المقاعد
                    </label>
                    <Input id="table-seats" name="seats" type="number" min={1} max={100} defaultValue={4} dir="ltr" />
                  </div>
                </div>
                <div className="flex gap-2">
                  <div className="flex-1">
                    <label htmlFor="table-section" className="sr-only">
                      المنطقة
                    </label>
                    <Select id="table-section" name="sectionId" defaultValue="">
                      <option value="">بدون منطقة</option>
                      {sections.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <Button type="submit" disabled={isPending}>
                    إضافة
                  </Button>
                </div>
              </form>
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>إنشاء دفعة</CardTitle>
            </CardHeader>
            <CardBody>
              <form
                action={(formData) =>
                  run(
                    createTableRangeAction(scope, {
                      from: formData.get('from'),
                      to: formData.get('to'),
                      seats: formData.get('seats') || 4,
                      sectionId: formData.get('sectionId') || null,
                    }),
                    'تم إنشاء الطاولات مع رموز QR',
                  )
                }
                className="space-y-2"
              >
                <div className="flex gap-2">
                  <Field label="من">
                    {(p) => <Input {...p} name="from" type="number" min={1} defaultValue={1} dir="ltr" />}
                  </Field>
                  <Field label="إلى">
                    {(p) => <Input {...p} name="to" type="number" min={1} defaultValue={10} dir="ltr" />}
                  </Field>
                </div>
                <input type="hidden" name="seats" value={4} />
                <Select name="sectionId" defaultValue="" aria-label="المنطقة">
                  <option value="">بدون منطقة</option>
                  {sections.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
                <Button type="submit" block disabled={isPending}>
                  إنشاء
                </Button>
              </form>
            </CardBody>
          </Card>
        </div>
      )}

      <Card>
        {floor.length === 0 ? (
          <EmptyState
            icon={LayoutGrid}
            title="لا توجد طاولات"
            description="أضف طاولة أو أنشئ دفعة كاملة، وسيتم توليد رمز QR لكل طاولة تلقائيًا."
          />
        ) : (
          <CardBody>
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
              {floor.map((table) => (
                <li key={table.id} className="space-y-3 rounded-lg border border-line p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-xl font-bold">{table.name}</p>
                      <p className="text-xs text-muted">
                        {table.sectionName ?? 'بدون منطقة'} · {table.seats} مقاعد
                      </p>
                    </div>
                    <Badge tone={TONES[table.status]}>{LABELS[table.status]}</Badge>
                  </div>

                  {table.openOrderCount > 0 && (
                    <p className="text-sm">
                      <Money cents={table.openTotalCents} currency={currency} />
                      <span className="ms-1 text-xs text-muted">({table.openOrderCount} طلب)</span>
                    </p>
                  )}

                  {canSetStatus && (
                    <>
                      <label htmlFor={`status-${table.id}`} className="sr-only">
                        حالة الطاولة {table.name}
                      </label>
                      <Select
                        id={`status-${table.id}`}
                        value={table.status}
                        disabled={isPending}
                        onChange={(e) =>
                          run(
                            setTableStatusAction(scope, {
                              tableId: table.id,
                              status: e.target.value as TableStatus,
                            }),
                            'تم تحديث حالة الطاولة',
                          )
                        }
                        className="h-9 text-sm"
                      >
                        {TABLE_STATUSES.map((status) => (
                          <option key={status} value={status}>
                            {LABELS[status]}
                          </option>
                        ))}
                      </Select>
                    </>
                  )}

                  <div className="flex flex-wrap gap-1.5 border-t border-line pt-3">
                    {table.publicUrl ? (
                      <>
                        <Link href={`${basePath}/tables/${table.id}/qr`}>
                          <Button size="sm" variant="outline">
                            <QrCode className="h-4 w-4" aria-hidden="true" />
                            رمز QR
                          </Button>
                        </Link>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => copyLink(table.publicUrl!, table.id)}
                        >
                          {copied === table.id ? (
                            <Check className="h-4 w-4 text-success" aria-hidden="true" />
                          ) : (
                            <Copy className="h-4 w-4" aria-hidden="true" />
                          )}
                          نسخ الرابط
                        </Button>
                      </>
                    ) : (
                      <Badge tone="warn">بدون QR</Badge>
                    )}
                    {canManage && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-danger"
                        onClick={() => setReissuing(table)}
                      >
                        <RefreshCw className="h-4 w-4" aria-hidden="true" />
                        تجديد
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </CardBody>
        )}
      </Card>

      <ConfirmDialog
        open={reissuing !== null}
        title={`تجديد رمز QR للطاولة ${reissuing?.name ?? ''}`}
        description="سيتوقف الرمز المطبوع الحالي عن العمل فورًا، وستحتاج لطباعة الرمز الجديد. استخدم هذا إذا فُقد الرمز أو تم لصقه على طاولة خاطئة."
        confirmLabel="تجديد الرمز"
        busy={isPending}
        onCancel={() => setReissuing(null)}
        onConfirm={() => {
          if (!reissuing) return;
          const tableId = reissuing.id;
          setReissuing(null);
          run(reissueTableQrAction(scope, { tableId }), 'تم تجديد رمز QR');
        }}
      />
    </div>
  );
}
