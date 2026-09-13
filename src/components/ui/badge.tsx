import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/cn';

const badge = cva(
  'inline-flex items-center gap-1 rounded-sm px-2 py-0.5 text-xs font-semibold',
  {
    variants: {
      tone: {
        neutral: 'bg-surface text-muted',
        info: 'bg-primary-soft text-primary',
        success: 'bg-success/10 text-success',
        warn: 'bg-warn/10 text-warn',
        danger: 'bg-danger/10 text-danger',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export function Badge({
  className,
  tone,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badge>) {
  return <span className={cn(badge({ tone }), className)} {...props} />;
}
