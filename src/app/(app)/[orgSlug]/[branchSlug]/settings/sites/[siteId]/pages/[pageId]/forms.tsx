'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Alert } from '@/components/ui/alert';

import { ConfirmDialog } from '@/components/ui/confirm';
import {
  SECTION_DESCRIPTIONS,
  SECTION_LABELS,
  SECTION_TYPES,
  isDataBoundSection,
  type SectionType,
} from '@/modules/sites/schemas';
import { parseSectionContent } from '@/modules/sites/sections/content';
import type { SiteSection } from '@/modules/sites/types';
import {
  createSectionAction,
  deleteSectionAction,
  moveSectionAction,
  toggleSectionAction,
  updateSectionAction,
  type FormState,
} from './actions';

/**
 * The section editor's interactive parts.
 *
 * Forms are built from the section schemas rather than invented: each type
 * renders exactly the fields its schema declares, and the server parses what
 * comes back with the STRICT write schema for the type the stored row says it
 * is. Client validation here is for the operator's benefit; the server decides.
 */

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" disabled={pending}>
      {pending ? 'جارٍ الحفظ…' : label}
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

type Ids = { orgSlug: string; branchSlug: string; siteId: string; pageId: string };

function Targets({ ids, sectionId }: { ids: Ids; sectionId?: string }) {
  return (
    <>
      <Scope orgSlug={ids.orgSlug} branchSlug={ids.branchSlug} />
      <input type="hidden" name="siteId" value={ids.siteId} />
      <input type="hidden" name="pageId" value={ids.pageId} />
      {sectionId && <input type="hidden" name="sectionId" value={sectionId} />}
    </>
  );
}

/**
 * Adding a section.
 *
 * The list comes from SECTION_TYPES — the registry the renderer, the schemas
 * and the SQL allow-list all agree on — so a type the renderer cannot draw is
 * not offerable. There is no template restriction in the current model; if one
 * is ever added, it belongs in that registry rather than here.
 */
