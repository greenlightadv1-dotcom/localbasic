import { cn } from '@/lib/cn';

/**
 * The LocalBasic wordmark: "local" in the deep blue, "basic" in the mid blue,
 * with the two dots that give the mark its character — the light blue dot
 * under the l, and the mid blue dot over the i.
 *
 * Rendered as SVG with explicit geometry so it stays crisp at every size and
 * never depends on a webfont having loaded.
 */
export function Logo({
  className,
  variant = 'full',
}: {
  className?: string;
  variant?: 'full' | 'mark';
}) {
  if (variant === 'mark') {
    return (
      <svg viewBox="0 0 40 40" className={cn('h-8 w-8', className)} role="img" aria-label="LocalBasic">
        <rect width="40" height="40" rx="10" fill="rgb(var(--lb-primary))" />
        <rect x="10" y="9" width="4.5" height="14" rx="1.6" fill="white" />
        <circle cx="12.25" cy="27" r="2.6" fill="rgb(var(--lb-accent-soft))" />
        <circle cx="25" cy="16" r="5.2" fill="none" stroke="white" strokeWidth="4.2" />
        <circle cx="25" cy="28.5" r="2.6" fill="rgb(var(--lb-accent))" />
      </svg>
    );
  }

  return (
    <svg
      viewBox="0 0 132 44"
      className={cn('h-9 w-auto', className)}
      role="img"
      aria-label="LocalBasic"
    >
      <text
        x="0"
        y="19"
        fill="rgb(var(--lb-primary))"
        fontSize="21"
        fontWeight="800"
        letterSpacing="-0.6"
        fontFamily="var(--lb-font-sans)"
        direction="ltr"
      >
        local
      </text>
      <circle cx="5" cy="26.5" r="3.1" fill="rgb(var(--lb-accent-soft))" />
      <text
        x="0"
        y="41"
        fill="rgb(var(--lb-accent))"
        fontSize="21"
        fontWeight="800"
        letterSpacing="-0.6"
        fontFamily="var(--lb-font-sans)"
        direction="ltr"
      >
        basic
      </text>
      <circle cx="47.5" cy="27" r="3.1" fill="rgb(var(--lb-accent))" />
    </svg>
  );
}

/**
 * The platform attribution. Shown on every surface unless the organization is
 * on a white-label plan — which is verified server-side from the subscription,
 * never from a client flag.
 */
export function PoweredBy({ className }: { className?: string }) {
  return (
    <p className={cn('text-xs text-muted', className)}>
      مدعوم بواسطة <span className="font-semibold text-primary">LocalBasic</span>
      <span className="mx-1 opacity-40">•</span>
      <span>A Green Light Company</span>
    </p>
  );
}
