import Link from 'next/link';
import { cn } from '@/lib/cn';
import { PoweredBy } from '@/components/brand/logo';
import {
  WEEKDAYS_AR,
  type Website, type PublicBranch, type OpeningDay,
} from '@/modules/restaurant/website/service';
import {
  DEFAULT_THEME, type SectionConfig, type Theme,
} from '@/modules/restaurant/website/builder-shared';
import {
  lavechiCssVars, LAVECHI_SHELL_BACKDROP, LAVECHI_SHELL_SHADOW,
} from '@/modules/restaurant/website/lavechi-theme';

/**
 * Presentation for the public restaurant website.
 *
 * Server components throughout — the page is content, and shipping a bundle to
 * render a menu would only make it slower. The one interactive piece is the
 * ordering flow, which is D1's and lives on its own route.
 */

const FONT_STACKS: Record<Theme['font'], string> = {
  system: '',
  cairo: '"Cairo", system-ui, sans-serif',
  tajawal: '"Tajawal", system-ui, sans-serif',
  'ibm-plex-arabic': '"IBM Plex Sans Arabic", system-ui, sans-serif',
};

const BUTTON_RADIUS: Record<Theme['buttonStyle'], string> = {
  rounded: '0.375rem',
  square: '0',
  pill: '9999px',
};

/**
 * Restaurant colours and theme applied as CSS variables, scoped to this
 * subtree.
 *
 * Every value here comes from a validated enum or a hex literal — the database
 * refuses anything else — so this object can only ever contain a colour, a
 * length or a font name from a fixed list. No tenant string reaches a
 * stylesheet unvalidated.
 */
export function brandStyle(site: Website, theme: Theme = DEFAULT_THEME): React.CSSProperties {
  // Lavechi is a complete, fixed identity, not a tint of the organization's
  // own colors — every platform token is re-themed at once (see
  // lavechiCssVars), the same way 'dark' and 'warm' already ignore branding
  // colors for their own background choice.
  if (theme.background === 'lavechi') {
    return lavechiCssVars() as React.CSSProperties;
  }

  const primary = hexToRgb(theme.primaryColor ?? site.primaryColor);
  const accent = hexToRgb(theme.accentColor ?? site.secondaryColor);
  const style: Record<string, string> = {
    // Tailwind reads these through rgb(var(--lb-*)), so a restaurant's own
    // palette flows into every token without a rebuild. A theme colour wins
    // over the branding colour when one is set.
    ['--lb-primary']: primary,
    ['--lb-accent']: accent,
    ['--lb-btn-radius']: BUTTON_RADIUS[theme.buttonStyle],
    // The interactive ordering storefront (the 'menu' section, rendered
    // inline here since 0076's unification) reads its own brand tokens under
    // these names — set alongside the --lb-* ones rather than renamed, so
    // neither the site builder's other sections nor the storefront's own
    // standalone routes (/order/<org>/<branch>, custom domains) need to
    // change what variable name they read.
    ['--brand-primary']: primary,
    ['--brand-secondary']: accent,
  };
  if (FONT_STACKS[theme.font]) style['fontFamily'] = FONT_STACKS[theme.font];
  return style as React.CSSProperties;
}

/** The page background, from the theme's four presets. */
export function backgroundClass(theme: Theme = DEFAULT_THEME): string {
  if (theme.background === 'lavechi') {
    // The exact radial gradient the splash/landing screen specifies,
    // applied here so it also covers every other screen this subtree
    // renders — a restaurant's whole storefront is one continuous surface,
    // not a splash screen followed by a plain one.
    return 'bg-[radial-gradient(circle_at_50%_18%,#0C3624,#07231A_60%)] text-[#F4F1E4]';
  }
  return theme.background === 'dark'
    ? 'bg-fg text-white'
    : theme.background === 'warm'
      ? 'bg-[rgb(var(--lb-accent)/0.06)]'
      : 'bg-bg';
}

/** Container width, from the theme's two presets. */
export function containerClass(theme: Theme = DEFAULT_THEME): string {
  return theme.width === 'wide' ? 'max-w-7xl' : 'max-w-5xl';
}