export function AddSection({ ids }: { ids: Ids }) {
  const [state, action] = useFormState<FormState, FormData>(createSectionAction, undefined);
  const [type, setType] = useState<SectionType>(SECTION_TYPES[0]);

  return (
    <form action={action} className="space-y-3">
      <Targets ids={ids} />
      {state?.error && <Alert tone="danger">{state.error}</Alert>}

      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-56 flex-1">
          <Field label="نوع القسم" error={state?.fieldErrors?.sectionType}>
            {(p) => (
              <Select
                {...p}
                name="sectionType"
                value={type}
                onChange={(e) => setType(e.target.value as SectionType)}
              >
                {SECTION_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {SECTION_LABELS[t]}
                    {isDataBoundSection(t) ? ' — بيانات حيّة' : ''}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <Submit label="إضافة قسم" />
      </div>

      <p className="text-sm text-muted">{SECTION_DESCRIPTIONS[type]}</p>
    </form>
  );
}

/** The notice that marks a live section, so nobody thinks it stores a copy. */
function LiveNotice({ children }: { children: React.ReactNode }) {
  return (
    <Alert tone="info" title="قسم بيانات حيّة">
      {children}
    </Alert>
  );
}

/**
 * One section's editor.
 *
 * A switch over the section type, with each branch rendering that type's own
 * fields. Data-bound branches expose configuration only — no identifier, no
 * price, no address — because that is all their schemas accept and all the SQL
 * allow-list will store.
 */
export function SectionForm({
  ids,
  section,
  categories,
}: {
  ids: Ids;
  section: SiteSection;
  /** The organization's menu categories, for the menu section's narrowing. */
  categories: { id: string; name: string }[];
}) {
  const [state, action] = useFormState<FormState, FormData>(updateSectionAction, undefined);
  const type = section.sectionType;

  return (
    <form action={action} className="space-y-4">
      <Targets ids={ids} sectionId={section.id} />
      <input type="hidden" name="sectionType" value={type} />
      {state?.error && <Alert tone="danger">{state.error}</Alert>}

      {type === 'hero' && <HeroFields section={section} state={state} />}
      {type === 'about' && <AboutFields section={section} state={state} />}
      {type === 'services' && <ListNotice kind="services" />}
      {type === 'testimonials' && <ListNotice kind="testimonials" />}
      {type === 'contact' && <ContactFields section={section} state={state} />}
      {type === 'footer' && <FooterFields section={section} state={state} />}
      {type === 'menu' && (
        <MenuFields section={section} state={state} categories={categories} />
      )}
      {type === 'business_info' && <BusinessInfoFields section={section} state={state} />}
      {type === 'hours' && <HoursFields section={section} state={state} />}
      {type === 'branches' && <BranchesFields section={section} state={state} />}

      <Submit label="حفظ القسم" />
    </form>
  );
}

type FieldProps = { section: SiteSection; state: FormState };

function HeroFields({ section, state }: FieldProps) {
  const c = parseSectionContent('hero', section.content);
  return (
    <>
      <Field label="العنوان" error={state?.fieldErrors?.title}>
        {(p) => <Input {...p} name="title" defaultValue={c.title} maxLength={120} />}
      </Field>
      <Field label="جملة تعريفية" error={state?.fieldErrors?.subtitle}>
        {(p) => <Textarea {...p} name="subtitle" defaultValue={c.subtitle} maxLength={300} />}
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="نص الزر" error={state?.fieldErrors?.ctaLabel}>
          {(p) => <Input {...p} name="ctaLabel" defaultValue={c.ctaLabel} maxLength={40} />}
        </Field>
        <Field
          label="وجهة الزر"
          hint="مسار داخلي مثل /contact أو mailto: أو tel: فقط."
          error={state?.fieldErrors?.ctaHref}
        >
          {(p) => (
            <Input {...p} name="ctaHref" dir="ltr" defaultValue={c.ctaHref ?? ''} />
          )}
        </Field>
      </div>
      <Field label="محاذاة" error={state?.fieldErrors?.align}>
        {(p) => (
          <Select {...p} name="align" defaultValue={c.align}>
            <option value="center">في المنتصف</option>
            <option value="start">من البداية</option>
          </Select>
        )}
      </Field>
    </>
  );
}

function AboutFields({ section, state }: FieldProps) {
  const c = parseSectionContent('about', section.content);
  return (
    <>
      <Field label="العنوان" error={state?.fieldErrors?.title}>
        {(p) => <Input {...p} name="title" defaultValue={c.title} maxLength={120} />}
      </Field>
      <Field label="النص" error={state?.fieldErrors?.body}>
        {(p) => (
          <Textarea {...p} name="body" defaultValue={c.body} maxLength={2000} rows={6} />
        )}
      </Field>
    </>
  );
}

function ContactFields({ section, state }: FieldProps) {
  const c = parseSectionContent('contact', section.content);
  return (
    <>
      <Field label="العنوان" error={state?.fieldErrors?.title}>
        {(p) => <Input {...p} name="title" defaultValue={c.title} maxLength={120} />}
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="الهاتف" error={state?.fieldErrors?.phone}>
          {(p) => <Input {...p} name="phone" dir="ltr" defaultValue={c.phone} maxLength={40} />}
        </Field>
        <Field label="البريد" error={state?.fieldErrors?.email}>
          {(p) => <Input {...p} name="email" dir="ltr" defaultValue={c.email} maxLength={160} />}
        </Field>
      </div>
      <Field label="العنوان البريدي" error={state?.fieldErrors?.address}>
        {(p) => <Textarea {...p} name="address" defaultValue={c.address} maxLength={300} />}
      </Field>
    </>
  );
}

function FooterFields({ section, state }: FieldProps) {
  const c = parseSectionContent('footer', section.content);
  return (
    <Field label="نص التذييل" error={state?.fieldErrors?.text}>
      {(p) => <Input {...p} name="text" defaultValue={c.text} maxLength={200} />}
    </Field>
  );
}

/**
 * Services and testimonials hold a list of items, and this editor has no list
 * builder yet. Saying so is better than a half-working one, and better than
 * pretending the section cannot be used: the template seeds real items, and
 * they render.
 */
function ListNotice({ kind }: { kind: 'services' | 'testimonials' }) {
  return (
    <Alert tone="info">
      {kind === 'services'
        ? 'تحرير قائمة الخدمات غير متاح في هذه المرحلة. الخدمات التي أنشأها القالب تظهر كما هي.'
        : 'تحرير قائمة الآراء غير متاح في هذه المرحلة. الآراء التي أنشأها القالب تظهر كما هي.'}
    </Alert>
  );
}

function MenuFields({
  section,
  state,
  categories,
}: FieldProps & { categories: { id: string; name: string }[] }) {
  const c = parseSectionContent('menu', section.content);
  return (
    <>
      <LiveNotice>
        قائمة حيّة — أي تعديل في أصناف المؤسسة يظهر هنا تلقائيًا. هذا القسم لا
        يحفظ نسخة من الأصناف أو الأسعار.
      </LiveNotice>
      <Field label="العنوان" error={state?.fieldErrors?.title}>
        {(p) => (
          <Input {...p} name="title" defaultValue={c.title} maxLength={120} placeholder="القائمة" />
        )}
      </Field>
      <Field
        label="التصنيفات المعروضة"
        hint="اتركه فارغًا لعرض كل التصنيفات. اختر واحدًا أو أكثر للتخصيص."
        error={state?.fieldErrors?.categoryIds}
      >
        {(p) => (
          <select
            {...p}
            name="categoryIds"
            multiple
            defaultValue={c.categoryIds}
            className="min-h-32 w-full rounded border border-line bg-elevated p-2 text-sm text-fg"
          >
            {categories.map((cat) => (
              <option key={cat.id} value={cat.id}>
                {cat.name}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field
        label="حد أقصى للأصناف"
        hint="اتركه فارغًا لعرض كل الأصناف."
        error={state?.fieldErrors?.limit}
      >
        {(p) => (
          <Input
            {...p}
            name="limit"
            type="number"
            min={1}
            max={200}
            dir="ltr"
            defaultValue={c.limit ?? ''}
          />
        )}
      </Field>
    </>
  );
}

function LiveOnlyFields({
  section,
  state,
  type,
  notice,
  placeholder,
}: FieldProps & { type: 'business_info' | 'hours' | 'branches'; notice: string; placeholder: string }) {
  const c = parseSectionContent(type, section.content);
  return (
    <>
      <LiveNotice>{notice}</LiveNotice>
      <Field label="العنوان" error={state?.fieldErrors?.title}>
        {(p) => (
          <Input
            {...p}
            name="title"
            defaultValue={c.title}
            maxLength={120}
            placeholder={placeholder}
          />
        )}
      </Field>
    </>
  );
}

function BusinessInfoFields(props: FieldProps) {
  return (
    <LiveOnlyFields
      {...props}
      type="business_info"
      placeholder="بيانات النشاط"
      notice="بيانات حيّة — الاسم وأرقام التواصل تأتي من إعدادات الهوية وتتحدّث تلقائيًا. لا يوجد عنوان هنا: العناوين تخص الفروع، وتظهر في قسم الفروع."
    />
  );
}

function HoursFields(props: FieldProps) {
  return (
    <LiveOnlyFields
      {...props}
      type="hours"
      placeholder="مواعيد العمل"
      notice="مواعيد حيّة — تأتي من إعدادات مواعيد العمل وتتحدّث تلقائيًا. هذا القسم لا يحفظ نسخة من المواعيد."
    />
  );
}

function BranchesFields(props: FieldProps) {
  return (
    <LiveOnlyFields
      {...props}
      type="branches"
      placeholder="فروعنا"
      notice="فروع حيّة — تأتي من إعدادات الفروع وتتحدّث تلقائيًا. هذا القسم لا يحفظ نسخة من بيانات الفروع."
    />
  );
}

/** Visibility. Hiding keeps the content; it is not a delete. */
export function VisibilityToggle({
  ids,
  section,
}: {
  ids: Ids;
  section: SiteSection;
}) {
  return (
    <form action={toggleSectionAction}>
      <Targets ids={ids} sectionId={section.id} />
      <input type="hidden" name="isVisible" value={String(!section.isVisible)} />
      <Button
        type="submit"
        variant="outline"
        size="sm"
        className="min-h-11"
        aria-label={`${section.isVisible ? 'إخفاء' : 'إظهار'} قسم ${SECTION_LABELS[section.sectionType]}`}
      >
        {section.isVisible ? 'إخفاء' : 'إظهار'}
      </Button>
    </form>
  );
}

export function MoveSectionButtons({
  ids,
  sectionId,
  label,
  isFirst,
  isLast,
}: {
  ids: Ids;
  sectionId: string;
  label: string;
  isFirst: boolean;
  isLast: boolean;
}) {
  return (
    <span className="flex gap-1">
      {(['up', 'down'] as const).map((direction) => (
        <form key={direction} action={moveSectionAction}>
          <Targets ids={ids} sectionId={sectionId} />
          <input type="hidden" name="direction" value={direction} />
          <Button
            type="submit"
            variant="outline"
            size="sm"
            className="min-h-11 min-w-11"
            disabled={direction === 'up' ? isFirst : isLast}
            aria-label={`${direction === 'up' ? 'تحريك لأعلى' : 'تحريك لأسفل'}: ${label}`}
          >
            <span aria-hidden="true">{direction === 'up' ? '↑' : '↓'}</span>
          </Button>
        </form>
      ))}
    </span>
  );
}

export function DeleteSectionButton({
  ids,
  sectionId,
  label,
}: {
  ids: Ids;
  sectionId: string;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="min-h-11 text-danger"
        onClick={() => setOpen(true)}
        aria-label={`حذف قسم: ${label}`}
      >
        حذف
      </Button>
      <ConfirmDialog
        open={open}
        title={`حذف قسم «${label}»؟`}
        description="سيتم حذف هذا القسم ومحتواه. الصفحة تبقى كما هي حتى لو لم يتبقَّ فيها أي قسم."
        onCancel={() => setOpen(false)}
        onConfirm={() => setOpen(false)}
      >
        <form action={deleteSectionAction} className="flex justify-end gap-2">
          <Targets ids={ids} sectionId={sectionId} />
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>
            إلغاء
          </Button>
          <Button type="submit" variant="danger">
            حذف القسم
          </Button>
        </form>
      </ConfirmDialog>
    </>
  );
}

