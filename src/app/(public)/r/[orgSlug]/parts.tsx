import Link from 'next/link';
import { cn } from '@/lib/cn';
import { PoweredBy } from '@/components/brand/logo';
import {
  formatMoney, WEEKDAYS_AR,
  type Website, type PublicBranch, type MenuCategory, type OpeningDay,
} from '@/modules/restaurant/website/service';

/**
 * Presentation for the public restaurant website.
 *
 * Server components throughout — the page is content, and shipping a bundle to
 * render a menu would only make it slower. The one interactive piece is the
 * ordering flow, which is D1's and lives on its own route.
 */

/** Restaurant colours applied as CSS variables, scoped to this subtree. */
export function brandStyle(site: Website): React.CSSProperties {
  return {
    // Tailwind reads these through rgb(var(--lb-*)), so a restaurant's own
    // palette flows into every token without a rebuild.
    ['--lb-primary' as string]: hexToRgb(site.primaryColor),
    ['--lb-accent' as string]: hexToRgb(site.secondaryColor),
  };
}

function hexToRgb(hex: string): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return '30 47 200';
  return `${parseInt(m[1]!, 16)} ${parseInt(m[2]!, 16)} ${parseInt(m[3]!, 16)}`;
}

/** A restaurant's logo, or its initial when it has none. */
function Mark({ site, className }: { site: Website; className?: string }) {
  if (site.logoUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- tenant logos are
      // arbitrary remote URLs; next/image would need every host allowlisted.
      <img
        src={site.logoUrl}
        alt={site.organizationName}
        className={cn('h-10 w-10 rounded-full object-cover', className)}
        loading="lazy"
      />
    );
  }
  return (
    <span
      aria-hidden
      className={cn(
        'flex h-10 w-10 items-center justify-center rounded-full bg-primary text-lg font-extrabold text-primary-fg',
        className,
      )}
    >
      {site.organizationName.trim().charAt(0)}
    </span>
  );
}

export function SiteHeader({
  site, orgSlug, branch,
}: {
  site: Website;
  orgSlug: string;
  branch: PublicBranch | null;
}) {
  const orderHref = branch ? `/order/${orgSlug}/${branch.slug}` : null;
  const canOrder = Boolean(branch?.orderingEnabled);

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-bg/90 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-5xl items-center gap-3 px-4 sm:px-6">
        <Link href={`/r/${orgSlug}`} className="flex items-center gap-2.5">
          <Mark site={site} />
          <span className="font-extrabold text-fg">{site.organizationName}</span>
        </Link>

        <nav aria-label="أقسام الموقع" className="ms-auto flex items-center gap-1">
          <a
            href="#menu"
            className="rounded px-3 py-2 text-sm font-medium text-muted transition-colors hover:bg-surface hover:text-fg"
          >
            المنيو
          </a>
          <a
            href="#location"
            className="hidden rounded px-3 py-2 text-sm font-medium text-muted transition-colors hover:bg-surface hover:text-fg sm:block"
          >
            أين نحن
          </a>
          {canOrder && orderHref ? (
            <Link
              href={orderHref}
              className="inline-flex h-10 items-center rounded bg-primary px-4 text-sm font-semibold text-primary-fg transition-colors hover:bg-primary/90"
            >
              اطلب الآن
            </Link>
          ) : null}
        </nav>
      </div>
    </header>
  );
}

