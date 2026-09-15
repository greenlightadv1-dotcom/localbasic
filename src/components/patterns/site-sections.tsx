import { cn } from '@/lib/cn';

/** A full-width band with the standard page gutter and vertical rhythm. */
export function Section({
  className,
  tone = 'plain',
  children,
  ...props
}: React.HTMLAttributes<HTMLElement> & { tone?: 'plain' | 'surface' }) {
  return (
    <section
      className={cn('py-16 sm:py-20', tone === 'surface' && 'bg-surface', className)}
      {...props}
    >
      <div className="mx-auto max-w-6xl px-4 sm:px-6">{children}</div>
    </section>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  lead,
  align = 'center',
}: {
  eyebrow?: string;
  title: string;
  lead?: string;
  align?: 'center' | 'start';
}) {
  return (
    <div className={cn('max-w-2xl space-y-3', align === 'center' && 'mx-auto text-center')}>
      {eyebrow ? (
        <p className="text-sm font-bold text-primary">{eyebrow}</p>
      ) : null}
      <h2 className="text-2xl font-extrabold leading-tight text-fg sm:text-3xl">{title}</h2>
      {lead ? <p className="text-base leading-relaxed text-muted">{lead}</p> : null}
    </div>
  );
}

export function FeatureCard({
  title,
  children,
  icon,
}: {
  title: string;
  children: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-line bg-elevated p-5 shadow-card transition-shadow hover:shadow-md">
      {icon ? (
        <div className="mb-3 inline-flex h-10 w-10 items-center justify-center rounded bg-primary-soft text-primary">
          {icon}
        </div>
      ) : null}
      <h3 className="mb-2 font-bold text-fg">{title}</h3>
      <p className="text-sm leading-relaxed text-muted">{children}</p>
    </div>
  );
}

/** Numbered step used by the "how it works" bands. */
export function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="relative rounded-lg border border-line bg-elevated p-5">
      <span className="mb-3 inline-flex h-9 w-9 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-fg">
        {n}
      </span>
      <h3 className="mb-1.5 font-bold text-fg">{title}</h3>
      <p className="text-sm leading-relaxed text-muted">{children}</p>
    </li>
  );
}
