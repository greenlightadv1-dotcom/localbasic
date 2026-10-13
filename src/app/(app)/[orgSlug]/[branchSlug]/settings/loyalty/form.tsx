'use client';

import { useState, useTransition } from 'react';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import type { LoyaltySettings } from '@/modules/restaurant/loyalty/service';
import { saveLoyaltyAction } from './actions';

export function LoyaltyForm({
  scope,
  currency,
  settings,
}: {
  scope: { organizationSlug: string; branchSlug: string };
  currency: string;
  settings: LoyaltySettings;
}) {
  const toast = useToast();
  const [isPending, startTransition] = useTransition();
  const [enabled, setEnabled] = useState(settings.enabled);
  const [perPoint, setPerPoint] = useState(String(settings.centsPerPoint / 100));
  const [rewardPoints, setRewardPoints] = useState(String(settings.rewardPoints));
  const [rewardValue, setRewardValue] = useState(String(settings.rewardValueCents / 100));
  const [validDays, setValidDays] = useState(String(settings.couponValidDays));

  const per = Number(perPoint) || 0;
  const pts = Number(rewardPoints) || 0;
  // What a customer must spend to earn one reward — shown so the owner can
  // sanity-check the economics before saving.
  const spendPerReward = per * pts;

  function save() {
    startTransition(async () => {
      const result = await saveLoyaltyAction(scope, {
        enabled,
        currencyPerPoint: perPoint,
        rewardPoints,
        rewardValue,
        couponValidDays: validDays,
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success('تم حفظ إعدادات المكافآت');
    });
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
      <Card>
        <CardHeader>
          <CardTitle>برنامج المكافآت</CardTitle>
        </CardHeader>
        <CardBody className="space-y-4">
          <label className="flex cursor-pointer items-start justify-between gap-4 rounded border border-line bg-surface p-4">
            <span>
              <span className="block font-semibold text-fg">تفعيل نقاط المكافآت</span>
              <span className="mt-0.5 block text-sm text-muted">
                يكسب العميل نقاطًا عن كل طلب مكتمل، ويستبدلها بكوبون خصم يطبّقه الكاشير عند الدفع.
              </span>
            </span>
            <input
              type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)}
              className="mt-1 h-6 w-6 shrink-0 rounded border-line accent-primary"
            />
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={`كل كم (${currency}) تساوي نقطة؟`} hint="مثال: 10 = نقطة لكل 10 جنيه">
              {(p) => <Input {...p} value={perPoint} onChange={(e) => setPerPoint(e.target.value)} inputMode="decimal" dir="ltr" />}
            </Field>
            <Field label="النقاط المطلوبة للمكافأة">
              {(p) => <Input {...p} value={rewardPoints} onChange={(e) => setRewardPoints(e.target.value)} inputMode="numeric" dir="ltr" />}
            </Field>
            <Field label={`قيمة الخصم (${currency})`}>
              {(p) => <Input {...p} value={rewardValue} onChange={(e) => setRewardValue(e.target.value)} inputMode="decimal" dir="ltr" />}
            </Field>
            <Field label="صلاحية الكوبون (أيام)">
              {(p) => <Input {...p} value={validDays} onChange={(e) => setValidDays(e.target.value)} inputMode="numeric" dir="ltr" />}
            </Field>
          </div>

          <Button onClick={save} disabled={isPending} className="w-full sm:w-auto sm:px-8">
            {isPending ? 'جارٍ الحفظ…' : 'حفظ الإعدادات'}
          </Button>
        </CardBody>
      </Card>

      <Card className="h-fit">
        <CardHeader>
          <CardTitle>كيف يعمل</CardTitle>
        </CardHeader>
        <CardBody className="space-y-2 text-sm text-muted">
          <p>
            لكي يحصل العميل على خصم {Number(rewardValue) || 0} {currency} عليه أن ينفق تقريبًا{' '}
            <strong className="text-fg">{spendPerReward.toLocaleString('ar-EG')} {currency}</strong> في طلبات مكتملة.
          </p>
          <p>النقاط تُحسب من الطلبات المكتملة فقط، وتُخصم عند استبدالها بكوبون.</p>
          <p>
            الكاشير يدخل كود الكوبون في شاشة التحصيل، فيُطبَّق الخصم ويُستهلك الكود مرة واحدة،
            ولا يصلح إلا لصاحبه. يحتاج الكاشير صلاحية الخصم.
          </p>
          <p>تغيير «كل كم تساوي نقطة» يُعاد حسابه على كل الطلبات السابقة.</p>
        </CardBody>
      </Card>
    </div>
  );
}
