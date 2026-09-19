import type { ResolvedPage, ResolvedSection } from '@/modules/platform/websites/render';
import { themeStyle } from '@/modules/platform/websites/render';
import { SECTION_PROPS, type SectionType } from '@/modules/platform/websites/sections';
import type { SiteDefinition } from '@/modules/platform/websites/definition';

/**
 * The Site Renderer.
 *
 * One component draws every website the platform builds — preview today, the
 * published site later, and whatever an AI generates in the next phase. There
 * is no per-customer template and no stored markup: a section is a case in the
 * switch below, and a section type with no case draws nothing.
 *
 * Every value it prints is text that already passed the schema, so it is
 * interpolated as text. Nothing here uses dangerouslySetInnerHTML, and nothing
 * here should ever start: a definition cannot contain markup, which is what
 * makes rendering an AI-written document safe at all.
 */

/** Narrow a resolved section's props to the schema for its own type. */
function propsOf<T extends SectionType>(
  section: ResolvedSection,
  type: T,
): (typeof SECTION_PROPS)[T]['_output'] | null {
  const parsed = SECTION_PROPS[type].safeParse(section.props);
  return parsed.success ? parsed.data : null;
}

function Heading({ children }: { children: React.ReactNode }) {
  return <h2 className="text-2xl font-bold" style={{ color: 'var(--site-text)' }}>{children}</h2>;
}

function Band({ children }: { children: React.ReactNode }) {
  return <section className="border-b border-black/5 px-6 py-12">{children}</section>;
}

function Placeholder({ label }: { label: string }) {
  return (
    <p className="rounded border border-dashed border-black/15 px-4 py-6 text-center text-sm opacity-60">
      {label}
    </p>
  );
}

