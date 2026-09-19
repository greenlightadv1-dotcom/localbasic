'use client';

import { useFormState, useFormStatus } from 'react-dom';
import {
  archiveWebsiteAction,
  publishWebsiteAction,
  saveBriefAction,
  type WebsiteState,
} from '../actions';

function Submit({ label, tone = 'primary' }: { label: string; tone?: 'primary' | 'quiet' }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className={
        tone === 'primary'
          ? 'h-9 rounded bg-primary px-4 text-xs font-semibold text-primary-fg hover:bg-primary/90 disabled:opacity-50'
          : 'h-9 rounded border border-line bg-elevated px-4 text-xs font-semibold text-fg hover:bg-surface disabled:opacity-50'
      }
    >
      {pending ? '…' : label}
    </button>
  );
}

function Feedback({ state }: { state: WebsiteState }) {
  if (state?.error) return <p className="mt-2 text-xs text-danger">{state.error}</p>;
  if (state?.ok) return <p className="mt-2 text-xs text-success">{state.ok}</p>;
  return null;
}

export function PublishControls({ id, status }: { id: string; status: string }) {
  const [publishState, publish] = useFormState<WebsiteState, FormData>(
    publishWebsiteAction,
    undefined,
  );
  const [archiveState, archive] = useFormState<WebsiteState, FormData>(
    archiveWebsiteAction,
    undefined,
  );

  return (
    <div className="mt-4 space-y-3 border-t border-line pt-4">
      <form action={publish}>
        <input type="hidden" name="id" value={id} />
        <input
          name="note"
          maxLength={500}
          placeholder="ملاحظة الإصدار (اختياري)"
          className="mb-2 h-9 w-full rounded border border-line bg-elevated px-3 text-xs text-fg outline-none focus:border-primary"
        />
        <Submit label={status === 'published' ? 'نشر التحديثات' : 'نشر الموقع'} />
        <Feedback state={publishState} />
      </form>

      {status !== 'archived' && (
        <form action={archive}>
          <input type="hidden" name="id" value={id} />
          <Submit label="أرشفة" tone="quiet" />
          <Feedback state={archiveState} />
        </form>
      )}
    </div>
  );
}

const field =
  'h-10 w-full rounded border border-line bg-elevated px-3 text-sm text-fg outline-none focus:border-primary';

export function BriefForm({
  id,
  brief,
}: {
  id: string;
  brief: {
    notes: string;
    audience?: string;
    tone?: string;
    requestedPages?: string[];
    seoKeywords?: string[];
    restrictions?: string;
  };
}) {
  const [state, action] = useFormState<WebsiteState, FormData>(saveBriefAction, undefined);

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="id" value={id} />
      <textarea
        name="notes"
        rows={4}
        maxLength={4000}
        defaultValue={brief.notes}
        placeholder="تعليمات حرة"
        className="w-full rounded border border-line bg-elevated p-3 text-sm text-fg outline-none focus:border-primary"
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <input name="audience" defaultValue={brief.audience ?? ''} placeholder="الجمهور" className={field} />
        <input name="tone" defaultValue={brief.tone ?? ''} placeholder="النبرة" className={field} />
        <input
          name="requestedPages"
          defaultValue={(brief.requestedPages ?? []).join('، ')}
          placeholder="صفحات مطلوبة"
          className={field}
        />
        <input
          name="seoKeywords"
          defaultValue={(brief.seoKeywords ?? []).join('، ')}
          placeholder="كلمات مفتاحية"
          className={field}
        />
      </div>
      <input
        name="restrictions"
        defaultValue={brief.restrictions ?? ''}
        placeholder="قيود"
        className={field}
      />
      <Submit label="حفظ التعليمات" tone="quiet" />
      <Feedback state={state} />
    </form>
  );
}
