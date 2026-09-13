import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import { cn } from '@/lib/cn';

const TONES = {
  info: { cls: 'border-primary/20 bg-primary-soft text-primary', Icon: Info },
  success: { cls: 'border-success/20 bg-success/10 text-success', Icon: CheckCircle2 },
  warn: { cls: 'border-warn/20 bg-warn/10 text-warn', Icon: AlertTriangle },
  danger: { cls: 'border-danger/20 bg-danger/10 text-danger', Icon: XCircle },
} as const;

export function Alert({
  tone = 'info',
  title,
  children,
  className,
}: {
  tone?: keyof typeof TONES;
  title?: string;
  children?: React.ReactNode;
  className?: string;
}) {
  const { cls, Icon } = TONES[tone];
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn('flex gap-3 rounded border px-4 py-3 text-sm', cls, className)}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="space-y-1">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className="opacity-90">{children}</div>}
      </div>
    </div>
  );
}
