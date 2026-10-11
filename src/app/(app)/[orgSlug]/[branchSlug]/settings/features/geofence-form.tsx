'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/components/ui/toast';
import { getBrowserLocation } from '@/modules/restaurant/guest-verification/geolocation';
import { saveGeofenceAction } from './actions';

/**
 * Where the branch is, for the QR hard stop and the online advisory flag
 * (0081). "استخدم موقعي الحالي" reads the owner's own browser location while
 * they stand at the restaurant setting this up — no paid maps or geocoding
 * API, the same zero-cost pattern the rest of this feature uses.
 */
export function GeofenceForm({
  scope,
  initialLatitude,
  initialLongitude,
  initialRadiusM,
}: {
  scope: { organizationSlug: string; branchSlug: string };
  initialLatitude: number | null;
  initialLongitude: number | null;
  initialRadiusM: number;
}) {
  const [latitude, setLatitude] = useState(initialLatitude?.toString() ?? '');
  const [longitude, setLongitude] = useState(initialLongitude?.toString() ?? '');
  const [radiusM, setRadiusM] = useState(String(initialRadiusM));
  const [isPending, startTransition] = useTransition();
  const [locating, setLocating] = useState(false);
  const toast = useToast();

  async function useCurrentLocation() {
    setLocating(true);
    const pos = await getBrowserLocation();
    setLocating(false);
    if (!pos) {
      toast.error('تعذّر الوصول إلى الموقع. فعّل صلاحية الموقع في المتصفح.');
      return;
    }
    setLatitude(pos.latitude.toFixed(6));
    setLongitude(pos.longitude.toFixed(6));
  }

  function save() {
    startTransition(async () => {
      const result = await saveGeofenceAction(scope, {
        latitude, longitude, radiusM, scope: 'branch',
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success('تم حفظ موقع الفرع');
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>موقع الفرع (للتحقق من الطلبات)</CardTitle>
      </CardHeader>
      <CardBody className="space-y-3">
        <p className="text-sm text-muted">
          يُستخدم للتأكد أن طلب الطاولة (QR) يصل من داخل المطعم فعليًا، وللإشارة في طلبات
          التوصيل والاستلام إذا كان العميل بعيدًا. بدون ضبط الموقع لا يُطبَّق أي تحقق.
        </p>
        <Button type="button" variant="outline" onClick={useCurrentLocation} disabled={locating}>
          {locating ? 'جارٍ تحديد الموقع…' : 'استخدم موقعي الحالي'}
        </Button>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium">خط العرض</span>
            <Input dir="ltr" value={latitude} onChange={(e) => setLatitude(e.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium">خط الطول</span>
            <Input dir="ltr" value={longitude} onChange={(e) => setLongitude(e.target.value)} />
          </label>
        </div>
        <label className="block">
          <span className="mb-1 block text-xs font-medium">نطاق القبول (متر)</span>
          <Input dir="ltr" value={radiusM} onChange={(e) => setRadiusM(e.target.value)} />
        </label>
        <Button type="button" onClick={save} disabled={isPending || !latitude || !longitude}>
          {isPending ? 'جارٍ الحفظ…' : 'حفظ'}
        </Button>
      </CardBody>
    </Card>
  );
}
