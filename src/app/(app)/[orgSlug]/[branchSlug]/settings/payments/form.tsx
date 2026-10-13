'use client';

import { useState, useTransition } from 'react';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import {
  CASH_LABEL, GATEWAYS, GATEWAY_KEYS, ONLINE_CHECKOUT_LIVE, isGatewayKey, type GatewayKey,
} from '@/modules/restaurant/payments/gateways';
import type { PaymentSettings } from '@/modules/restaurant/payments/service';
import { savePaymentSettingsAction } from './actions';

export function PaymentsForm({
  scope,
  settings,
}: {
  scope: { organizationSlug: string; branchSlug: string };
  settings: PaymentSettings;
}) {
  const toast = useToast();
  const [isPending, startTransition] = useTransition();
  const [cash, setCash] = useState(settings.cashEnabled);
  const [online, setOnline] = useState(settings.onlineEnabled);
  const [gateway, setGateway] = useState<GatewayKey | ''>(settings.gateway ?? '');
  // Public fields start from what is stored; secret fields always start empty
  // — the stored secret is never sent to the browser.
  const [values, setValues] = useState<Record<string, string>>({ ...settings.publicConfig });
  const [clearSecret, setClearSecret] = useState(false);

  const locked = !settings.planAllowsOnline;
  const def = gateway ? GATEWAYS[gateway] : null;
  const sameGateway = gateway !== '' && gateway === settings.gateway;
  const secretStored = sameGateway && settings.hasSecret && !clearSecret;

  function setValue(key: string, value: string) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  function save() {
    startTransition(async () => {
      const result = await savePaymentSettingsAction(scope, {
        cashEnabled: cash,
        onlineEnabled: online && !locked,
        gateway: gateway || null,
        values,
        clearSecret,
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      // Drop typed secrets from memory once they are saved.
      setValues((prev) => {
        const next = { ...prev };
        for (const f of def?.fields ?? []) if (f.secret) delete next[f.key];
        return next;
      });
      setClearSecret(false);
      toast.success('تم حفظ إعدادات الدفع');
    });
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
      <div className="space-y-4">
        <Card>
          <CardHeader className="flex flex-wrap items-center gap-2">
            <CardTitle>طرق الدفع</CardTitle>
            <Badge tone="success">الدفع النقدي مفعّل افتراضيًا</Badge>
          </CardHeader>
          <CardBody className="space-y-3">
            <label className="flex cursor-pointer items-start justify-between gap-4 rounded border border-line bg-surface p-4">
              <span>
                <span className="block font-semibold text-fg">{CASH_LABEL}</span>
                <span className="mt-0.5 block text-sm text-muted">
                  يدفع العميل للكاشير أو مع الكابتن أو عند وصول الطلب.
                  {!ONLINE_CHECKOUT_LIVE
                    ? ' لا يمكن إيقافه حاليًا لأن الدفع الإلكتروني لم يُفعَّل في صفحة الطلب بعد.'
                    : ''}
                </span>
              </span>
              <input
                type="checkbox"
                checked={cash}
                disabled={!ONLINE_CHECKOUT_LIVE}
                onChange={(e) => setCash(e.target.checked)}
                className="mt-1 h-6 w-6 shrink-0 rounded border-line accent-primary"
              />
            </label>

            <label
              className={`flex items-start justify-between gap-4 rounded border border-line bg-surface p-4 ${locked ? 'opacity-60' : 'cursor-pointer'}`}
            >
              <span>
                <span className="block font-semibold text-fg">
                  الدفع الإلكتروني (بطاقة / محفظة)
                  {locked ? <Badge tone="warn" className="me-2">باقة النمو أو الاحترافي</Badge> : null}
                </span>
                <span className="mt-0.5 block text-sm text-muted">
                  اربط بوابة الدفع الخاصة بك. {locked
                    ? 'ترقّ الباقة لتفعيل هذا الخيار.'
                    : 'تُعرض للعميل عند اكتمال الإعداد.'}
                </span>
              </span>
              <input
                type="checkbox"
                checked={online && !locked}
                disabled={locked}
                onChange={(e) => setOnline(e.target.checked)}
                className="mt-1 h-6 w-6 shrink-0 rounded border-line accent-primary"
              />
            </label>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>بوابة الدفع</CardTitle>
          </CardHeader>
          <CardBody className="space-y-4">
            <div>
              <label htmlFor="gateway" className="mb-1.5 block text-xs font-semibold text-fg">
                البوابة
              </label>
              <Select
                id="gateway"
                value={gateway}
                disabled={locked}
                onChange={(e) => {
                  const v = e.target.value;
                  setGateway(isGatewayKey(v) ? v : '');
                  setValues({});
                  setClearSecret(false);
                }}
              >
                <option value="">— بدون —</option>
                {GATEWAY_KEYS.map((k) => (
                  <option key={k} value={k}>{GATEWAYS[k].label}</option>
                ))}
              </Select>
              {def ? <p className="mt-1 text-xs text-muted">{def.hint}</p> : null}
            </div>

            {def && !locked ? (
              <div className="space-y-3">
                {def.fields.map((f) => (
                  <div key={f.key}>
                    <label htmlFor={`f-${f.key}`} className="mb-1.5 block text-xs font-semibold text-fg">
                      {f.label}
                      {f.secret ? <span className="ms-2 text-danger">سري</span> : null}
                    </label>
                    <Input
                      id={`f-${f.key}`}
                      dir="ltr"
                      type={f.secret ? 'password' : 'text'}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={
                        f.secret && secretStored
                          ? `${settings.secretHint ?? '••••'} — اتركه فارغًا للإبقاء عليه`
                          : f.placeholder
                      }
                      value={values[f.key] ?? ''}
                      onChange={(e) => setValue(f.key, e.target.value)}
                    />
                  </div>
                ))}
                <p className="text-xs text-muted">
                  المفاتيح السرية تُخزَّن مشفّرة ولا تظهر مرة أخرى بعد الحفظ. لتحديثها أدخل كل
                  المفاتيح السرية معًا.
                </p>
                {secretStored ? (
                  <button
                    type="button"
                    onClick={() => { setClearSecret(true); setOnline(false); }}
                    className="text-xs font-semibold text-danger underline"
                  >
                    حذف المفاتيح المخزّنة
                  </button>
                ) : null}
                {clearSecret ? (
                  <p className="text-xs text-danger">سيتم حذف المفاتيح عند الحفظ وإيقاف الدفع الإلكتروني.</p>
                ) : null}
              </div>
            ) : null}
          </CardBody>
        </Card>

        <Button onClick={save} disabled={isPending} className="w-full sm:w-auto sm:px-8">
          {isPending ? 'جارٍ الحفظ…' : 'حفظ الإعدادات'}
        </Button>
      </div>

      <Card className="h-fit">
        <CardHeader>
          <CardTitle>ماذا يرى العميل</CardTitle>
        </CardHeader>
        <CardBody className="space-y-2 text-sm">
          {cash ? <p className="rounded border border-line bg-surface p-3">✓ {CASH_LABEL}</p> : null}
          {online && !locked && gateway && (settings.hasSecret || Object.keys(values).length > 0) ? (
            <p className="rounded border border-line bg-surface p-3">
              ✓ بطاقة / محفظة ({GATEWAYS[gateway].label})
              {!ONLINE_CHECKOUT_LIVE ? <span className="text-muted"> — تظهر «قريبًا» حتى يُفعَّل الدفع الإلكتروني في صفحة الطلب</span> : null}
            </p>
          ) : null}
          <p className="text-xs text-muted">
            تُقرأ هذه الإعدادات من قاعدة البيانات في كل زيارة لصفحة الطلب، فلا حاجة لإعادة النشر.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
