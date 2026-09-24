import { hexToRgbChannels } from '@/lib/color';
import { parseSectionContent, type SectionContent } from './sections/content';
import type { SitePage, SiteSection } from './types';
import type {
  ResolvedBestSellers,
  ResolvedBranches,
  ResolvedBundles,
  ResolvedBusinessInfo,
  ResolvedHours,
  ResolvedMenu,
  ResolvedSectionData,
  ResolvedSectionMap,
} from './resolved';
import { themeSchema, type SiteTheme } from './templates/types';

/**
 * The template renderer.
 *
 * Data-driven and closed: every section type has exactly one component, every
 * component receives content that has already been through its schema, and
 * nothing here reads a raw field. The parse happens once, at the boundary, so
 * a component can use `content.title` without asking whether it is a string.
 *
 * Headings are ordered rather than styled to look ordered. The hero is the
 * page's single <h1>; every other section opens with an <h2>. A screen reader
 * moving by heading gets the real structure of the page, which is the whole
 * reason the tags exist.
 */

/** Section shells share their vertical rhythm so the page reads as one piece. */
const SECTION = 'px-5 py-12 sm:px-8 sm:py-16';

function Hero({ content }: { content: SectionContent['hero'] }) {
  const alignCenter = content.align === 'center';
  return (
    <section
      className={`${SECTION} bg-[rgb(var(--site-primary)/0.06)] ${
        alignCenter ? 'text-center' : 'text-start'
      }`}
    >
      <div className={`mx-auto max-w-2xl ${alignCenter ? '' : 'me-auto ms-0'}`}>
        <h1 className="text-balance text-2xl font-bold leading-tight text-[rgb(var(--site-fg))] sm:text-4xl">
          {content.title || 'اسم نشاطك هنا'}
        </h1>
        {content.subtitle && (
          <p className="mt-3 text-pretty text-sm leading-7 text-[rgb(var(--site-fg)/0.7)] sm:text-base">
            {content.subtitle}
          </p>
        )}
        {content.ctaLabel &&
          (content.ctaHref ? (
            <a
              href={content.ctaHref}
              className="mt-6 inline-flex min-h-11 items-center rounded-lg bg-[rgb(var(--site-primary))] px-5 text-sm font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[rgb(var(--site-primary))]"
            >
              {content.ctaLabel}
            </a>
          ) : (
            // A label with no usable target is still information, so it is
            // shown — but never as something that looks clickable and is not.
            <p className="mt-6 text-sm font-semibold text-[rgb(var(--site-primary))]">
              {content.ctaLabel}
            </p>
          ))}
      </div>
    </section>
  );
}

function About({ content }: { content: SectionContent['about'] }) {
  return (
    <section className={SECTION}>
      <div className="mx-auto max-w-2xl">
        <h2 className="text-lg font-bold text-[rgb(var(--site-fg))] sm:text-xl">
          {content.title || 'من نحن'}
        </h2>
        <p className="mt-3 text-pretty text-sm leading-8 text-[rgb(var(--site-fg)/0.75)]">
          {content.body || 'لم تتم إضافة نص بعد.'}
        </p>
      </div>
    </section>
  );
}

