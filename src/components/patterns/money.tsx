import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/cn';

/**
 * Amounts always render LTR with tabular figures, even inside an RTL page, so
 * columns of numbers line up and a total is never mirrored into nonsense.
 */
export function Money({
  cents,
  currency,
  className,
  tone,
}: {
  cents: number;
  currency: string;
  className?: string;
  tone?: 'default' | 'positive' | 'negative';
}) {
  return (
    <span
      className={cn(
        'lb-numeric',
        tone === 'positive' && 'text-success',
        tone === 'negative' && 'text-danger',
        className,
      )}
    >
      {formatMoney(cents, currency)}
    </span>
  );
}