function hexToRgb(hex: string): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return '30 47 200';
  return `${parseInt(m[1]!, 16)} ${parseInt(m[2]!, 16)} ${parseInt(m[3]!, 16)}`;
}

/**
 * A restaurant's logo, or its initial when it has none.
 *
 * `animated` (Lavechi only) adds the ring pulse and a few floating steam
 * wisps — purely decorative, so a missing logo still shows them around the
 * initial-letter mark.
 */
function Mark({ site, className, animated = false }: { site: Website; className?: string; animated?: boolean }) {
  const mark = site.logoUrl ? (
    // eslint-disable-next-line @next/next/no-img-element -- tenant logos are
    // arbitrary remote URLs; next/image would need every host allowlisted.
    <img
      src={site.logoUrl}
      alt={site.organizationName}
      className={cn('h-10 w-10 rounded-full object-cover', animated && 'lavechi-ring-pulse', className)}
      loading="lazy"
    />
  ) : (
    <span
      aria-hidden
      className={cn(
        'flex h-10 w-10 items-center justify-center rounded-full bg-primary text-lg font-extrabold text-primary-fg',
        animated && 'lavechi-ring-pulse',
        className,
      )}
    >
      {site.organizationName.trim().charAt(0)}
    </span>
  );

  if (!animated) return mark;

  return (
    <span className="relative inline-flex">
      {mark}
      <span aria-hidden className="lavechi-steam pointer-events-none absolute -top-2 start-1/2 -translate-x-1/2">
        <span className="absolute block h-3 w-1 -translate-x-2 rounded-full bg-[#F4F1E4]/40 blur-[1px]" />
        <span className="absolute block h-3 w-1 rounded-full bg-[#F4F1E4]/40 blur-[1px]" />
        <span className="absolute block h-3 w-1 translate-x-2 rounded-full bg-[#F4F1E4]/40 blur-[1px]" />
      </span>
    </span>
  );
}

