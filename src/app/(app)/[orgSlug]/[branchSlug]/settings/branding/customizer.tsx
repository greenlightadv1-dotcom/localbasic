'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/components/ui/toast';
import { ImageUpload } from '@/components/patterns/image-upload';
import { hexToRgbChannels } from '@/lib/color';
import { updateBrandingAction } from './actions';

type Scope = { organizationSlug: string; branchSlug: string };

/**
 * The Site Customizer.
 *
 * Everything a restaurant's identity is made of — logo, colors, contact
 * numbers — in one screen with one save, and a preview that updates from
 * local state on every keystroke rather than waiting on a round trip. That
 * instant feedback is the entire point of a screen like this; a save button
 * that has to finish before you see the result is not a customizer, it is a
 * form.
 *
 * The preview is honest about what it is: the same CSS-variable mechanism
 * (`hexToRgbChannels`, `--brand-*`) the actual ordering storefront and the
 * Site Engine renderer use, applied to a static mockup of a hero and a
 * button here — not an iframe of the real site. Building a live embedded
 * preview of the real storefront/site pages is real, further work (true
 * bidirectional sync with the section editor), noted rather than faked.
 */
export function Customizer({
  scope,
  organizationId,
  whiteLabel,
  initial,
}: {
  scope: Scope;
  organizationId: string;
  whiteLabel: boolean;
  initial: {
    displayName: string;
    logoUrl: string | null;
    primaryColor: string;
    secondaryColor: string;
    phone: string;
    whatsapp: string;
    email: string;
  };
}) {
  const router = useRouter();
  const toast = useToast();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [displayName, setDisplayName] = useState(initial.displayName);
  const [logoUrl, setLogoUrl] = useState<string | null>(initial.logoUrl);
  const [primaryColor, setPrimaryColor] = useState(initial.primaryColor);
  const [secondaryColor, setSecondaryColor] = useState(initial.secondaryColor);
  const [phone, setPhone] = useState(initial.phone);
  const [whatsapp, setWhatsapp] = useState(initial.whatsapp);
  const [email, setEmail] = useState(initial.email);

  function save() {
    setError(null);
    startTransition(async () => {
      const result = await updateBrandingAction(scope, {
        displayName,
        logoUrl,
        primaryColor,
        secondaryColor,
        phone: phone || null,
        whatsapp: whatsapp || null,
        email: email || null,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast.success('تم حفظ الهوية');
      router.refresh();
    });
  }

  const previewStyle = {
    ['--brand-primary' as string]: hexToRgbChannels(primaryColor),
    ['--brand-secondary' as string]: hexToRgbChannels(secondaryColor),
  };

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>هوية المطعم</CardTitle>
        </CardHeader>
        <CardBody className="space-y-4">
          {error && <Alert tone="danger">{error}</Alert>}

          <Field label="الاسم المعروض" required>
            {(p) => (
              <Input
                {...p}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                maxLength={120}
              />
            )}
          </Field>

          <ImageUpload
            organizationId={organizationId}
            purpose="logo"
            value={logoUrl}
            onChange={setLogoUrl}
            label="الشعار"
            aspectClassName="aspect-square"
          />

          <div className="grid gap-4 sm:grid-cols-2">
            <ColorField label="اللون الأساسي" value={primaryColor} onChange={setPrimaryColor} />
            <ColorField label="اللون الثانوي" value={secondaryColor} onChange={setSecondaryColor} />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="الهاتف">
              {(p) => (
                <Input {...p} value={phone} onChange={(e) => setPhone(e.target.value)} dir="ltr" maxLength={40} />
              )}
            </Field>
            <Field label="واتساب">
              {(p) => (
                <Input
                  {...p}
                  value={whatsapp}
                  onChange={(e) => setWhatsapp(e.target.value)}
                  dir="ltr"
                  maxLength={40}
                />
              )}
            </Field>
          </div>
          <Field label="البريد الإلكتروني">
            {(p) => (
              <Input {...p} type="email" value={email} onChange={(e) => setEmail(e.target.value)} dir="ltr" maxLength={160} />
            )}
          </Field>

          <div className="flex items-center justify-between border-t border-line pt-4">
            <div>
              <p className="text-xs text-muted">العلامة البيضاء</p>
              <Badge tone={whiteLabel ? 'success' : 'neutral'}>
                {whiteLabel ? 'مفعّلة' : 'غير مفعّلة — متاحة في الباقات الأعلى'}
              </Badge>
            </div>
            <Button onClick={save} disabled={isPending}>
              {isPending ? 'جارٍ الحفظ…' : 'حفظ التغييرات'}
            </Button>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>معاينة فورية</CardTitle>
        </CardHeader>
        <CardBody>
          <div
            style={previewStyle}
            className="overflow-hidden rounded-lg border border-line"
          >
            <div className="bg-[rgb(var(--brand-primary)/0.08)] px-6 py-10 text-center">
              {logoUrl && (
                // eslint-disable-next-line @next/next/no-img-element -- a Storage URL or external one, not a build asset.
                <img
                  src={logoUrl}
                  alt=""
                  className="mx-auto mb-4 h-16 w-16 rounded-full object-cover ring-2 ring-[rgb(var(--brand-primary))]"
                />
              )}
              <p className="text-xl font-extrabold text-fg">{displayName || 'اسم المطعم'}</p>
              <div className="mt-5 flex justify-center gap-2">
                <span className="rounded bg-[rgb(var(--brand-primary))] px-4 py-2 text-sm font-semibold text-white">
                  اطلب الآن
                </span>
                <span className="rounded border border-[rgb(var(--brand-secondary))] px-4 py-2 text-sm font-semibold text-[rgb(var(--brand-secondary))]">
                  تواصل معنا
                </span>
              </div>
            </div>
            <div className="space-y-2 p-4 text-sm text-muted">
              {phone && <p dir="ltr" className="lb-numeric">{phone}</p>}
              {whatsapp && <p dir="ltr" className="lb-numeric">واتساب: {whatsapp}</p>}
              {email && <p dir="ltr">{email}</p>}
              {!phone && !whatsapp && !email && <p>لا توجد بيانات تواصل بعد.</p>}
            </div>
          </div>
          <p className="mt-3 text-xs text-muted">
            هذه معاينة تقريبية بنفس الألوان الحقيقية. الألوان تُطبَّق فعليًا على صفحة الطلب
            والموقع الإلكتروني بمجرد الحفظ.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}

function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const valid = /^#[0-9a-fA-F]{6}$/.test(value);
  return (
    <div>
      <span className="mb-1.5 block text-xs font-semibold text-fg">{label}</span>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={valid ? value : '#000000'}
          onChange={(e) => onChange(e.target.value)}
          aria-label={label}
          className="h-11 w-11 shrink-0 cursor-pointer rounded border border-line bg-elevated p-1"
        />
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          dir="ltr"
          maxLength={7}
          className="lb-numeric"
        />
      </div>
    </div>
  );
}
