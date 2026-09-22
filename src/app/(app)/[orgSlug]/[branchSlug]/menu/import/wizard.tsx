'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import {
  FIELD_LABELS,
  IMPORT_FIELDS,
  REQUIRED_FIELDS,
  type ImportField,
} from '@/modules/restaurant/import/fields';
import type { Mapping } from '@/modules/restaurant/import/service';
import type { SheetTable } from '@/modules/restaurant/import/parse';
import {
  commitAction,
  parseSourceAction,
  previewAction,
  type CommitState,
  type ParseState,
  type PreviewState,
} from './actions';

/**
 * Import products, in four visible steps.
 *
 * Nothing is written until the last one, and the step before it says exactly
 * what will happen to every row. The parsed table is held in React state and
 * re-sent with each action — the server re-validates it every time, so it is
 * convenience rather than trust.
 */

function Submit({ label, variant }: { label: string; variant?: 'primary' | 'danger' }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} disabled={pending}>
      {pending ? 'جارٍ العمل…' : label}
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

export function ImportWizard({
  orgSlug,
  branchSlug,
  canManage,
}: {
  orgSlug: string;
  branchSlug: string;
  canManage: boolean;
}) {
  const [parseState, parse] = useFormState<ParseState, FormData>(parseSourceAction, undefined);
  const [previewState, preview] = useFormState<PreviewState, FormData>(previewAction, undefined);
  const [commitState, commit] = useFormState<CommitState, FormData>(commitAction, undefined);

  const [mapping, setMapping] = useState<Mapping | null>(null);
  const [createCategories, setCreateCategories] = useState(true);

  const table: SheetTable | null = parseState?.ok ? parseState.table : null;
  const active = mapping ?? (parseState?.ok ? parseState.mapping : null);
  const missing = active
    ? REQUIRED_FIELDS.filter((f) => active[f] === undefined)
    : REQUIRED_FIELDS;

  // Done. Shown alone so nobody re-submits the same file by reflex.
  if (commitState?.ok) {
    const r = commitState.result;
    return (
      <Card>
        <CardHeader>
          <CardTitle>تم الاستيراد</CardTitle>
        </CardHeader>
        <CardBody className="space-y-3">
          <Alert tone="success">
            تمت إضافة <span className="lb-numeric">{r.created}</span> صنفًا
            {r.categoriesCreated > 0 && (
              <>
                {' '}و<span className="lb-numeric">{r.categoriesCreated}</span> تصنيفًا
              </>
            )}
            .
          </Alert>
          <p className="text-sm text-muted">
            تم تخطّي <span className="lb-numeric">{r.skipped}</span> صفًا مكررًا، و
            <span className="lb-numeric">{r.errors}</span> صفًا به أخطاء. الأصناف الموجودة
            مسبقًا لم تتغيّر.
          </p>
          <p className="text-sm text-muted">
            الأصناف الجديدة تظهر الآن في المنيو، وفي أي قسم «قائمة» داخل مواقعك.
          </p>
        </CardBody>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      {/* ── 1. Source ─────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>١. المصدر</CardTitle>
        </CardHeader>
        <CardBody className="space-y-5">
          {parseState && !parseState.ok && <Alert tone="danger">{parseState.error}</Alert>}

          <form action={parse} className="space-y-3">
            <Scope orgSlug={orgSlug} branchSlug={branchSlug} />
            <input type="hidden" name="kind" value="file" />
            <Field label="ملف Excel أو CSV" hint="بحد أقصى ٥ ميجابايت و٥٠٠ صف.">
              {(p) => (
                <input
                  {...p}
                  type="file"
                  name="file"
                  accept=".xlsx,.csv"
                  className="block min-h-11 w-full rounded border border-line bg-elevated p-2 text-sm text-fg file:me-3 file:min-h-9 file:rounded file:border-0 file:bg-surface file:px-3 file:text-sm file:text-fg"
                />
              )}
            </Field>
            <Submit label="قراءة الملف" />
          </form>

          <div className="border-t border-border pt-4">
            <form action={parse} className="space-y-3">
              <Scope orgSlug={orgSlug} branchSlug={branchSlug} />
              <input type="hidden" name="kind" value="sheet" />
              <Field
                label="أو رابط Google Sheets"
                hint="يجب أن تكون المشاركة «أي شخص لديه الرابط يمكنه الاطّلاع». الجداول الخاصة غير مدعومة بعد."
              >
                {(p) => (
                  <Input
                    {...p}
                    name="sheetUrl"
                    type="url"
                    dir="ltr"
                    placeholder="https://docs.google.com/spreadsheets/d/…"
                  />
                )}
              </Field>
              <Submit label="قراءة الجدول" />
            </form>
          </div>
        </CardBody>
      </Card>

      {/* ── 2. Mapping ────────────────────────────────────────────────── */}
      {table && active && (
        <Card>
          <CardHeader>
            <CardTitle>٢. ربط الأعمدة</CardTitle>
          </CardHeader>
          <CardBody className="space-y-4">
            <p className="text-sm text-muted">
              قرأنا <span className="lb-numeric">{table.rows.length}</span> صفًا من{' '}
              <span className="font-semibold text-fg">
                {parseState?.ok ? parseState.source : ''}
              </span>
              {table.sheetName ? ` · ورقة «${table.sheetName}»` : ''}. راجع الربط قبل المتابعة —
              ترتيب الأعمدة لا يهم.
            </p>

            {missing.length > 0 && (
              <Alert tone="warn">
                حقول مطلوبة غير مربوطة: {missing.map((f) => FIELD_LABELS[f]).join('، ')}
              </Alert>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              {IMPORT_FIELDS.map((field) => (
                <Field
                  key={field}
                  label={FIELD_LABELS[field]}
                  required={REQUIRED_FIELDS.includes(field)}
                >
                  {(p) => (
                    <Select
                      {...p}
                      value={active[field] === undefined ? '' : String(active[field])}
                      onChange={(e) => {
                        const next = { ...active };
                        if (e.target.value === '') delete next[field];
                        else next[field] = Number(e.target.value);
                        setMapping(next);
                      }}
                    >
                      <option value="">— لا شيء —</option>
                      {table.headers.map((h, i) => (
                        <option key={i} value={i}>
                          {h}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              ))}
            </div>

            <details className="text-sm text-muted">
              <summary className="min-h-11 cursor-pointer py-2">
                حقول غير مدعومة في هذه النسخة
              </summary>
              <p className="pt-2">
                لا يدعم المنيو حاليًا رمز الصنف (SKU) ولا اسمًا عربيًا وآخر إنجليزيًا منفصلين.
                «التوفّر» يُضبط لكل فرع من شاشة المنيو، ولا يُستورد هنا.
              </p>
            </details>

            <form action={preview}>
              <Scope orgSlug={orgSlug} branchSlug={branchSlug} />
              <input type="hidden" name="table" value={JSON.stringify(table)} />
              <input type="hidden" name="mapping" value={JSON.stringify(active)} />
              <Button type="submit" disabled={missing.length > 0}>
                معاينة
              </Button>
            </form>
          </CardBody>
        </Card>
      )}

      {/* ── 3. Preview ────────────────────────────────────────────────── */}
      {previewState && !previewState.ok && <Alert tone="danger">{previewState.error}</Alert>}

      {previewState?.ok && table && active && (
        <Card>
          <CardHeader>
            <CardTitle>٣. المعاينة</CardTitle>
          </CardHeader>
          <CardBody className="space-y-4">
            <Alert tone="info">
              لم يُكتب أي شيء بعد. هذه معاينة فقط.
            </Alert>

            <div className="flex flex-wrap gap-2 text-sm">
              <Badge tone="success">
                إضافة: <span className="lb-numeric">{previewState.preview.counts.create}</span>
              </Badge>
              <Badge tone="neutral">
                تخطّي: <span className="lb-numeric">{previewState.preview.counts.skipped}</span>
              </Badge>
              <Badge tone="warn">
                أخطاء: <span className="lb-numeric">{previewState.preview.counts.errors}</span>
              </Badge>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[32rem] text-start text-sm">
                <caption className="sr-only">نتيجة فحص كل صف</caption>
                <thead>
                  <tr className="border-b border-border text-muted">
                    <th scope="col" className="py-2 text-start font-medium">الصف</th>
                    <th scope="col" className="py-2 text-start font-medium">الاسم</th>
                    <th scope="col" className="py-2 text-start font-medium">السعر</th>
                    <th scope="col" className="py-2 text-start font-medium">النتيجة</th>
                  </tr>
                </thead>
                <tbody>
                  {previewState.preview.rows.slice(0, 50).map((row) => (
                    <tr key={row.rowNumber} className="border-b border-border/60">
                      <td className="lb-numeric py-2 align-top">{row.rowNumber}</td>
                      <td className="py-2 align-top">{row.values?.name ?? '—'}</td>
                      <td className="lb-numeric py-2 align-top" dir="ltr">
                        {row.values ? (row.values.priceCents / 100).toFixed(2) : '—'}
                      </td>
                      <td className="py-2 align-top">
                        {/* Never colour alone: each outcome is named. */}
                        {row.outcome === 'create' && <Badge tone="success">ستُضاف</Badge>}
                        {row.outcome === 'skip-duplicate' && <Badge tone="neutral">موجود — تخطّي</Badge>}
                        {row.outcome === 'skip-duplicate-in-file' && (
                          <Badge tone="neutral">مكرر بالملف — تخطّي</Badge>
                        )}
                        {row.outcome === 'error' && <Badge tone="warn">خطأ</Badge>}
                        {row.issues.length > 0 && (
                          <ul className="mt-1 space-y-0.5 text-xs text-muted">
                            {row.issues.map((issue, i) => (
                              <li key={i}>
                                {issue.field !== 'row' && (
                                  <span className="font-medium">
                                    {FIELD_LABELS[issue.field as ImportField]}:{' '}
                                  </span>
                                )}
                                {issue.message}
                              </li>
                            ))}
                          </ul>
                        )}
                        {row.newCategory && (
                          <p className="mt-1 text-xs text-muted">
                            تصنيف جديد: {row.newCategory}
                          </p>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {previewState.preview.rows.length > 50 && (
                <p className="pt-2 text-xs text-muted">
                  تُعرض أول ٥٠ صفًا. الاستيراد يشمل كل الصفوف الصالحة.
                </p>
              )}
            </div>

            {/* ── 4. Confirm ───────────────────────────────────────────── */}
            {canManage ? (
              <form action={commit} className="space-y-3 border-t border-border pt-4">
                <Scope orgSlug={orgSlug} branchSlug={branchSlug} />
                <input type="hidden" name="table" value={JSON.stringify(table)} />
                <input type="hidden" name="mapping" value={JSON.stringify(active)} />

                {previewState.preview.newCategories.length > 0 && (
                  <label className="flex min-h-11 items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      name="createCategories"
                      checked={createCategories}
                      onChange={(e) => setCreateCategories(e.target.checked)}
                      className="h-5 w-5 rounded border-line"
                    />
                    <span>
                      إنشاء التصنيفات غير الموجودة (
                      {previewState.preview.newCategories.join('، ')})
                    </span>
                  </label>
                )}

                <Alert tone="warn" title="سيتم تعديل بيانات المنيو">
                  سيضيف هذا{' '}
                  <span className="lb-numeric">{previewState.preview.counts.create}</span> صنفًا
                  إلى منيو هذه المؤسسة. الأصناف الموجودة مسبقًا لن تتغيّر ولن تُحذف، والطلبات
                  السابقة لا تتأثر.
                </Alert>

                {commitState && !commitState.ok && (
                  <Alert tone="danger">{commitState.error}</Alert>
                )}

                <Submit
                  label={`تأكيد واستيراد ${previewState.preview.counts.create} صنفًا`}
                />
              </form>
            ) : (
              <Alert tone="info">
                المعاينة متاحة لك، لكن الاستيراد يتطلّب صلاحية إدارة المنيو.
              </Alert>
            )}
          </CardBody>
        </Card>
      )}
    </div>
  );
}