function Services({ content }: { content: SectionContent['services'] }) {
  return (
    <section className={SECTION}>
      <div className="mx-auto max-w-3xl">
        <h2 className="text-lg font-bold text-[rgb(var(--site-fg))] sm:text-xl">
          {content.title || 'الخدمات'}
        </h2>
        {content.items.length === 0 ? (
          <p className="mt-3 text-sm text-[rgb(var(--site-fg)/0.6)]">
            لم تتم إضافة خدمات بعد.
          </p>
        ) : (
          <ul className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {content.items.map((item, i) => (
              <li
                key={i}
                className="rounded-xl border border-[rgb(var(--site-border))] p-4"
              >
                <h3 className="font-semibold text-[rgb(var(--site-fg))]">
                  {item.name || 'خدمة'}
                </h3>
                {item.description && (
                  <p className="mt-1 text-sm leading-6 text-[rgb(var(--site-fg)/0.7)]">
                    {item.description}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function Testimonials({ content }: { content: SectionContent['testimonials'] }) {
  return (
    <section className={`${SECTION} bg-[rgb(var(--site-fg)/0.03)]`}>
      <div className="mx-auto max-w-3xl">
        <h2 className="text-lg font-bold text-[rgb(var(--site-fg))] sm:text-xl">
          {content.title || 'آراء العملاء'}
        </h2>
        {content.items.length === 0 ? (
          <p className="mt-3 text-sm text-[rgb(var(--site-fg)/0.6)]">
            لم تتم إضافة آراء بعد.
          </p>
        ) : (
          <ul className="mt-5 grid gap-3 sm:grid-cols-2">
            {content.items.map((item, i) => (
              <li
                key={i}
                className="rounded-xl border border-[rgb(var(--site-border))] bg-[rgb(var(--site-bg))] p-4"
              >
                {/* blockquote/cite rather than styled divs: the quote and its
                    attribution are related, and the markup should say so. */}
                <blockquote className="text-sm leading-7 text-[rgb(var(--site-fg))]">
                  {item.quote || '—'}
                </blockquote>
                <cite className="mt-2 block text-xs not-italic text-[rgb(var(--site-fg)/0.6)]">
                  {item.author || 'عميل'}
                </cite>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function Contact({ content }: { content: SectionContent['contact'] }) {
  const empty = !content.phone && !content.email && !content.address;
  return (
    <section className={SECTION}>
      <div className="mx-auto max-w-2xl">
        <h2 className="text-lg font-bold text-[rgb(var(--site-fg))] sm:text-xl">
          {content.title || 'تواصل معنا'}
        </h2>
        {empty ? (
          <p className="mt-3 text-sm text-[rgb(var(--site-fg)/0.6)]">
            لم تتم إضافة بيانات تواصل بعد.
          </p>
        ) : (
          <dl className="mt-4 space-y-3 text-sm">
            {content.phone && (
              <div className="flex flex-wrap gap-2">
                <dt className="font-semibold text-[rgb(var(--site-fg))]">الهاتف</dt>
                {/* dir=ltr on the value only: an Arabic page still shows a
                    phone number left-to-right, which is how it is read. */}
                <dd className="lb-numeric text-[rgb(var(--site-fg)/0.75)]" dir="ltr">
                  {content.phone}
                </dd>
              </div>
            )}
            {content.email && (
              <div className="flex flex-wrap gap-2">
                <dt className="font-semibold text-[rgb(var(--site-fg))]">البريد</dt>
                <dd className="text-[rgb(var(--site-fg)/0.75)]" dir="ltr">
                  {content.email}
                </dd>
              </div>
            )}
            {content.address && (
              <div className="flex flex-wrap gap-2">
                <dt className="font-semibold text-[rgb(var(--site-fg))]">العنوان</dt>
                <dd className="text-[rgb(var(--site-fg)/0.75)]">{content.address}</dd>
              </div>
            )}
          </dl>
        )}
      </div>
    </section>
  );
}

function Footer({ content }: { content: SectionContent['footer'] }) {
  return (
    <footer className="border-t border-[rgb(var(--site-border))] px-5 py-8 text-center text-xs text-[rgb(var(--site-fg)/0.6)]">
      {content.text || 'جميع الحقوق محفوظة.'}
    </footer>
  );
}

/**
 * A promotional banner: full-width image, optional headline and link.
 *
 * Always renders something — an empty banner (nothing set at all, a freshly
 * added section) shows its own placeholder heading, the same convention
 * every other section in this file follows, rather than disappearing
 * silently from a page an operator is actively editing.
 */
function Banner({ content }: { content: SectionContent['banner'] }) {
  const empty = !content.title && !content.subtitle && !content.imageUrl;

  return (
    <section className="relative overflow-hidden bg-[rgb(var(--site-fg)/0.04)]">
      {content.imageUrl && (
        // eslint-disable-next-line @next/next/no-img-element -- an
        // organization-supplied external URL, not a build-time asset.
        <img
          src={content.imageUrl}
          alt=""
          className="h-48 w-full object-cover sm:h-64"
        />
      )}
      <div className={`px-5 py-6 sm:px-8 ${content.imageUrl ? 'text-center' : SECTION}`}>
        <h2 className="text-balance text-xl font-bold text-[rgb(var(--site-fg))] sm:text-2xl">
          {content.title || 'عرض جديد'}
        </h2>
        {empty ? (
          <p className="mt-2 text-sm text-[rgb(var(--site-fg)/0.6)]">لم تتم إضافة محتوى للبانر بعد.</p>
        ) : (
          <>
            {content.subtitle && (
              <p className="mt-2 text-pretty text-sm text-[rgb(var(--site-fg)/0.75)] sm:text-base">
                {content.subtitle}
              </p>
            )}
            {content.ctaLabel &&
              (content.ctaHref ? (
                <a
                  href={content.ctaHref}
                  className="mt-4 inline-flex min-h-11 items-center rounded-lg bg-[rgb(var(--site-primary))] px-5 text-sm font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[rgb(var(--site-primary))]"
                >
                  {content.ctaLabel}
                </a>
              ) : (
                <p className="mt-4 text-sm font-semibold text-[rgb(var(--site-primary))]">
                  {content.ctaLabel}
                </p>
              ))}
          </>
        )}
      </div>
    </section>
  );
}


// ===========================================================================
// DATA-BOUND SECTIONS
//
// These render ALREADY-RESOLVED data. Nothing below imports a Supabase client,
// a tenant context, a query builder or a table name — the resolved types in
// ./resolved have no imports at all, which is what makes that structural
// rather than a matter of discipline. The server resolves; this draws.
// ===========================================================================

/** Money in the organization's own currency, in the page's locale. */
function money(cents: number, currency: string): string {
  const whole = cents % 100 === 0;
  return `${(cents / 100).toLocaleString('ar-EG', {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  })} ${currency}`;
}

/** Shown when a data-bound section has nothing resolved behind it. */
function Unavailable({ title, message }: { title: string; message: string }) {
  return (
    <section className={SECTION}>
      <div className="mx-auto max-w-2xl">
        <h2 className="text-lg font-bold text-[rgb(var(--site-fg))] sm:text-xl">{title}</h2>
        <p className="mt-3 text-sm text-[rgb(var(--site-fg)/0.6)]">{message}</p>
      </div>
    </section>
  );
}

/**
 * The organization's menu.
 *
 * Headed "القائمة" and never "قائمة الفرع": a site is organization-scoped, no
 * branch is selected, and the copy must not claim a precision the data does
 * not have.
 */
function Menu({ content, data }: { content: SectionContent['menu']; data: ResolvedMenu }) {
  const title = content.title || 'القائمة';
  if (data.categories.length === 0) {
    return <Unavailable title={title} message="لم تتم إضافة أصناف بعد." />;
  }

  return (
    <section className={SECTION}>
      <div className="mx-auto max-w-3xl">
        <h2 className="text-lg font-bold text-[rgb(var(--site-fg))] sm:text-xl">{title}</h2>
        {data.categories.map((category) => (
          <div key={category.id ?? '__uncategorised__'} className="mt-8 first:mt-5">
            <h3 className="text-base font-semibold text-[rgb(var(--site-primary))]">
              {category.name}
            </h3>
            <ul className="mt-3 space-y-3">
              {category.products.map((product) => (
                <li
                  key={product.id}
                  className="rounded-xl border border-[rgb(var(--site-border))] p-4"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h4 className="font-semibold text-[rgb(var(--site-fg))]">{product.name}</h4>
                    {/* The price is read from the variant at render time. It is
                        not stored in this section and never has been. */}
                    <span className="lb-numeric text-sm font-semibold text-[rgb(var(--site-primary))]">
                      {product.variants.length > 1 ? 'يبدأ من ' : ''}
                      {money(product.fromPriceCents, data.currency)}
                    </span>
                  </div>
                  {product.description && (
                    <p className="mt-1 text-sm leading-6 text-[rgb(var(--site-fg)/0.7)]">
                      {product.description}
                    </p>
                  )}
                  {product.variants.length > 1 && (
                    <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[rgb(var(--site-fg)/0.6)]">
                      {product.variants.map((variant) => (
                        <li key={variant.id}>
                          {variant.name}
                          <span className="lb-numeric ms-1">
                            {money(variant.priceCents, data.currency)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * Organization-level business information.
 *
 * No address, and none is invented: the only addresses belong to branches, and
 * the branches section is where they appear.
 */
function BusinessInfo({
  content,
  data,
}: {
  content: SectionContent['business_info'];
  data: ResolvedBusinessInfo;
}) {
  const title = content.title || data.name;
  const empty = !data.phone && !data.whatsapp && !data.email;

  return (
    <section className={SECTION}>
      <div className="mx-auto max-w-2xl">
        <h2 className="text-lg font-bold text-[rgb(var(--site-fg))] sm:text-xl">{title}</h2>
        {empty ? (
          <p className="mt-3 text-sm text-[rgb(var(--site-fg)/0.6)]">
            لم تتم إضافة بيانات تواصل بعد.
          </p>
        ) : (
          <dl className="mt-4 space-y-3 text-sm">
            {data.phone && (
              <div className="flex flex-wrap gap-2">
                <dt className="font-semibold text-[rgb(var(--site-fg))]">الهاتف</dt>
                <dd className="lb-numeric text-[rgb(var(--site-fg)/0.75)]" dir="ltr">
                  {data.phone}
                </dd>
              </div>
            )}
            {data.whatsapp && (
              <div className="flex flex-wrap gap-2">
                <dt className="font-semibold text-[rgb(var(--site-fg))]">واتساب</dt>
                <dd className="lb-numeric text-[rgb(var(--site-fg)/0.75)]" dir="ltr">
                  {data.whatsapp}
                </dd>
              </div>
            )}
            {data.email && (
              <div className="flex flex-wrap gap-2">
                <dt className="font-semibold text-[rgb(var(--site-fg))]">البريد</dt>
                <dd className="text-[rgb(var(--site-fg)/0.75)]" dir="ltr">
                  {data.email}
                </dd>
              </div>
            )}
          </dl>
        )}
      </div>
    </section>
  );
}

/** Weekday labels, in the order the stored array uses. */
const HOURS_DAYS = [
  'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت', 'الأحد',
] as const;

/**
 * The weekly schedule, exactly as stored.
 *
 * No "open now" badge: the repository has no canonical calculation for it, and
 * a second opinion about when a business is open is worse than none.
 */
function Hours({ content, data }: { content: SectionContent['hours']; data: ResolvedHours }) {
  const title = content.title || 'مواعيد العمل';
  if (data.days.length === 0) {
    return <Unavailable title={title} message="لم تتم إضافة مواعيد عمل بعد." />;
  }

  return (
    <section className={SECTION}>
      <div className="mx-auto max-w-2xl">
        <h2 className="text-lg font-bold text-[rgb(var(--site-fg))] sm:text-xl">{title}</h2>
        <dl className="mt-4 space-y-2 text-sm">
          {data.days.map((day) => (
            <div
              key={day.index}
              className="flex flex-wrap items-baseline justify-between gap-2 border-b border-[rgb(var(--site-border))] pb-2 last:border-0"
            >
              <dt className="font-semibold text-[rgb(var(--site-fg))]">
                {HOURS_DAYS[day.index] ?? String(day.index + 1)}
              </dt>
              {day.closed || !day.opens || !day.closes ? (
                <dd className="text-[rgb(var(--site-fg)/0.6)]">مغلق</dd>
              ) : (
                <dd className="lb-numeric text-[rgb(var(--site-fg)/0.75)]" dir="ltr">
                  {day.opens} – {day.closes}
                </dd>
              )}
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

/** The organization's active branches, each with its own address. */
function Branches({
  content,
  data,
}: {
  content: SectionContent['branches'];
  data: ResolvedBranches;
}) {
  const title = content.title || 'فروعنا';
  if (data.branches.length === 0) {
    return <Unavailable title={title} message="لم تتم إضافة فروع بعد." />;
  }

  return (
    <section className={SECTION}>
      <div className="mx-auto max-w-3xl">
        <h2 className="text-lg font-bold text-[rgb(var(--site-fg))] sm:text-xl">{title}</h2>
        <ul className="mt-5 grid gap-3 sm:grid-cols-2">
          {data.branches.map((branch) => (
            <li
              key={branch.id}
              className="rounded-xl border border-[rgb(var(--site-border))] p-4"
            >
              <h3 className="font-semibold text-[rgb(var(--site-fg))]">{branch.name}</h3>
              {branch.address && (
                <p className="mt-1 text-sm leading-6 text-[rgb(var(--site-fg)/0.7)]">
                  {branch.address}
                </p>
              )}
              {branch.phone && (
                <p className="lb-numeric mt-1 text-sm text-[rgb(var(--site-fg)/0.7)]" dir="ltr">
                  {branch.phone}
                </p>
              )}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/** The organization's flagged best sellers — a highlight strip, not a second menu. */
function BestSellers({
  content,
  data,
}: {
  content: SectionContent['best_sellers'];
  data: ResolvedBestSellers;
}) {
  const title = content.title || 'الأكثر مبيعًا';
  if (data.products.length === 0) {
    return <Unavailable title={title} message="لم يتم تحديد أصناف كأكثر مبيعًا بعد." />;
  }

  return (
    <section className={SECTION}>
      <div className="mx-auto max-w-3xl">
        <h2 className="text-lg font-bold text-[rgb(var(--site-fg))] sm:text-xl">{title}</h2>
        <ul className="mt-5 grid gap-3 sm:grid-cols-2">
          {data.products.map((product) => (
            <li
              key={product.id}
              className="rounded-xl border border-[rgb(var(--site-primary)/0.4)] p-4"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="font-semibold text-[rgb(var(--site-fg))]">{product.name}</h3>
                <span className="lb-numeric text-sm font-semibold text-[rgb(var(--site-primary))]">
                  {product.variants.length > 1 ? 'يبدأ من ' : ''}
                  {money(product.fromPriceCents, data.currency)}
                </span>
              </div>
              {product.description && (
                <p className="mt-1 text-sm leading-6 text-[rgb(var(--site-fg)/0.7)]">
                  {product.description}
                </p>
              )}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/** The organization's bundles/packages — display copy and one all-in price each. */
function Bundles({ content, data }: { content: SectionContent['bundles']; data: ResolvedBundles }) {
  const title = content.title || 'العروض والباقات';
  if (data.bundles.length === 0) {
    return <Unavailable title={title} message="لم تتم إضافة عروض أو باقات بعد." />;
  }

  return (
    <section className={SECTION}>
      <div className="mx-auto max-w-3xl">
        <h2 className="text-lg font-bold text-[rgb(var(--site-fg))] sm:text-xl">{title}</h2>
        <ul className="mt-5 grid gap-4 sm:grid-cols-2">
          {data.bundles.map((bundle) => (
            <li
              key={bundle.id}
              className="overflow-hidden rounded-xl border border-[rgb(var(--site-border))]"
            >
              {bundle.imageUrl && (
                // eslint-disable-next-line @next/next/no-img-element -- an
                // organization-supplied external URL, not a build-time asset.
                <img src={bundle.imageUrl} alt="" className="h-36 w-full object-cover" />
              )}
              <div className="p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="font-semibold text-[rgb(var(--site-fg))]">{bundle.name}</h3>
                  <span className="lb-numeric text-sm font-semibold text-[rgb(var(--site-primary))]">
                    {money(bundle.priceCents, data.currency)}
                  </span>
                </div>
                {bundle.description && (
                  <p className="mt-1 text-sm leading-6 text-[rgb(var(--site-fg)/0.7)]">
                    {bundle.description}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/**
 * Dispatch.
 *
 * A switch rather than a lookup table, because each case needs its own content
 * type and a Record collapses them to a union. Exhaustiveness is not left to
 * discipline: the default branch assigns to `never`, so adding a member to
 * SECTION_TYPES without a case here fails the build instead of rendering
 * nothing in production.
 */
export function SectionRenderer({
  section,
  data,
}: {
  section: SiteSection;
  /**
   * What the resolver produced for THIS section, if anything. Absent is a
   * legitimate state — a page rendered without resolution, or a type the
   * resolver has no case for — and shows the section's unavailable notice
   * rather than throwing.
   */
  data?: ResolvedSectionData;
}) {
  // Parsed here, once. Below this line nothing reads a raw field, and no
  // component has to ask whether a value is the type it claims to be.
  switch (section.sectionType) {
    case 'hero':
      return <Hero content={parseSectionContent('hero', section.content)} />;
    case 'about':
      return <About content={parseSectionContent('about', section.content)} />;
    case 'services':
      return <Services content={parseSectionContent('services', section.content)} />;
    case 'testimonials':
      return (
        <Testimonials content={parseSectionContent('testimonials', section.content)} />
      );
    case 'contact':
      return <Contact content={parseSectionContent('contact', section.content)} />;
    case 'footer':
      return <Footer content={parseSectionContent('footer', section.content)} />;
    case 'banner':
      return <Banner content={parseSectionContent('banner', section.content)} />;

    // Data-bound. The `data.type` check is what narrows the union — a
    // mismatched payload is treated as absent rather than cast into place.
    case 'menu': {
      const content = parseSectionContent('menu', section.content);
      return data?.type === 'menu' ? (
        <Menu content={content} data={data} />
      ) : (
        <Unavailable
          title={content.title || 'القائمة'}
          message="تعذّر تحميل القائمة الآن."
        />
      );
    }
    case 'business_info': {
      const content = parseSectionContent('business_info', section.content);
      return data?.type === 'business_info' ? (
        <BusinessInfo content={content} data={data} />
      ) : (
        <Unavailable
          title={content.title || 'بيانات النشاط'}
          message="تعذّر تحميل بيانات النشاط الآن."
        />
      );
    }
    case 'hours': {
      const content = parseSectionContent('hours', section.content);
      return data?.type === 'hours' ? (
        <Hours content={content} data={data} />
      ) : (
        <Unavailable
          title={content.title || 'مواعيد العمل'}
          message="تعذّر تحميل المواعيد الآن."
        />
      );
    }
    case 'branches': {
      const content = parseSectionContent('branches', section.content);
      return data?.type === 'branches' ? (
        <Branches content={content} data={data} />
      ) : (
        <Unavailable
          title={content.title || 'فروعنا'}
          message="تعذّر تحميل الفروع الآن."
        />
      );
    }
    case 'best_sellers': {
      const content = parseSectionContent('best_sellers', section.content);
      return data?.type === 'best_sellers' ? (
        <BestSellers content={content} data={data} />
      ) : (
        <Unavailable
          title={content.title || 'الأكثر مبيعًا'}
          message="تعذّر تحميل الأصناف الآن."
        />
      );
    }
    case 'bundles': {
      const content = parseSectionContent('bundles', section.content);
      return data?.type === 'bundles' ? (
        <Bundles content={content} data={data} />
      ) : (
        <Unavailable
          title={content.title || 'العروض والباقات'}
          message="تعذّر تحميل العروض الآن."
        />
      );
    }

    default: {
      const unhandled: never = section.sectionType;
      throw new Error(`unhandled section type: ${String(unhandled)}`);
    }
  }
}

/** The CSS variables a theme paints with, as an inline style object. */
export function themeStyle(theme: SiteTheme): React.CSSProperties {
  return {
    ['--site-primary' as string]: hexToRgbChannels(theme.primary),
    ['--site-bg' as string]: hexToRgbChannels(theme.background),
    ['--site-fg' as string]: hexToRgbChannels(theme.foreground),
    ['--site-border' as string]: hexToRgbChannels(theme.border),
  };
}

/**
 * One page, rendered.
 *
 * PAGE-ORIENTED, deliberately. The renderer is handed the page it is to draw
 * and the sections it was given, and it draws that page. It does not choose a
 * page, look at any other page, read a URL, query anything, or decide whether
 * a page the caller asked for exists — selectPage() in ./pages does that, and
 * the route calls it. This component's only job is presentation.
 *
 * `sections` is narrowed to `page` here as well as by the caller. That is not
 * a second opinion about which sections belong to the page — it is the same
 * question answered from the page's own id, and it makes "the renderer showed
 * another page's content" unrepresentable rather than merely unlikely. There
 * is one renderer for every page; the homepage is simply the page the caller
 * selected.
 *
 * `theme` is parsed rather than trusted, so a settings row with a colour
 * someone typed by hand cannot put an arbitrary string into a style attribute.
 */
export function SiteRenderer({
  page,
  sections,
  theme,
  direction = 'rtl',
  resolved,
}: {
  page: SitePage;
  sections: SiteSection[];
  theme?: unknown;
  direction?: 'rtl' | 'ltr';
  /**
   * Data the server resolved for this page's data-bound sections, keyed by
   * section id. A plain object of plain values — the renderer receives the
   * answers, never the means of asking.
   */
  resolved?: ResolvedSectionMap;
}) {
  const safeTheme = themeSchema.parse(
    theme && typeof theme === 'object' ? theme : {},
  );
  const visible = sections.filter((s) => s.pageId === page.id && s.isVisible);

  if (visible.length === 0) {
    return (
      <div
        dir={direction}
        style={themeStyle(safeTheme)}
        className="bg-[rgb(var(--site-bg))] px-6 py-16 text-center"
      >
        <p className="font-semibold text-[rgb(var(--site-fg))]">لا توجد أقسام بعد</p>
        <p className="mt-1 text-sm text-[rgb(var(--site-fg)/0.6)]">
          هذه الصفحة فارغة. ستتمكن من إضافة الأقسام من لوحة التحرير.
        </p>
      </div>
    );
  }

  return (
    <div
      dir={direction}
      style={themeStyle(safeTheme)}
      className="bg-[rgb(var(--site-bg))] text-[rgb(var(--site-fg))]"
    >
      {visible.map((section) => (
        <SectionRenderer
          key={section.id}
          section={section}
          data={resolved?.[section.id]}
        />
      ))}
    </div>
  );
}
