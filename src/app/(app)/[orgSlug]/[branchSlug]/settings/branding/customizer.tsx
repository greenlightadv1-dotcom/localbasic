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
import { brandThemeVars, DEFAULT_PRIMARY, DEFAULT_SECONDARY } from '@/lib/theme/brand-theme';
import { updateBrandingAction } from './actions';

type Scope = { organizationSlug: string; branchSlug: string };

/**
 * The Brand & Theme customizer.
 *
 * Name, logo and contact details for every plan; brand COLORS only on plans
 * that include them (Growth and above). On Basic the color pickers are locked
 * and the store's menu uses the LocalBasic palette — the saved colors are kept,
 * so upgrading brings them straight back. The lock here is presentation; the
 * database serves the effective colors to every public page, and
 * updateBranding() ignores a color change from a plan without them.
 *
 * The preview is rendered with the same theme function and the same token
 * classes the real menu uses (lib/theme/brand-theme.ts), so what shows here is
 * what guests get, updating on every keystroke.
 */
export function Customizer({
  scope,
  organizationId,
  whiteLabel,
  customColors,
  description,
  initial,
}: {
  scope: Scope;
  organizationId: string;
  whiteLabel: boolean;
  /** Whether the plan lets the store use its own colors. */
  customColors: boolean;
  /** The store's one-line description, shown in the preview (edited below). */
  description: string;
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

  // What guests will actually see: the store's colors on a plan that has
  // them, the LocalBasic palette otherwise.
  const previewStyle = brandThemeVars(
    customColors ? primaryColor : DEFAULT_PRIMARY,
    customColors ? secondaryColor : DEFAULT_SECONDARY,
  ) as React.CSSProperties;

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

          <div className="space-y-2">
            <div className="grid gap-4 sm:grid-cols-2">
              <ColorField label="اللون الأساسي" value={primaryColor} onChange={setPrimaryColor} disabled={!customColors} />
              <ColorField label="اللون الثانوي" value={secondaryColor} onChange={setSecondaryColor} disabled={!customColors} />
            </div>
            {customColors ? (
              <p className="text-xs text-muted">
                يُطبَّق اللون الأساسي على الأزرار والشارات والتبويب النشط في المنيو.
              </p>
            ) : (
              <p className="rounded-lg bg-primary-soft px-3 py-2 text-xs font-semibold text-primary" data-testid="colors-locked">
                ألوان علامتك التجارية متاحة في باقة نمو وما فوقها. حتى ذلك الحين يظهر منيوك بألوان
                LocalBasic الافتراضية، ويُحفظ اختيارك لتعود ألوانك فور الترقية.
              </p>
            )}
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
          <CardTitle>معاينة المنيو</CardTitle>
        </CardHeader>
        <CardBody>
          <div
            style={previewStyle}
            className="relative mx-auto max-w-xs overflow-hidden rounded-[26px] border border-line bg-bg text-fg shadow-[0_10px_30px_rgba(0,0,0,.08)]"
            aria-label="معاينة شكل المنيو على الهاتف"
          >
            <div className="flex items-center gap-3 px-4 pb-2 pt-4">
              {logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- a Storage URL or external one, not a build asset.
                <img src={logoUrl} alt="" className="h-11 w-11 rounded-full border border-line object-cover" />
              ) : (
                <span className="flex h-11 w-11 items-center justify-center rounded-full bg-primary text-sm font-extrabold text-primary-fg">
                  {(displayName || 'م').slice(0, 2)}
                </span>
              )}
              <div className="min-w-0">
                <p className="truncate text-base font-extrabold">{displayName || 'اسم المطعم'}</p>
                <p className="truncate text-xs text-muted">{description || 'وصف مختصر لمطعمك'}</p>
              </div>
            </div>

            <div className="flex gap-3 border-b border-line px-4 py-2.5">
              {['برجر', 'مشروبات', 'حلويات'].map((c, i) => (
                <div key={c} className="flex flex-col items-center gap-1">
                  <span
                    className={`h-10 w-10 rounded-full bg-surface ring-2 ring-offset-2 ring-offset-bg ${
                      i === 0 ? 'ring-primary' : 'ring-transparent'
                    }`}
                  />
                  <span className={`text-[10px] font-semibold ${i === 0 ? 'text-primary' : 'text-muted'}`}>{c}</span>
                </div>
              ))}
            </div>

            <div className="grid grid-cols-2 gap-2.5 p-3 pb-20">
              {[{ n: 'برجر كلاسيك', p: '95' }, { n: 'بطاطس مقرمشة', p: '40' }].map((it) => (
                <div key={it.n} className="overflow-hidden rounded-lg border border-line bg-elevated">
                  <div className="relative aspect-[4/3] bg-surface">
                    <span className="absolute bottom-1.5 end-1.5 flex h-8 w-8 items-center justify-center rounded-full bg-primary text-lg font-extrabold text-primary-fg">
                      +
                    </span>
                  </div>
                  <div className="p-2">
                    <p className="text-xs font-bold">{it.n}</p>
                    <p className="lb-numeric text-xs font-extrabold text-primary">{it.p} ج.م</p>
                  </div>
                </div>
              ))}
            </div>

            <div className="absolute inset-x-3 bottom-3 flex h-12 items-center justify-between rounded-full bg-primary px-4 text-primary-fg shadow-lg">
              <span className="text-sm font-bold">عرض السلة (2)</span>
              <span className="lb-numeric text-sm font-extrabold">135 ج.م</span>
            </div>
          </div>
          <p className="mt-3 text-center text-xs text-muted">
            هكذا يرى ضيوفك المنيو على الهاتف، بالألوان التي تنطبق على باقتك.
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
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
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
          disabled={disabled}
          className="h-11 w-11 shrink-0 cursor-pointer rounded border border-line bg-elevated p-1 disabled:cursor-not-allowed disabled:opacity-40"
        />
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          dir="ltr"
          maxLength={7}
          disabled={disabled}
          className="lb-numeric"
        />
      </div>
    </div>
  );
}
