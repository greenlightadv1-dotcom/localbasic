import { cn } from '@/lib/cn';
import { BILLING_PERIOD_LABELS } from '@/modules/platform/billing/schemas';

export function AdminHeading({ title, lead }: { title: string; lead?: string }) {
  return (
    <div className="mb-6">
      <h1 className="text-xl font-extrabold text-fg">{title}</h1>
      {lead ? <p className="mt-1 text-sm text-muted">{lead}</p> : null}
    </div>
  );
}

export function Panel({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('rounded-lg border border-line bg-elevated shadow-card', className)}
      {...props}
    />
  );
}

/** EGP minor units → a readable Arabic-numeral amount. */
export function money(cents: number, currency = 'EGP'): string {
  return `${(cents / 100).toLocaleString('ar-EG', { minimumFractionDigits: 2 })} ${currency}`;
}

export function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('ar-EG', {
    year: 'numeric', month: 'long', day: 'numeric',
  });
}

export function periodLabel(p: string | null): string {
  if (!p) return '—';
  return BILLING_PERIOD_LABELS[p as keyof typeof BILLING_PERIOD_LABELS] ?? p;
}

const STATUS_LABEL: Record<string, string> = {
  trialing: 'تجريبي',
  active: 'نشط',
  past_due: 'متأخر',
  cancelled: 'ملغي',
  expired: 'منتهي',
};

export function StatusBadge({ status }: { status: string | null }) {
  if (!status) return <span className="text-xs text-muted">بلا اشتراك</span>;
  const tone =
    status === 'active' ? 'bg-success/15 text-success'
    : status === 'trialing' ? 'bg-primary-soft text-primary'
    : status === 'past_due' ? 'bg-warn/15 text-warn'
    : 'bg-danger/10 text-danger';
  return (
    <span className={cn('rounded px-2 py-0.5 text-xs font-semibold', tone)}>
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

/**
 * The expiry warning. Three days or fewer is loud, already-lapsed is louder.
 * `daysLeft` is computed from current_period_end on the server — the badge
 * only renders the number it is handed.
 */
export function ExpiryBadge({ daysLeft }: { daysLeft: number | null }) {
  if (daysLeft === null) return <span className="text-xs text-muted">—</span>;
  if (daysLeft < 0) {
    return (
      <span className="rounded bg-danger px-2 py-0.5 text-xs font-bold text-white">
        منتهي منذ {Math.abs(daysLeft)} يوم
      </span>
    );
  }
  if (daysLeft <= 3) {
    return (
      <span className="rounded bg-danger/15 px-2 py-0.5 text-xs font-bold text-danger">
        ⚠ يتبقى {daysLeft} {daysLeft === 1 ? 'يوم' : 'أيام'}
      </span>
    );
  }
  return <span className="text-xs text-muted">{daysLeft} يوم</span>;
}

/** Customer code, styled so it reads as an identifier worth quoting. */
export function CustomerCode({ code }: { code: string }) {
  return (
    <span className="rounded bg-surface px-2 py-0.5 font-mono text-xs font-bold text-fg" dir="ltr">
      {code}
    </span>
  );
}
