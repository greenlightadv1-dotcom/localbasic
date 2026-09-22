'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { Alert } from '@/components/ui/alert';
import { ConfirmDialog } from '@/components/ui/confirm';
import { suggestSiteSlug } from '@/modules/sites/schemas';
import {
  createPageAction,
  deletePageAction,
  movePageAction,
  updateSiteAction,
  type FormState,
} from './actions';

/**
 * The site screen's interactive parts.
 *
 * Every one posts to a Server Action that re-resolves the tenant from the URL
 * and re-checks `site.manage`. Nothing here decides anything: a rendered
 * button is not an authorised button, and the `canManage` prop below only
 * chooses what to show.
 */

function Submit({ label, size, block }: { label: string; size?: 'sm'; block?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size={size} block={block} disabled={pending}>
      {pending ? 'جارٍ الحفظ…' : label}
    </Button>
  );
}

export function Scope({ orgSlug, branchSlug }: { orgSlug: string; branchSlug: string }) {
  return (
    <>
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="branchSlug" value={branchSlug} />
    </>
  );
}

/** General settings: exactly the two fields updateSite accepts. */
export function GeneralForm({
  orgSlug,
  branchSlug,
  siteId,
  name,
  status,
}: {
  orgSlug: string;
  branchSlug: string;
  siteId: string;
  name: string;
  status: 'draft' | 'published';
}) {
  const [state, action] = useFormState<FormState, FormData>(updateSiteAction, undefined);

  return (
    <form action={action} className="space-y-4">
      <Scope orgSlug={orgSlug} branchSlug={branchSlug} />
      <input type="hidden" name="siteId" value={siteId} />
      {state?.error && <Alert tone="danger">{state.error}</Alert>}

      <Field label="اسم الموقع" error={state?.fieldErrors?.name} required>
        {(p) => <Input {...p} name="name" defaultValue={name} required maxLength={120} />}
      </Field>

      <Field
        label="الحالة"
        hint="الحالة تُحفظ الآن ولا تنشر الموقع بعد — النشر مرحلة لاحقة."
        error={state?.fieldErrors?.status}
      >
        {(p) => (
          <Select {...p} name="status" defaultValue={status}>
            <option value="draft">مسودة</option>
            <option value="published">منشور</option>
          </Select>
        )}
      </Field>

      <Submit label="حفظ" />
    </form>
  );
}

/** Adding a page. The server sets the site, the order and the homepage flag. */
export function CreatePageForm({
  orgSlug,
  branchSlug,
  siteId,
}: {
  orgSlug: string;
  branchSlug: string;
  siteId: string;
}) {
  const [state, action] = useFormState<FormState, FormData>(createPageAction, undefined);
  const [slug, setSlug] = useState('');
  const [touched, setTouched] = useState(false);

  return (
    <form action={action} className="space-y-4">
      <Scope orgSlug={orgSlug} branchSlug={branchSlug} />
      <input type="hidden" name="siteId" value={siteId} />
      {state?.error && <Alert tone="danger">{state.error}</Alert>}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="عنوان الصفحة" error={state?.fieldErrors?.title} required>
          {(p) => (
            <Input
              {...p}
              name="title"
              required
              maxLength={200}
              onChange={(e) => {
                if (!touched) setSlug(suggestSiteSlug(e.target.value));
              }}
            />
          )}
        </Field>

        <Field
          label="المعرّف في الرابط"
          hint="حروف إنجليزية صغيرة وأرقام وشرطات. لا يمكن تغييره بعد الإنشاء."
          error={state?.fieldErrors?.slug}
          required
        >
          {(p) => (
            <Input
              {...p}
              name="slug"
              dir="ltr"
              required
              value={slug}
              onChange={(e) => {
                setTouched(true);
                setSlug(e.target.value);
              }}
            />
          )}
        </Field>
      </div>

      <Submit label="إضافة صفحة" />
    </form>
  );
}

/**
 * Move one place up or down.
 *
 * Two real submit buttons rather than a draggable handle: keyboard-reachable
 * by default, 44px tall, and disabled at the boundaries. The browser sends a
 * DIRECTION — the server reads the authoritative order and submits the whole
 * permutation, so a stale tab cannot rearrange anything.
 */
export function MoveButtons({
  orgSlug,
  branchSlug,
  siteId,
  pageId,
  isFirst,
  isLast,
  label,
}: {
  orgSlug: string;
  branchSlug: string;
  siteId: string;
  pageId: string;
  isFirst: boolean;
  isLast: boolean;
  label: string;
}) {
  return (
    <span className="flex gap-1">
      {(['up', 'down'] as const).map((direction) => (
        <form key={direction} action={movePageAction}>
          <Scope orgSlug={orgSlug} branchSlug={branchSlug} />
          <input type="hidden" name="siteId" value={siteId} />
          <input type="hidden" name="pageId" value={pageId} />
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

/**
 * Deleting a page.
 *
 * The dialog explains what the SERVER will do — it does not decide it. Whether
 * a replacement homepage is promoted, and whether the last page may go at all,
 * is site_page_delete()'s to answer, and the outcome comes back as a message.
 */
export function DeletePageButton({
  orgSlug,
  branchSlug,
  siteId,
  pageId,
  title,
  isHomepage,
  isOnlyPage,
}: {
  orgSlug: string;
  branchSlug: string;
  siteId: string;
  pageId: string;
  title: string;
  isHomepage: boolean;
  isOnlyPage: boolean;
}) {
  const [open, setOpen] = useState(false);

  const description = isOnlyPage
    ? 'هذه هي الصفحة الوحيدة في الموقع. لا يمكن حذف آخر صفحة.'
    : isHomepage
      ? 'هذه هي الصفحة الرئيسية. عند حذفها تصبح الصفحة التالية هي الرئيسية تلقائيًا.'
      : 'سيتم حذف الصفحة وكل أقسامها. لا يمكن التراجع.';

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="min-h-11 text-danger"
        onClick={() => setOpen(true)}
        aria-label={`حذف الصفحة: ${title}`}
      >
        حذف
      </Button>

      <ConfirmDialog
        open={open}
        title={`حذف «${title}»؟`}
        description={description}
        confirmLabel="حذف"
        onCancel={() => setOpen(false)}
        onConfirm={() => setOpen(false)}
      >
        {/* The confirm button is a real submit inside a real form, so the
            deletion is a server round trip rather than client state. */}
        <form action={deletePageAction} className="flex justify-end gap-2">
          <Scope orgSlug={orgSlug} branchSlug={branchSlug} />
          <input type="hidden" name="siteId" value={siteId} />
          <input type="hidden" name="pageId" value={pageId} />
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>
            إلغاء
          </Button>
          <Button type="submit" variant="danger" disabled={isOnlyPage}>
            حذف الصفحة
          </Button>
        </form>
      </ConfirmDialog>
    </>
  );
}
