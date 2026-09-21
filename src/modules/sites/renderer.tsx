import type { SectionType } from './schemas';
import type { SiteSection } from './types';

/**
 * The first renderer: data-driven, one case per section type, no editor.
 *
 * Content is `Record<string, unknown>` because this phase stores whatever a
 * later editor writes. Every field is therefore read through `str()` / `list()`
 * rather than trusted — a section whose content is an empty object renders its
 * shell and nothing else, which is what a freshly provisioned site looks like.
 */

/** A string field, or the fallback when it is absent, empty or not a string. */
function str(content: Record<string, unknown>, key: string, fallback = ''): string {
  const value = content[key];
  return typeof value === 'string' && value.trim() ? value : fallback;
}

/** An array of records, or an empty list. Never throws on a malformed shape. */
function list(content: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const value = content[key];
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is Record<string, unknown> => !!v && typeof v === 'object');
}

function Hero({ content }: { content: Record<string, unknown> }) {
  return (
    <section className="space-y-3 rounded-xl bg-primary-soft px-6 py-14 text-center">
      <h1 className="text-2xl font-bold text-fg">
        {str(content, 'title', 'عنوان رئيسي')}
      </h1>
      <p className="mx-auto max-w-lg text-sm text-muted">
        {str(content, 'subtitle', 'أضف وصفًا موجزًا لموقعك من لوحة التحرير.')}
      </p>
    </section>
  );
}

function About({ content }: { content: Record<string, unknown> }) {
  return (
    <section className="space-y-2 px-6 py-10">
      <h2 className="text-lg font-bold text-fg">{str(content, 'title', 'من نحن')}</h2>
      <p className="max-w-2xl text-sm leading-7 text-muted">
        {str(content, 'body', 'لم تتم إضافة نص بعد.')}
      </p>
    </section>
  );
}

function Services({ content }: { content: Record<string, unknown> }) {
  const items = list(content, 'items');
  return (
    <section className="space-y-4 px-6 py-10">
      <h2 className="text-lg font-bold text-fg">{str(content, 'title', 'الخدمات')}</h2>
      {items.length === 0 ? (
        <p className="text-sm text-muted">لم تتم إضافة خدمات بعد.</p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {items.map((item, i) => (
            <li key={i} className="rounded-lg border border-border p-4">
              <p className="font-semibold text-fg">{str(item, 'name', 'خدمة')}</p>
              {str(item, 'description') && (
                <p className="mt-1 text-sm text-muted">{str(item, 'description')}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Testimonials({ content }: { content: Record<string, unknown> }) {
  const items = list(content, 'items');
  return (
    <section className="space-y-4 px-6 py-10">
      <h2 className="text-lg font-bold text-fg">{str(content, 'title', 'آراء العملاء')}</h2>
      {items.length === 0 ? (
        <p className="text-sm text-muted">لم تتم إضافة آراء بعد.</p>
      ) : (
        <ul className="space-y-3">
          {items.map((item, i) => (
            <li key={i} className="rounded-lg border border-border p-4">
              <p className="text-sm leading-7 text-fg">“{str(item, 'quote', '—')}”</p>
              <p className="mt-2 text-xs text-muted">{str(item, 'author', 'عميل')}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Contact({ content }: { content: Record<string, unknown> }) {
  const phone = str(content, 'phone');
  const email = str(content, 'email');
  const address = str(content, 'address');
  return (
    <section className="space-y-2 px-6 py-10">
      <h2 className="text-lg font-bold text-fg">{str(content, 'title', 'تواصل معنا')}</h2>
      {!phone && !email && !address ? (
        <p className="text-sm text-muted">لم تتم إضافة بيانات تواصل بعد.</p>
      ) : (
        <dl className="space-y-1 text-sm text-muted">
          {phone && <dd className="lb-numeric">{phone}</dd>}
          {email && <dd>{email}</dd>}
          {address && <dd>{address}</dd>}
        </dl>
      )}
    </section>
  );
}

function Footer({ content }: { content: Record<string, unknown> }) {
  return (
    <footer className="border-t border-border px-6 py-8 text-center text-xs text-muted">
      {str(content, 'text', 'جميع الحقوق محفوظة.')}
    </footer>
  );
}

/**
 * One case per section type, exhaustive by construction.
 *
 * Typed as a total Record, so adding a member to SECTION_TYPES without adding
 * a renderer is a compile error rather than a blank block in production.
 */
const RENDERERS: Record<
  SectionType,
  (props: { content: Record<string, unknown> }) => JSX.Element
> = {
  hero: Hero,
  about: About,
  services: Services,
  testimonials: Testimonials,
  contact: Contact,
  footer: Footer,
};

export function SectionRenderer({ section }: { section: SiteSection }) {
  const Component = RENDERERS[section.sectionType];
  return <Component content={section.content} />;
}

/** Renders one page's visible sections in order. */
export function SiteRenderer({ sections }: { sections: SiteSection[] }) {
  const visible = sections.filter((s) => s.isVisible);

  if (visible.length === 0) {
    return (
      <div className="px-6 py-16 text-center">
        <p className="font-semibold text-fg">لا توجد أقسام بعد</p>
        <p className="mt-1 text-sm text-muted">
          هذه الصفحة فارغة. ستتمكن من إضافة الأقسام من لوحة التحرير.
        </p>
      </div>
    );
  }

  return (
    <div>
      {visible.map((section) => (
        <SectionRenderer key={section.id} section={section} />
      ))}
    </div>
  );
}
