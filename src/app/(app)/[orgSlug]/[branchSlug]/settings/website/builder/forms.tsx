'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Alert } from '@/components/ui/alert';
import {
  BUTTON_STYLES, BUTTON_STYLE_LABELS, CONTAINER_WIDTHS, CONTAINER_WIDTH_LABELS,
  CTA_TARGETS, CTA_TARGET_LABELS, SECTION_LABELS, THEME_BACKGROUNDS,
  THEME_BACKGROUND_LABELS, THEME_FONTS, THEME_FONT_LABELS,
  type SectionType, type Theme, type WebsiteSection,
} from '@/modules/restaurant/website/builder-shared';
import {
  addSectionAction, moveSectionAction, publishAction, removeSectionAction,
  saveSectionAction, saveThemeAction, unpublishAction, type BuilderState,
} from './actions';

/**
 * The builder's interactive parts.
 *
 * Every one posts to a Server Action that re-resolves the tenant from the URL
 * and re-checks the permission. Nothing here decides anything: a rendered
 * button is not an authorised button.
 */

function Submit({ label, size }: { label: string; size?: 'sm' }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size={size} disabled={pending}>
      {pending ? '…' : label}
    </Button>
  );
}

function Scope({ orgSlug, branchSlug }: { orgSlug: string; branchSlug: string }) {
  return (
    <>
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="branchSlug" value={branchSlug} />
    </>
  );
}