export function Hero({
  site, orgSlug, branch,
}: {
  site: Website;
  orgSlug: string;
  branch: PublicBranch | null;
}) {
  const canOrder = Boolean(branch?.orderingEnabled);

  return (
    <section className="relative overflow-hidden border-b border-line">
      {site.heroUrl ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={site.heroUrl}
            alt=""
            aria-hidden
            className="absolute inset-0 h-full w-full object-cover"
          />
          <div aria-hidden className="absolute inset-0 bg-fg/65" />
        </>
      ) : (
        <div
          aria-hidden
          className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgb(var(--lb-primary)/0.14),transparent_65%)]"
        />
      )}

      <div className="relative mx-auto max-w-5xl px-4 py-16 sm:px-6 sm:py-24">
        <div className={cn('max-w-2xl space-y-5', site.heroUrl && 'text-white')}>
          <h1
            className={cn(
              'text-3xl font-extrabold leading-[1.25] sm:text-5xl',
              site.heroUrl ? 'text-white' : 'text-fg',
            )}
          >
            {site.organizationName}
          </h1>
          {site.tagline ? (
            <p className={cn('text-lg leading-relaxed', site.heroUrl ? 'text-white/90' : 'text-muted')}>
              {site.tagline}
            </p>
          ) : null}

          <div className="flex flex-wrap gap-3 pt-1">
            {canOrder && branch ? (
              <Link
                href={`/order/${orgSlug}/${branch.slug}`}
                className="inline-flex h-12 items-center justify-center rounded bg-primary px-7 text-base font-semibold text-primary-fg transition-colors hover:bg-primary/90"
              >
                اطلب الآن
              </Link>
            ) : null}
            <a
              href="#menu"
              className={cn(
                'inline-flex h-12 items-center justify-center rounded border px-7 text-base font-semibold transition-colors',
                site.heroUrl
                  ? 'border-white/40 text-white hover:bg-white/10'
                  : 'border-line bg-elevated text-fg hover:bg-surface',
              )}
            >
              تصفّح المنيو
            </a>
          </div>

          {!canOrder ? (
            <p className={cn('pt-1 text-sm', site.heroUrl ? 'text-white/80' : 'text-muted')}>
              الطلب أونلاين غير متاح حاليًا. يمكنك تصفّح المنيو والتواصل معنا مباشرة.
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

export function About({ site }: { site: Website }) {
  if (!site.about) return null;
  return (
    <section className="border-b border-line py-14">
      <div className="mx-auto max-w-3xl px-4 sm:px-6">
        <h2 className="mb-3 text-xl font-extrabold text-fg">عن المطعم</h2>
        <p className="whitespace-pre-line text-base leading-relaxed text-muted">{site.about}</p>
      </div>
    </section>
  );
}

/** Branch picker. Only rendered when a restaurant actually has more than one. */
export function BranchPicker({
  orgSlug, branches, current,
}: {
  orgSlug: string;
  branches: PublicBranch[];
  current: PublicBranch;
}) {
  if (branches.length < 2) return null;
  return (
    <section className="border-b border-line bg-surface py-5">
      <div className="mx-auto max-w-5xl px-4 sm:px-6">
        <h2 className="mb-3 text-sm font-bold text-fg">اختر الفرع</h2>
        <ul className="flex flex-wrap gap-2">
          {branches.map((b) => {
            const active = b.slug === current.slug;
            return (
              <li key={b.slug}>
                <Link
                  href={`/r/${orgSlug}/${b.slug}`}
                  aria-current={active ? 'true' : undefined}
                  className={cn(
                    'inline-flex flex-col rounded border px-4 py-2 transition-colors',
                    active
                      ? 'border-primary bg-primary-soft text-primary'
                      : 'border-line bg-elevated text-muted hover:bg-surface hover:text-fg',
                  )}
                >
                  <span className="text-sm font-semibold">{b.name}</span>
                  {!b.orderingEnabled ? (
                    <span className="text-[11px]">الطلب أونلاين موقوف</span>
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

export function Menu({
  categories, site, orgSlug, branch,
}: {
  categories: MenuCategory[];
  site: Website;
  orgSlug: string;
  branch: PublicBranch;
}) {
  if (categories.length === 0) {
    return (
      <section id="menu" className="border-b border-line py-14">
        <div className="mx-auto max-w-5xl px-4 text-center sm:px-6">
          <h2 className="mb-2 text-xl font-extrabold text-fg">المنيو</h2>
          <p className="text-sm text-muted">لم يُضَف المنيو بعد.</p>
        </div>
      </section>
    );
  }

  return (
    <section id="menu" className="border-b border-line py-14">
      <div className="mx-auto max-w-5xl px-4 sm:px-6">
        <h2 className="mb-4 text-xl font-extrabold text-fg">المنيو</h2>

        {/* Category jump-links. A scrollable strip on a phone; wraps on wider
            screens. Anchors rather than state, so it costs no JavaScript. */}
        {categories.length > 1 ? (
          <nav
            aria-label="أقسام المنيو"
            className="sticky top-16 z-30 -mx-4 mb-6 flex gap-2 overflow-x-auto border-y border-line bg-bg/95 px-4 py-2.5 backdrop-blur sm:mx-0 sm:rounded sm:border"
          >
            {categories.map((c) => (
              <a
                key={c.id ?? c.name}
                href={`#cat-${c.id ?? 'other'}`}
                className="whitespace-nowrap rounded px-3 py-1.5 text-sm font-medium text-muted transition-colors hover:bg-surface hover:text-primary"
              >
                {c.name}
              </a>
            ))}
          </nav>
        ) : null}

        <div className="space-y-10">
          {categories.map((c) => (
            <div key={c.id ?? c.name} id={`cat-${c.id ?? 'other'}`} className="scroll-mt-32">
              <h3 className="mb-4 text-lg font-bold text-fg">{c.name}</h3>
              <ul className="grid gap-3 sm:grid-cols-2">
                {c.products.map((p) => (
                  <li
                    key={p.productId}
                    className="flex gap-3 rounded-lg border border-line bg-elevated p-3"
                  >
                    {p.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={p.imageUrl}
                        alt={p.name}
                        loading="lazy"
                        className="h-20 w-20 shrink-0 rounded object-cover"
                      />
                    ) : null}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <h4 className="font-semibold text-fg">{p.name}</h4>
                        <span className="shrink-0 font-bold text-fg">
                          {p.variants.length > 1 ? 'من ' : ''}
                          {formatMoney(p.fromPriceCents, site.currency)}
                        </span>
                      </div>
                      {p.description ? (
                        <p className="mt-1 text-sm leading-relaxed text-muted">{p.description}</p>
                      ) : null}
                      {p.variants.length > 1 ? (
                        <ul className="mt-2 flex flex-wrap gap-1.5">
                          {p.variants.map((v) => (
                            <li
                              key={v.id}
                              className="rounded bg-surface px-2 py-0.5 text-xs text-muted"
                            >
                              {v.name} · {formatMoney(v.priceCents, site.currency)}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {branch.orderingEnabled ? (
          <div className="mt-10 text-center">
            <Link
              href={`/order/${orgSlug}/${branch.slug}`}
              className="inline-flex h-12 items-center justify-center rounded bg-primary px-8 text-base font-semibold text-primary-fg transition-colors hover:bg-primary/90"
            >
              اطلب من {branch.name}
            </Link>
            {branch.deliveryEnabled ? (
              <p className="mt-2 text-sm text-muted">
                التوصيل متاح — رسوم التوصيل {formatMoney(branch.deliveryFeeCents, site.currency)}
              </p>
            ) : null}
            {branch.pickupEnabled && !branch.deliveryEnabled ? (
              <p className="mt-2 text-sm text-muted">الاستلام من الفرع فقط.</p>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

export function Location({ branches }: { branches: PublicBranch[] }) {
  return (
    <section id="location" className="border-b border-line bg-surface py-14">
      <div className="mx-auto max-w-5xl px-4 sm:px-6">
        <h2 className="mb-4 text-xl font-extrabold text-fg">
          {branches.length > 1 ? 'فروعنا' : 'أين نحن'}
        </h2>
        <ul className="grid gap-3 sm:grid-cols-2">
          {branches.map((b) => (
            <li key={b.slug} className="rounded-lg border border-line bg-elevated p-4">
              <h3 className="font-bold text-fg">{b.name}</h3>
              {b.address ? (
                <p className="mt-1 text-sm leading-relaxed text-muted">{b.address}</p>
              ) : null}
              {b.phone ? (
                <a
                  href={`tel:${b.phone}`}
                  dir="ltr"
                  className="mt-2 inline-block text-sm font-semibold text-primary hover:underline"
                >
                  {b.phone}
                </a>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

export function Hours({ hours }: { hours: OpeningDay[] | null }) {
  if (!hours || hours.length !== 7) return null;
  return (
    <section className="border-b border-line py-14">
      <div className="mx-auto max-w-3xl px-4 sm:px-6">
        <h2 className="mb-4 text-xl font-extrabold text-fg">مواعيد العمل</h2>
        <dl className="divide-y divide-line rounded-lg border border-line bg-elevated">
          {hours.map((d, i) => (
            <div key={i} className="flex items-center justify-between px-4 py-2.5 text-sm">
              <dt className="text-fg">{WEEKDAYS_AR[i]}</dt>
              <dd className={d.closed ? 'text-muted' : 'font-semibold text-fg'} dir="ltr">
                {d.closed ? 'مغلق' : `${d.opens} – ${d.closes}`}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

export function Contact({ site }: { site: Website }) {
  const wa = site.whatsapp?.replace(/[^\d]/g, '');
  if (!site.phone && !wa && !site.email) return null;

  return (
    <section id="contact" className="border-b border-line bg-surface py-14">
      <div className="mx-auto max-w-3xl px-4 text-center sm:px-6">
        <h2 className="mb-4 text-xl font-extrabold text-fg">تواصل معنا</h2>
        <div className="flex flex-wrap justify-center gap-3">
          {wa ? (
            <a
              href={`https://wa.me/${wa}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-12 items-center justify-center rounded bg-[#25D366] px-6 text-base font-semibold text-white transition-colors hover:bg-[#1eb455]"
            >
              واتساب
            </a>
          ) : null}
          {site.phone ? (
            <a
              href={`tel:${site.phone}`}
              className="inline-flex h-12 items-center justify-center rounded border border-line bg-elevated px-6 text-base font-semibold text-fg transition-colors hover:bg-surface"
            >
              اتصل بنا
            </a>
          ) : null}
          {site.email ? (
            <a
              href={`mailto:${site.email}`}
              className="inline-flex h-12 items-center justify-center rounded border border-line bg-elevated px-6 text-base font-semibold text-fg transition-colors hover:bg-surface"
            >
              راسلنا
            </a>
          ) : null}
        </div>
      </div>
    </section>
  );
}

export function SiteFooter({
  site, orgSlug, branch,
}: {
  site: Website;
  orgSlug: string;
  branch: PublicBranch | null;
}) {
  return (
    <footer className="py-10">
      <div className="mx-auto max-w-5xl space-y-4 px-4 text-center sm:px-6">
        <p className="font-extrabold text-fg">{site.organizationName}</p>
        {branch?.address ? <p className="text-sm text-muted">{branch.address}</p> : null}
        {site.phone ? (
          <p className="text-sm text-muted" dir="ltr">{site.phone}</p>
        ) : null}

        {branch?.orderingEnabled ? (
          <Link
            href={`/order/${orgSlug}/${branch.slug}`}
            className="inline-flex h-11 items-center justify-center rounded bg-primary px-6 text-sm font-semibold text-primary-fg hover:bg-primary/90"
          >
            اطلب الآن
          </Link>
        ) : null}

        {/* Removing the attribution is a plan feature, resolved server-side. */}
        {!site.whiteLabel ? (
          <div className="pt-2">
            <PoweredBy />
          </div>
        ) : null}
      </div>
    </footer>
  );
}