export function SiteHeader({
  site, orgSlug, branch, signedIn, theme = DEFAULT_THEME,
}: {
  site: Website;
  orgSlug: string;
  branch: PublicBranch | null;
  /** Drives the account link only. Authorisation is never a rendered state. */
  signedIn: boolean;
  theme?: Theme;
}) {
  const orderHref = branch ? `/order/${orgSlug}/${branch.slug}` : null;
  const canOrder = Boolean(branch?.orderingEnabled);
  const lavechi = theme.background === 'lavechi';

  return (
    <header
      className={cn(
        'sticky top-0 z-40 border-b border-line backdrop-blur transition-[background-color,box-shadow] duration-300',
        lavechi ? 'bg-bg/70' : 'bg-bg/90',
      )}
    >
      <div className="mx-auto flex h-16 max-w-5xl items-center gap-3 px-4 sm:px-6">
        <Link href={`/r/${orgSlug}`} className="flex items-center gap-2.5">
          <Mark site={site} animated={lavechi} />
          <span className={cn('font-extrabold text-fg', lavechi && 'font-reem font-normal tracking-wide')}>
            {site.organizationName}
          </span>
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
          <Link
            href={signedIn ? `/r/${orgSlug}/account` : `/r/${orgSlug}/account/sign-in`}
            className="rounded px-3 py-2 text-sm font-medium text-muted transition-colors hover:bg-surface hover:text-fg"
          >
            {signedIn ? 'حسابي' : 'تسجيل الدخول'}
          </Link>
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
  site, orgSlug, branch, config = {},
}: {
  site: Website;
  orgSlug: string;
  branch: PublicBranch | null;
  /** Builder content. Empty for a restaurant on the default layout. */
  config?: SectionConfig;
}) {
  // The order button still depends on the branch's real ordering settings: the
  // builder decides whether to OFFER it, never whether it is allowed.
  const canOrder = Boolean(branch?.orderingEnabled) && config.showOrderButton !== false;
  const heroImage = config.imageUrl || site.heroUrl;
  const heading = config.title || site.organizationName;
  const tagline = config.subtitle ?? site.tagline;

  return (
    <section className="relative overflow-hidden border-b border-line">
      {heroImage ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={heroImage}
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
        <div className={cn('max-w-2xl space-y-5', heroImage && 'text-white')}>
          <h1
            className={cn(
              'text-3xl font-extrabold leading-[1.25] sm:text-5xl',
              heroImage ? 'text-white' : 'text-fg',
            )}
          >
            {heading}
          </h1>
          {tagline ? (
            <p className={cn('text-lg leading-relaxed', heroImage ? 'text-white/90' : 'text-muted')}>
              {tagline}
            </p>
          ) : null}

          <div className="flex flex-wrap gap-3 pt-1">
            {canOrder && branch ? (
              <Link
                href={`/order/${orgSlug}/${branch.slug}`}
                style={{ borderRadius: 'var(--lb-btn-radius)' }}
                className="inline-flex h-12 items-center justify-center bg-primary px-7 text-base font-semibold text-primary-fg transition-colors hover:bg-primary/90"
              >
                {config.buttonLabel || 'اطلب الآن'}
              </Link>
            ) : null}
            <a
              href="#menu"
              style={{ borderRadius: 'var(--lb-btn-radius)' }}
              className={cn(
                'inline-flex h-12 items-center justify-center border px-7 text-base font-semibold transition-colors',
                heroImage
                  ? 'border-white/40 text-white hover:bg-white/10'
                  : 'border-line bg-elevated text-fg hover:bg-surface',
              )}
            >
              تصفّح المنيو
            </a>
          </div>

          {!canOrder ? (
            <p className={cn('pt-1 text-sm', heroImage ? 'text-white/80' : 'text-muted')}>
              الطلب أونلاين غير متاح حاليًا. يمكنك تصفّح المنيو والتواصل معنا مباشرة.
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

export function About({ site, config = {} }: { site: Website; config?: SectionConfig }) {
  const body = config.body || site.about;
  if (!body) return null;
  return (
    <section id="about" className="border-b border-line py-14">
      <div className="mx-auto max-w-3xl px-4 sm:px-6">
        <h2 className="mb-3 text-xl font-extrabold text-fg">{config.title || 'عن المطعم'}</h2>
        {config.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- tenant images
          // are arbitrary remote https URLs; next/image needs every host listed.
          <img
            src={config.imageUrl}
            alt=""
            loading="lazy"
            className="mb-4 h-56 w-full rounded-lg object-cover"
          />
        ) : null}
        <p className="whitespace-pre-line text-base leading-relaxed text-muted">{body}</p>
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

export function Location({
  branches, config = {},
}: {
  branches: PublicBranch[];
  config?: SectionConfig;
}) {
  return (
    <section id="location" className="border-b border-line bg-surface py-14">
      <div className="mx-auto max-w-5xl px-4 sm:px-6">
        <h2 className="mb-4 text-xl font-extrabold text-fg">
          {config.title || (branches.length > 1 ? 'فروعنا' : 'أين نحن')}
        </h2>
        <ul className="grid gap-3 sm:grid-cols-2">
          {branches.map((b) => (
            <li key={b.slug} className="rounded-lg border border-line bg-elevated p-4">
              <h3 className="font-bold text-fg">{b.name}</h3>
              {b.address && config.showAddresses !== false ? (
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

export function Hours({
  hours, config = {},
}: {
  hours: OpeningDay[] | null;
  config?: SectionConfig;
}) {
  if (!hours || hours.length !== 7) return null;
  return (
    <section id="hours" className="border-b border-line py-14">
      <div className="mx-auto max-w-3xl px-4 sm:px-6">
        <h2 className="mb-4 text-xl font-extrabold text-fg">
          {config.title || 'مواعيد العمل'}
        </h2>
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

export function Contact({ site, config = {} }: { site: Website; config?: SectionConfig }) {
  // A channel is shown only when the restaurant published it AND the builder
  // left it on. Turning one off here hides it; it never invents one.
  const wa = config.showWhatsapp === false ? null : site.whatsapp?.replace(/[^\d]/g, '');
  const phone = config.showPhone === false ? null : site.phone;
  const email = config.showEmail === false ? null : site.email;
  if (!phone && !wa && !email) return null;

  return (
    <section id="contact" className="border-b border-line bg-surface py-14">
      <div className="mx-auto max-w-3xl px-4 text-center sm:px-6">
        <h2 className="mb-1 text-xl font-extrabold text-fg">
          {config.title || 'تواصل معنا'}
        </h2>
        {config.subtitle ? <p className="mb-4 text-sm text-muted">{config.subtitle}</p> : null}
        <div className="mt-4 flex flex-wrap justify-center gap-3">
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
          {phone ? (
            <a
              href={`tel:${phone}`}
              className="inline-flex h-12 items-center justify-center rounded border border-line bg-elevated px-6 text-base font-semibold text-fg transition-colors hover:bg-surface"
            >
              اتصل بنا
            </a>
          ) : null}
          {email ? (
            <a
              href={`mailto:${email}`}
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

/**
 * A gallery of images the restaurant supplied as https URLs.
 *
 * There is no upload here: this phase stores validated URLs and nothing else,
 * so there is no file-handling surface to get wrong. Every URL passed both the
 * Zod schema and the database check before it could be stored.
 */
export function Gallery({ config = {} }: { config?: SectionConfig }) {
  const images = config.images ?? [];
  if (images.length === 0) return null;

  return (
    <section id="gallery" className="border-b border-line py-14">
      <div className="mx-auto max-w-5xl px-4 sm:px-6">
        <h2 className="mb-4 text-xl font-extrabold text-fg">{config.title || 'صور'}</h2>
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {images.map((src, i) => (
            <li key={`${src}-${i}`}>
              {/* eslint-disable-next-line @next/next/no-img-element -- tenant
                  images are arbitrary remote https URLs; next/image would need
                  every host allowlisted. */}
              <img
                src={src}
                alt=""
                loading="lazy"
                className="h-40 w-full rounded-lg object-cover sm:h-48"
              />
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/**
 * A closing invitation.
 *
 * The destination is one of four fixed choices, never a URL the restaurant
 * types — an arbitrary target would turn the site into an open redirect on the
 * restaurant's own address.
 */
export function Cta({
  orgSlug, branch, config = {},
}: {
  orgSlug: string;
  branch: PublicBranch | null;
  config?: SectionConfig;
}) {
  const target = config.buttonTarget ?? 'order';
  const canOrder = Boolean(branch?.orderingEnabled);

  // An order CTA with nowhere to order is not shown at all, rather than
  // linking a visitor to a page that will refuse them.
  if (target === 'order' && (!canOrder || !branch)) return null;

  const href =
    target === 'order' && branch
      ? `/order/${orgSlug}/${branch.slug}`
      : target === 'menu'
        ? '#menu'
        : target === 'contact'
          ? '#contact'
          : '#location';

  return (
    <section className="border-b border-line bg-primary-soft py-14">
      <div className="mx-auto max-w-3xl px-4 text-center sm:px-6">
        <h2 className="text-2xl font-extrabold text-fg">{config.title || 'جاهز تطلب؟'}</h2>
        {config.subtitle ? (
          <p className="mt-2 text-base leading-relaxed text-muted">{config.subtitle}</p>
        ) : null}
        <Link
          href={href}
          style={{ borderRadius: 'var(--lb-btn-radius)' }}
          className="mt-5 inline-flex h-12 items-center justify-center bg-primary px-8 text-base font-semibold text-primary-fg transition-colors hover:bg-primary/90"
        >
          {config.buttonLabel || 'اطلب الآن'}
        </Link>
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

/**
 * The Lavechi theme's app-like floating container.
 *
 * Below ~460px of viewport width — any real phone — the inner card already
 * IS the full width, so the backdrop never actually shows: this is a no-op
 * there. Above it, the page reads as a phone-shaped app centered on a darker
 * page, exactly the way the spec's screenshots do.
 */
export function LavechiShell({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="flex min-h-dvh w-full justify-center"
      style={{ background: LAVECHI_SHELL_BACKDROP }}
    >
      <div
        className="relative min-h-dvh w-full max-w-[460px] overflow-hidden"
        style={{ boxShadow: LAVECHI_SHELL_SHADOW }}
      >
        {children}
      </div>
    </div>
  );
}
