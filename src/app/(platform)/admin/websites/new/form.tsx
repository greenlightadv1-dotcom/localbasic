'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { useState } from 'react';
import { createWebsiteAction, type WebsiteState } from '../actions';

const TYPE_LABELS: Record<string, string> = {
  restaurant: 'مطعم',
  clinic: 'عيادة',
  workshop: 'ورشة',
  retail: 'تجزئة',
  custom: 'مخصص',
};

type Org = { id: string; name: string; slug: string; suggestedType: string };

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <fieldset className="border-t border-line pt-5 first:border-0 first:pt-0">
      <legend className="sr-only">{title}</legend>
      <h2 className="mb-3 text-sm font-bold text-fg">
        <span className="me-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-primary-soft text-xs text-primary">
          {n}
        </span>
        {title}
      </h2>
      <div className="space-y-3">{children}</div>
    </fieldset>
  );
}

const field =
  'h-10 w-full rounded border border-line bg-elevated px-3 text-sm text-fg outline-none focus:border-primary';

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="h-10 rounded bg-primary px-6 text-sm font-semibold text-primary-fg hover:bg-primary/90 disabled:opacity-50"
    >
      {pending ? 'جارٍ الإنشاء…' : 'إنشاء المسودة'}
    </button>
  );
}

export function CreateWebsiteForm({
  organizations,
  siteTypes,
}: {
  organizations: Org[];
  siteTypes: string[];
}) {
  const [state, action] = useFormState<WebsiteState, FormData>(createWebsiteAction, undefined);

  // Picking the customer pre-fills the type and the slug from what LocalBasic
  // already knows, so the operator confirms rather than retypes. Both remain
  // editable, and both are re-validated server-side regardless.
  const [orgId, setOrgId] = useState('');
  const chosen = organizations.find((o) => o.id === orgId);

  return (
    <form action={action} className="space-y-6">
      <Step n={1} title="العميل">
        <select
          name="organizationId"
          required
          className={field}
          value={orgId}
          onChange={(e) => setOrgId(e.target.value)}
        >
          <option value="">— اختر عميلًا —</option>
          {organizations.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name} ({o.slug})
            </option>
          ))}
        </select>
        {organizations.length === 0 && (
          <p className="text-xs text-muted">لا يوجد عملاء نشطون.</p>
        )}
      </Step>

      <Step n={2} title="نوع الموقع">
        <select name="siteType" required className={field} key={chosen?.suggestedType}
                defaultValue={chosen?.suggestedType ?? 'custom'}>
          {siteTypes.map((t) => (
            <option key={t} value={t}>{TYPE_LABELS[t] ?? t}</option>
          ))}
        </select>
        <select name="locale" className={field} defaultValue="ar">
          <option value="ar">العربية (RTL)</option>
          <option value="en">English (LTR)</option>
        </select>
      </Step>

      <Step n={3} title="الهوية">
        <input name="name" required maxLength={120} placeholder="اسم الموقع" className={field} />
        <input
          name="slug"
          required
          dir="ltr"
          maxLength={50}
          placeholder="site-slug"
          className={`${field} font-mono`}
          key={chosen?.slug}
          defaultValue={chosen?.slug ?? ''}
        />
        <p className="text-xs text-muted">
          الألوان والشعار تأتي من هوية العميل المسجّلة، ويمكن تجاوزها لاحقًا داخل الموقع.
        </p>
      </Step>

      <Step n={4} title="بيانات النشاط">
        <p className="text-xs text-muted">
          تُقرأ تلقائيًا من LocalBasic — الاسم، الهاتف، البريد، المواعيد، الفروع — ولا تُنسخ داخل الموقع.
        </p>
      </Step>

      <Step n={5} title="التعليمات">
        <textarea
          name="notes"
          rows={4}
          maxLength={4000}
          placeholder="ما الذي تريده من هذا الموقع؟"
          className="w-full rounded border border-line bg-elevated p-3 text-sm text-fg outline-none focus:border-primary"
        />
        <input name="audience" maxLength={200} placeholder="الجمهور المستهدف" className={field} />
        <input name="tone" maxLength={120} placeholder="نبرة الكتابة" className={field} />
        <input
          name="requestedPages"
          maxLength={400}
          placeholder="صفحات مطلوبة، مفصولة بفاصلة"
          className={field}
        />
        <input
          name="seoKeywords"
          maxLength={400}
          placeholder="كلمات مفتاحية، مفصولة بفاصلة"
          className={field}
        />
        <input name="restrictions" maxLength={1000} placeholder="قيود أو ممنوعات" className={field} />
      </Step>

      <Step n={6} title="إنشاء">
        <div className="flex items-center gap-3">
          <Submit />
          {state?.error && <span className="text-sm text-danger">{state.error}</span>}
        </div>
      </Step>
    </form>
  );
}
