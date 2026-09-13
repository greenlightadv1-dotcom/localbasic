'use client';

import { useState } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import { Stethoscope, Wrench, UtensilsCrossed, ShoppingBag } from 'lucide-react';
import { Card, CardBody } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/cn';
import { provisionWorkspaceAction, type OnboardingState } from './actions';

const MODULES = [
  {
    key: 'restaurant',
    name: 'مطعم / كافيه',
    description: 'طاولات وQR ومنيو وطلبات ومطبخ وكاشير',
    Icon: UtensilsCrossed,
    available: true,
  },
  {
    key: 'retail',
    name: 'متجر / تجزئة',
    description: 'منتجات ومخزون ونقطة بيع',
    Icon: ShoppingBag,
    available: true,
  },
  {
    key: 'medical',
    name: 'عيادة',
    description: 'أطباء ومواعيد وملفات مرضى ووصفات',
    Icon: Stethoscope,
    available: false,
  },
  {
    key: 'workshop',
    name: 'ورشة / صيانة',
    description: 'مركبات وأوامر شغل وفنيين وقطع غيار',
    Icon: Wrench,
    available: false,
  },
] as const;

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" block disabled={pending}>
      {pending ? 'جارٍ التجهيز…' : 'إنشاء مساحة العمل'}
    </Button>
  );
}

/** Latin slug suggestion from the business name; Arabic names yield nothing,
 *  so the field stays for the user to fill rather than guessing badly. */
function suggestSlug(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base.length >= 3 ? base : '';
}

export function OnboardingForm() {
  const [state, formAction] = useFormState<OnboardingState, FormData>(
    provisionWorkspaceAction,
    undefined,
  );
  const [moduleKey, setModuleKey] = useState<string>('restaurant');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);

  return (
    <Card>
      <CardBody className="space-y-6 p-6">
        <div className="space-y-1">
          <h1 className="text-lg font-bold">جهّز مساحة عملك</h1>
          <p className="text-sm text-muted">
            اختر نوع النشاط وأدخل بياناته. يمكنك إضافة فروع ومستخدمين لاحقًا.
          </p>
        </div>

        {state?.error && <Alert tone="danger">{state.error}</Alert>}

        <form action={formAction} className="space-y-6">
          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm font-medium text-fg">نوع النشاط</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {MODULES.map(({ key, name, description, Icon, available }) => {
                const selected = moduleKey === key;
                return (
                  <label
                    key={key}
                    className={cn(
                      'flex cursor-pointer items-start gap-3 rounded border p-3 transition-colors',
                      selected ? 'border-primary bg-primary-soft' : 'border-line bg-elevated hover:bg-surface',
                      !available && 'cursor-not-allowed opacity-55',
                    )}
                  >
                    <input
                      type="radio"
                      name="moduleKey"
                      value={key}
                      checked={selected}
                      disabled={!available}
                      onChange={() => setModuleKey(key)}
                      className="sr-only"
                    />
                    <Icon
                      className={cn('mt-0.5 h-5 w-5 shrink-0', selected ? 'text-primary' : 'text-muted')}
                      aria-hidden="true"
                    />
                    <span className="space-y-0.5">
                      <span className="flex items-center gap-2 text-sm font-semibold">
                        {name}
                        {!available && <Badge tone="neutral">قريبًا</Badge>}
                      </span>
                      <span className="block text-xs text-muted">{description}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="اسم النشاط" required error={state?.fieldErrors?.organizationName}>
              {(p) => (
                <Input
                  {...p}
                  name="organizationName"
                  required
                  maxLength={120}
                  onChange={(e) => {
                    if (!slugTouched) setSlug(suggestSlug(e.target.value));
                  }}
                />
              )}
            </Field>

            <Field
              label="المعرّف"
              required
              hint="يظهر في الرابط: localbasic.app/المعرّف"
              error={state?.fieldErrors?.slug}
            >
              {(p) => (
                <Input
                  {...p}
                  name="slug"
                  dir="ltr"
                  required
                  value={slug}
                  onChange={(e) => {
                    setSlugTouched(true);
                    setSlug(e.target.value.toLowerCase());
                  }}
                  pattern="[a-z0-9][a-z0-9-]{1,48}[a-z0-9]"
                />
              )}
            </Field>

            <Field label="اسم الفرع الأول" error={state?.fieldErrors?.branchName}>
              {(p) => <Input {...p} name="branchName" placeholder="الفرع الرئيسي" maxLength={120} />}
            </Field>

            <Field label="العملة" error={state?.fieldErrors?.currency}>
              {(p) => (
                <Select {...p} name="currency" defaultValue="EGP">
                  <option value="EGP">جنيه مصري (EGP)</option>
                  <option value="SAR">ريال سعودي (SAR)</option>
                  <option value="AED">درهم إماراتي (AED)</option>
                  <option value="USD">دولار أمريكي (USD)</option>
                </Select>
              )}
            </Field>
          </div>

          <input type="hidden" name="country" value="EG" />
          <input type="hidden" name="timezone" value="Africa/Cairo" />

          <SubmitButton />
        </form>
      </CardBody>
    </Card>
  );
}
