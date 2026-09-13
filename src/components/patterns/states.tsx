import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';

/**
 * The four states every list screen must ship. Having them as components is
 * what makes "loading, empty, error, populated — or it isn't done" a habit
 * rather than a code review note.
 */

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn('relative overflow-hidden rounded bg-surface', className)}
      aria-hidden="true"
    >
      <div className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-white/60 to-transparent" />
    </div>
  );
}

export function TableSkeleton({ rows = 6, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="space-y-2 p-4" role="status" aria-label="جارٍ التحميل">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex gap-3">
          {Array.from({ length: cols }).map((__, c) => (
            <Skeleton key={c} className={cn('h-9 flex-1', c === 0 && 'max-w-[30%]')} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  action?: { label: string; href?: string; onClick?: () => void };
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      {Icon && (
        <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary-soft">
          <Icon className="h-6 w-6 text-primary" />
        </div>
      )}
      <div className="space-y-1">
        <p className="font-semibold text-fg">{title}</p>
        {description && <p className="max-w-sm text-sm text-muted">{description}</p>}
      </div>
      {action &&
        (action.href ? (
          <a href={action.href}>
            <Button size="sm">{action.label}</Button>
          </a>
        ) : (
          <Button size="sm" onClick={action.onClick}>
            {action.label}
          </Button>
        ))}
    </div>
  );
}

export function ErrorState({
  title = 'تعذّر تحميل البيانات',
  description = 'حدث خطأ أثناء جلب البيانات. حاول مرة أخرى.',
  retry,
}: {
  title?: string;
  description?: string;
  retry?: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <div className="space-y-1">
        <p className="font-semibold text-danger">{title}</p>
        <p className="max-w-sm text-sm text-muted">{description}</p>
      </div>
      {retry && (
        <Button size="sm" variant="outline" onClick={retry}>
          إعادة المحاولة
        </Button>
      )}
    </div>
  );
}