export function AddSection({
  orgSlug, branchSlug, available,
}: {
  orgSlug: string;
  branchSlug: string;
  available: SectionType[];
}) {
  if (available.length === 0) {
    return <p className="text-sm text-muted">كل الأقسام المتاحة مضافة بالفعل.</p>;
  }
  return (
    <form action={addSectionAction} className="flex flex-wrap items-end gap-2">
      <Scope orgSlug={orgSlug} branchSlug={branchSlug} />
      <div className="min-w-48 flex-1">
        <Field label="أضف قسمًا">
          {(p) => (
            <Select {...p} name="type" defaultValue={available[0]}>
              {available.map((t) => (
                <option key={t} value={t}>{SECTION_LABELS[t]}</option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <Submit label="إضافة" />
    </form>
  );
}

export function MoveButtons({
  orgSlug, branchSlug, id, isFirst, isLast,
}: {
  orgSlug: string;
  branchSlug: string;
  id: string;
  isFirst: boolean;
  isLast: boolean;
}) {
  return (
    <span className="flex gap-1">
      <form action={moveSectionAction}>
        <Scope orgSlug={orgSlug} branchSlug={branchSlug} />
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="direction" value="up" />
        <Button type="submit" variant="outline" size="sm" disabled={isFirst} aria-label="تحريك لأعلى">
          ↑
        </Button>
      </form>
      <form action={moveSectionAction}>
        <Scope orgSlug={orgSlug} branchSlug={branchSlug} />
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="direction" value="down" />
        <Button type="submit" variant="outline" size="sm" disabled={isLast} aria-label="تحريك لأسفل">
          ↓
        </Button>
      </form>
    </span>
  );
}

export function RemoveSection({
  orgSlug, branchSlug, id,
}: {
  orgSlug: string;
  branchSlug: string;
  id: string;
}) {
  return (
    <form action={removeSectionAction}>
      <Scope orgSlug={orgSlug} branchSlug={branchSlug} />
      <input type="hidden" name="id" value={id} />
      <Button type="submit" variant="ghost" size="sm" className="text-danger hover:bg-danger/10">
        حذف
      </Button>
    </form>
  );
}

/** A checkbox that reads as a setting rather than as a form control. */
function Toggle({
  name, label, defaultChecked,
}: {
  name: string;
  label: string;
  defaultChecked: boolean;
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-fg">
      <input
        type="checkbox"
        name={name}
        defaultChecked={defaultChecked}
        className="h-4 w-4 accent-primary"
      />
      {label}
    </label>
  );
}

export function SectionForm({
  orgSlug, branchSlug, section,
}: {
  orgSlug: string;
  branchSlug: string;
  section: WebsiteSection;
}) {
  const [state, formAction] = useFormState<BuilderState, FormData>(saveSectionAction, undefined);
  const c = section.config;
  const [images, setImages] = useState<string[]>(
    c.images && c.images.length > 0 ? c.images : [''],
  );

  return (
    <form action={formAction} className="space-y-4">
      {state?.error && <Alert tone="danger">{state.error}</Alert>}
      <Scope orgSlug={orgSlug} branchSlug={branchSlug} />
      <input type="hidden" name="id" value={section.id} />
      <input type="hidden" name="type" value={section.type} />

      <Toggle name="enabled" label="القسم ظاهر في الموقع" defaultChecked={section.enabled} />

      {section.type !== 'hours' ? (
        <Field label="العنوان">
          {(p) => <Input {...p} name="title" defaultValue={c.title ?? ''} maxLength={200} />}
        </Field>
      ) : (
        <Field label="العنوان">
          {(p) => <Input {...p} name="title" defaultValue={c.title ?? ''} maxLength={200} />}
        </Field>
      )}

      {['hero', 'menu', 'contact', 'cta'].includes(section.type) ? (
        <Field label="سطر فرعي">
          {(p) => <Input {...p} name="subtitle" defaultValue={c.subtitle ?? ''} maxLength={200} />}
        </Field>
      ) : null}

      {section.type === 'about' ? (
        <Field label="النص">
          {(p) => <Textarea {...p} name="body" defaultValue={c.body ?? ''} maxLength={4000} rows={6} />}
        </Field>
      ) : null}

      {['hero', 'about'].includes(section.type) ? (
        <Field label="رابط الصورة" hint="روابط https فقط">
          {(p) => (
            <Input {...p} name="imageUrl" defaultValue={c.imageUrl ?? ''} dir="ltr" maxLength={500} />
          )}
        </Field>
      ) : null}

      {['hero', 'cta'].includes(section.type) ? (
        <Field label="نص الزر">
          {(p) => (
            <Input {...p} name="buttonLabel" defaultValue={c.buttonLabel ?? ''} maxLength={200} />
          )}
        </Field>
      ) : null}

      {section.type === 'cta' ? (
        <Field label="وجهة الزر" hint="اختيار من قائمة ثابتة — لا يمكن إدخال رابط خارجي.">
          {(p) => (
            <Select {...p} name="buttonTarget" defaultValue={c.buttonTarget ?? 'order'}>
              {CTA_TARGETS.map((t) => (
                <option key={t} value={t}>{CTA_TARGET_LABELS[t]}</option>
              ))}
            </Select>
          )}
        </Field>
      ) : null}

      {section.type === 'gallery' ? (
        <div className="space-y-2">
          <p className="text-sm font-medium text-fg">الصور</p>
          {images.map((src, i) => (
            <Input
              key={i}
              name="images"
              defaultValue={src}
              dir="ltr"
              maxLength={500}
              placeholder="https://…"
              aria-label={`رابط الصورة ${i + 1}`}
            />
          ))}
          {images.length < 12 ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setImages((v) => [...v, ''])}
            >
              أضف صورة
            </Button>
          ) : null}
          <p className="text-xs text-muted">
            روابط https فقط، حتى 12 صورة. لا يوجد رفع ملفات في هذه المرحلة.
          </p>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-4">
        {section.type === 'hero' ? (
          <Toggle name="showOrderButton" label="زر الطلب" defaultChecked={c.showOrderButton !== false} />
        ) : null}
        {section.type === 'menu' ? (
          <Toggle name="showPrices" label="إظهار الأسعار" defaultChecked={c.showPrices !== false} />
        ) : null}
        {section.type === 'branches' ? (
          <Toggle name="showAddresses" label="إظهار العناوين" defaultChecked={c.showAddresses !== false} />
        ) : null}
        {section.type === 'contact' ? (
          <>
            <Toggle name="showPhone" label="الهاتف" defaultChecked={c.showPhone !== false} />
            <Toggle name="showWhatsapp" label="واتساب" defaultChecked={c.showWhatsapp !== false} />
            <Toggle name="showEmail" label="البريد" defaultChecked={c.showEmail !== false} />
          </>
        ) : null}
      </div>

      <Submit label="حفظ القسم" size="sm" />
    </form>
  );
}

export function ThemeForm({
  orgSlug, branchSlug, theme,
}: {
  orgSlug: string;
  branchSlug: string;
  theme: Theme;
}) {
  const [state, formAction] = useFormState<BuilderState, FormData>(saveThemeAction, undefined);

  return (
    <form action={formAction} className="space-y-4">
      {state?.error && <Alert tone="danger">{state.error}</Alert>}
      <Scope orgSlug={orgSlug} branchSlug={branchSlug} />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="اللون الأساسي" hint="اتركه فارغًا لاستخدام لون هويتك.">
          {(p) => (
            <Input
              {...p}
              name="primaryColor"
              type="color"
              defaultValue={theme.primaryColor ?? '#1E2FC8'}
              className="h-11 p-1"
            />
          )}
        </Field>
        <Field label="اللون الثانوي">
          {(p) => (
            <Input
              {...p}
              name="accentColor"
              type="color"
              defaultValue={theme.accentColor ?? '#6B8BFA'}
              className="h-11 p-1"
            />
          )}
        </Field>
        <Field label="الخلفية">
          {(p) => (
            <Select {...p} name="background" defaultValue={theme.background}>
              {THEME_BACKGROUNDS.map((b) => (
                <option key={b} value={b}>{THEME_BACKGROUND_LABELS[b]}</option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="الخط">
          {(p) => (
            <Select {...p} name="font" defaultValue={theme.font}>
              {THEME_FONTS.map((f) => (
                <option key={f} value={f}>{THEME_FONT_LABELS[f]}</option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="شكل الأزرار">
          {(p) => (
            <Select {...p} name="buttonStyle" defaultValue={theme.buttonStyle}>
              {BUTTON_STYLES.map((b) => (
                <option key={b} value={b}>{BUTTON_STYLE_LABELS[b]}</option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="عرض الصفحة">
          {(p) => (
            <Select {...p} name="width" defaultValue={theme.width}>
              {CONTAINER_WIDTHS.map((w) => (
                <option key={w} value={w}>{CONTAINER_WIDTH_LABELS[w]}</option>
              ))}
            </Select>
          )}
        </Field>
      </div>

      <Submit label="حفظ المظهر" size="sm" />
    </form>
  );
}

export function PublishForm({
  orgSlug, branchSlug, liveVersion,
}: {
  orgSlug: string;
  branchSlug: string;
  liveVersion: number | null;
}) {
  const [state, formAction] = useFormState<BuilderState, FormData>(publishAction, undefined);

  return (
    <div className="space-y-3">
      <form action={formAction} className="space-y-3">
        {state?.error && <Alert tone="danger">{state.error}</Alert>}
        <Scope orgSlug={orgSlug} branchSlug={branchSlug} />
        <Field label="ملاحظة على النشر" hint="اختياري — تظهر في سجل الإصدارات.">
          {(p) => <Input {...p} name="note" maxLength={500} />}
        </Field>
        <Submit label={liveVersion ? 'نشر التعديلات' : 'نشر الموقع'} />
      </form>

      {liveVersion ? (
        <form action={unpublishAction}>
          <Scope orgSlug={orgSlug} branchSlug={branchSlug} />
          <Button type="submit" variant="ghost" size="sm" className="text-danger hover:bg-danger/10">
            إيقاف النشر والعودة للتصميم الافتراضي
          </Button>
        </form>
      ) : null}
    </div>
  );
}
