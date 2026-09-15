import Link from 'next/link';
import { listLeads, LEAD_STATUSES, LEAD_STATUS_LABELS, LEAD_SOURCE_LABELS } from '@/modules/platform/leads/service';
import { listAvailableServices } from '@/modules/platform/services/service';
import { adminMetadata } from '@/modules/platform/admin/metadata';
import { AdminHeading, Panel, formatDate } from '../ui';
import { CreateLeadForm, UpdateLeadForm } from './lead-forms';
import { cn } from '@/lib/cn';

export const generateMetadata = adminMetadata('العملاء المحتملون');

const STATUS_TONE: Record<string, string> = {
  new: 'bg-primary-soft text-primary',
  contacted: 'bg-warn/15 text-warn',
  qualified: 'bg-primary/15 text-primary',
  won: 'bg-success/15 text-success',
  lost: 'bg-danger/10 text-danger',
};

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: { q?: string; status?: string; created?: string };
}) {
  const q = searchParams.q?.trim() ?? '';
  const status = searchParams.status ?? '';
  const [leads, services] = await Promise.all([
    listLeads({ search: q || undefined, status: status || undefined }),
    listAvailableServices(),
  ]);

  return (
    <>
      <AdminHeading
        title="العملاء المحتملون"
        lead="متابعة تشغيلية للمبيعات — من أول تواصل حتى التعاقد."
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <form className="flex flex-1 gap-2" action="/admin/leads">
          {status ? <input type="hidden" name="status" value={status} /> : null}
          <input
            type="search"
            name="q"
            defaultValue={q}
            placeholder="اسم أو رقم أو نشاط"
            className="h-10 min-w-48 flex-1 rounded border border-line bg-elevated px-3 text-sm text-fg"
          />
          <button type="submit" className="h-10 rounded bg-primary px-4 text-sm font-semibold text-primary-fg">
            بحث
          </button>
        </form>
        <div className="flex gap-1">
          <Link
            href={`/admin/leads${q ? `?q=${encodeURIComponent(q)}` : ''}`}
            className={cn('rounded px-3 py-1.5 text-xs font-semibold', !status ? 'bg-fg text-white' : 'bg-elevated text-muted')}
          >
            الكل
          </Link>
          {LEAD_STATUSES.map((s) => (
            <Link
              key={s}
              href={`/admin/leads?status=${s}${q ? `&q=${encodeURIComponent(q)}` : ''}`}
              className={cn('rounded px-3 py-1.5 text-xs font-semibold', status === s ? 'bg-fg text-white' : 'bg-elevated text-muted')}
            >
              {LEAD_STATUS_LABELS[s]}
            </Link>
          ))}
        </div>
      </div>

      {searchParams.created === '1' ? (
        <p className="mb-4 rounded border border-success/30 bg-success/10 px-4 py-3 text-sm font-semibold text-success">
          تمت الإضافة.
        </p>
      ) : null}

      <Panel className="mb-6">
        <h2 className="border-b border-line px-5 py-3 text-sm font-bold text-fg">إضافة يدوية</h2>
        <CreateLeadForm services={services} />
      </Panel>

      <Panel>
        {leads.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-muted">
            {q || status ? 'لا نتائج مطابقة.' : 'لا يوجد عملاء محتملون بعد.'}
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {leads.map((l) => (
              <li key={l.id} className="px-5 py-4">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className={cn('rounded px-2 py-0.5 text-xs font-semibold', STATUS_TONE[l.status])}>
                    {LEAD_STATUS_LABELS[l.status]}
                  </span>
                  <span className="font-semibold text-fg">{l.name}</span>
                  <span className="text-sm text-muted" dir="ltr">{l.phone}</span>
                  {l.businessName ? <span className="text-sm text-muted">· {l.businessName}</span> : null}
                  <span className="text-xs text-muted">· {LEAD_SOURCE_LABELS[l.source] ?? l.source}</span>
                  <span className="ms-auto text-xs text-muted">{formatDate(l.createdAt)}</span>
                </div>
                {l.organizationId ? (
                  <p className="mb-2 text-xs text-success">تم التعاقد — مساحة عمل قائمة.</p>
                ) : null}
                <UpdateLeadForm id={l.id} status={l.status} notes={l.notes} />
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
}
