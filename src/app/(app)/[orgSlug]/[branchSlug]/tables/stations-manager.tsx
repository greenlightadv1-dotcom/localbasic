'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/ui/confirm';
import { useToast } from '@/components/ui/toast';
import type { Station } from '@/modules/restaurant/stations/service';
import {
  createStationAction,
  setStationActiveAction,
  deleteStationAction,
} from '../restaurant-actions';

const KIND_LABELS: Record<'kitchen' | 'bar', string> = { kitchen: 'مطبخ', bar: 'بار' };

/**
 * Multiple kitchens and bars, each with its own optional network printer.
 * A menu item routes here automatically from its category (kitchen/bar), or
 * a product can name one of these stations directly — see menu-manager.tsx.
 */
export function StationsManager({
  stations,
  canManage,
  organizationSlug,
  branchSlug,
}: {
  stations: Station[];
  canManage: boolean;
  organizationSlug: string;
  branchSlug: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [isPending, startTransition] = useTransition();
  const [deleting, setDeleting] = useState<Station | null>(null);
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

  return (
    <Card>
      <CardHeader>
        <CardTitle>محطات المطبخ والبار</CardTitle>
      </CardHeader>
      <CardBody className="space-y-4">
        {canManage && (
          <form
            action={(formData) =>
              run(
                createStationAction(scope, {
                  name: formData.get('name'),
                  kind: formData.get('kind'),
                  printerIp: formData.get('printerIp') || '',
                  printerPort: formData.get('printerPort') || 9100,
                  sortOrder: stations.length,
                }),
                'تمت إضافة المحطة',
              )
            }
            className="grid gap-2 sm:grid-cols-4"
          >
            <Field label="اسم المحطة">
              {(p) => <Input {...p} name="name" placeholder="المطبخ الرئيسي، البار…" required />}
            </Field>
            <Field label="النوع">
              {(p) => (
                <Select {...p} name="kind" defaultValue="kitchen">
                  <option value="kitchen">مطبخ</option>
                  <option value="bar">بار</option>
                </Select>
              )}
            </Field>
            <Field label="عنوان طابعة الشبكة" hint="اختياري">
              {(p) => <Input {...p} name="printerIp" placeholder="192.168.1.50" dir="ltr" />}
            </Field>
            <div className="flex items-end gap-2">
              <input type="hidden" name="printerPort" value={9100} />
              <Button type="submit" disabled={isPending}>
                إضافة
              </Button>
            </div>
          </form>
        )}

        {stations.length === 0 ? (
          <p className="text-sm text-muted">
            لا توجد محطات بعد. بدون محطة، تُصنَّف الأصناف تلقائيًا مطبخ/بار على الشاشة فقط، بدون طباعة.
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {stations.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-3 py-2.5">
                <span className="font-semibold text-fg">{s.name}</span>
                <Badge tone={s.kind === 'bar' ? 'info' : 'warn'}>{KIND_LABELS[s.kind]}</Badge>
                {s.printerIp ? (
                  <span className="text-xs text-muted" dir="ltr">
                    {s.printerIp}:{s.printerPort}
                  </span>
                ) : (
                  <span className="text-xs text-muted">بدون طابعة</span>
                )}
                {!s.isActive && <Badge tone="neutral">معطّلة</Badge>}
                {canManage && (
                  <span className="ms-auto flex gap-1.5">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={isPending}
                      onClick={() =>
                        run(
                          setStationActiveAction(scope, { stationId: s.id, isActive: !s.isActive }),
                          s.isActive ? 'تم تعطيل المحطة' : 'تم تفعيل المحطة',
                        )
                      }
                    >
                      {s.isActive ? 'تعطيل' : 'تفعيل'}
                    </Button>
                    <Button size="sm" variant="ghost" className="text-danger" onClick={() => setDeleting(s)}>
                      حذف
                    </Button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardBody>

      <ConfirmDialog
        open={deleting !== null}
        title={`حذف محطة ${deleting?.name ?? ''}`}
        description="الأصناف الموجّهة لهذه المحطة تعود للتوجيه التلقائي حسب التصنيف. لا يُحذف أي صنف أو طلب."
        confirmLabel="حذف"
        busy={isPending}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (!deleting) return;
          const stationId = deleting.id;
          setDeleting(null);
          run(deleteStationAction(scope, { stationId }), 'تم حذف المحطة');
        }}
      />
    </Card>
  );
}
