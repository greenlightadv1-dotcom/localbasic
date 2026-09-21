import { hexToRgbChannels } from '@/lib/color';
import { parseSectionContent, type SectionContent } from './sections/content';
import type { SiteSection } from './types';
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
 * Dispatch.
 *
 * A switch rather than a lookup table, because each case needs its own content
 * type and a Record collapses them to a union. Exhaustiveness is not left to
 * discipline: the default branch assigns to `never`, so adding a member to
 * SECTION_TYPES without a case here fails the build instead of rendering
 * nothing in production.
 */
export function SectionRenderer({ section }: { section: SiteSection }) {
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
 * `theme` is parsed rather than trusted, so a settings row with a colour
 * someone typed by hand cannot put an arbitrary string into a style attribute.
 */
export function SiteRenderer({
  sections,
  theme,
  direction = 'rtl',
}: {
  sections: SiteSection[];
  theme?: unknown;
  direction?: 'rtl' | 'ltr';
}) {
  const safeTheme = themeSchema.parse(
    theme && typeof theme === 'object' ? theme : {},
  );
  const visible = sections.filter((s) => s.isVisible);

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
        <SectionRenderer key={section.id} section={section} />
      ))}
    </div>
  );
}