function SectionView({ section }: { section: ResolvedSection }) {
  switch (section.type) {
    case 'hero': {
      const p = propsOf(section, 'hero');
      if (!p) return null;
      return (
        <section
          className="px-6 py-20 text-center"
          style={{ background: 'var(--site-primary)', color: '#fff' }}
        >
          <h1 className="text-4xl font-black">{p.title}</h1>
          {p.subtitle && <p className="mx-auto mt-4 max-w-2xl text-lg opacity-90">{p.subtitle}</p>}
          {p.cta && (
            <a
              href={p.cta.target}
              className="mt-8 inline-block px-6 py-3 font-semibold"
              style={{
                background: 'var(--site-accent)',
                borderRadius: 'var(--site-radius)',
                color: '#fff',
              }}
            >
              {p.cta.label}
            </a>
          )}
        </section>
      );
    }

    case 'about': {
      const p = propsOf(section, 'about');
      if (!p) return null;
      return (
        <Band>
          <Heading>{p.title}</Heading>
          <p className="mt-3 max-w-3xl leading-relaxed whitespace-pre-line">{p.body}</p>
        </Band>
      );
    }

    case 'services':
    case 'products':
    case 'features': {
      const p = propsOf(section, section.type);
      if (!p) return null;
      return (
        <Band>
          <Heading>{p.title}</Heading>
          {'subtitle' in p && p.subtitle && <p className="mt-2 opacity-70">{p.subtitle}</p>}
          {p.items.length === 0 ? (
            <Placeholder label="لم تُضَف عناصر بعد." />
          ) : (
            <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {p.items.map((it, i) => (
                <article
                  key={i}
                  className="border border-black/10 p-4"
                  style={{ borderRadius: 'var(--site-radius)' }}
                >
                  <h3 className="font-bold">{it.title}</h3>
                  {it.body && <p className="mt-1 text-sm opacity-75">{it.body}</p>}
                </article>
              ))}
            </div>
          )}
        </Band>
      );
    }

    case 'gallery': {
      const p = propsOf(section, 'gallery');
      if (!p) return null;
      return (
        <Band>
          {p.title && <Heading>{p.title}</Heading>}
          {p.images.length === 0 ? (
            <Placeholder label="لا توجد صور بعد." />
          ) : (
            <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4">
              {p.images.map((src, i) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={i}
                  src={src}
                  alt=""
                  className="h-40 w-full object-cover"
                  style={{ borderRadius: 'var(--site-radius)' }}
                />
              ))}
            </div>
          )}
        </Band>
      );
    }

    case 'testimonials': {
      const p = propsOf(section, 'testimonials');
      if (!p) return null;
      return (
        <Band>
          <Heading>{p.title}</Heading>
          <div className="mt-6 grid gap-4 md:grid-cols-2">
            {p.items.map((t, i) => (
              <blockquote
                key={i}
                className="border-s-4 ps-4"
                style={{ borderColor: 'var(--site-accent)' }}
              >
                <p className="leading-relaxed">{t.quote}</p>
                <footer className="mt-2 text-sm opacity-60">— {t.author}</footer>
              </blockquote>
            ))}
          </div>
        </Band>
      );
    }

    case 'contact': {
      const p = propsOf(section, 'contact');
      if (!p) return null;
      // The real phone, email and WhatsApp come from Core at serve time; the
      // section records only whether to show each one, so the website never
      // holds a stale copy of the customer's contact details.
      const shown = [
        p.show_phone && 'الهاتف',
        p.show_whatsapp && 'واتساب',
        p.show_email && 'البريد',
      ].filter(Boolean) as string[];
      return (
        <Band>
          <Heading>{p.title}</Heading>
          {p.subtitle && <p className="mt-2 opacity-70">{p.subtitle}</p>}
          <p className="mt-4 text-sm opacity-70">
            {shown.length > 0
              ? `تُعرض من بيانات العميل: ${shown.join(' · ')}`
              : 'لم تُفعَّل أي وسيلة تواصل.'}
          </p>
        </Band>
      );
    }

    case 'location': {
      const p = propsOf(section, 'location');
      if (!p) return null;
      return (
        <Band>
          <Heading>{p.title}</Heading>
          {p.address && <p className="mt-3">{p.address}</p>}
        </Band>
      );
    }

    // Both of these render authoritative data from the system at serve time
    // rather than a copy inside the definition, so in preview they show what
    // they are rather than inventing content.
    case 'menu': {
      const p = propsOf(section, 'menu');
      if (!p) return null;
      return (
        <Band>
          <Heading>{p.title}</Heading>
          <Placeholder label="يُعرض المنيو الفعلي من النظام عند النشر." />
        </Band>
      );
    }

    case 'opening_hours': {
      const p = propsOf(section, 'opening_hours');
      if (!p) return null;
      return (
        <Band>
          <Heading>{p.title}</Heading>
          <Placeholder label="تُعرض مواعيد العمل الفعلية من النظام عند النشر." />
        </Band>
      );
    }

    case 'call_to_action': {
      const p = propsOf(section, 'call_to_action');
      if (!p) return null;
      return (
        <section className="px-6 py-14 text-center" style={{ background: 'var(--site-secondary)' }}>
          <h2 className="text-2xl font-bold text-white">{p.title}</h2>
          {p.subtitle && <p className="mt-2 text-white/85">{p.subtitle}</p>}
          <a
            href={p.cta.target}
            className="mt-6 inline-block bg-white px-6 py-3 font-semibold"
            style={{ borderRadius: 'var(--site-radius)', color: 'var(--site-primary)' }}
          >
            {p.cta.label}
          </a>
        </section>
      );
    }

    case 'footer': {
      const p = propsOf(section, 'footer');
      if (!p) return null;
      return (
        <footer className="px-6 py-8 text-sm opacity-70">
          {p.note && <p>{p.note}</p>}
          {p.links && p.links.length > 0 && (
            <nav className="mt-3 flex flex-wrap gap-4">
              {p.links.map((l, i) => (
                <a key={i} href={l.target} className="hover:underline">
                  {l.label}
                </a>
              ))}
            </nav>
          )}
        </footer>
      );
    }

    default:
      // Unreachable while the switch covers the registry. Left in so that
      // adding a section type without a case draws nothing rather than
      // crashing a customer's page.
      return null;
  }
}

export function SiteRenderer({
  definition,
  page,
}: {
  definition: SiteDefinition;
  page: ResolvedPage;
}) {
  const fonts: Record<string, string> = {
    system: 'system-ui, sans-serif',
    cairo: '"Cairo", system-ui, sans-serif',
    tajawal: '"Tajawal", system-ui, sans-serif',
    'ibm-plex-arabic': '"IBM Plex Sans Arabic", system-ui, sans-serif',
  };

  return (
    <div
      dir={definition.metadata.direction}
      style={{
        ...themeStyle(definition),
        background: 'var(--site-bg)',
        color: 'var(--site-text)',
        fontFamily: fonts[definition.theme.fonts.body] ?? fonts.system,
      }}
    >
      {definition.navigation.length > 0 && (
        <nav className="flex flex-wrap gap-5 border-b border-black/10 px-6 py-4 text-sm font-semibold">
          {definition.navigation.map((n, i) => (
            <a key={i} href={n.target} className="hover:underline">
              {n.label}
            </a>
          ))}
        </nav>
      )}
      {page.sections.map((s) => (
        <SectionView key={s.index} section={s} />
      ))}
    </div>
  );
}
