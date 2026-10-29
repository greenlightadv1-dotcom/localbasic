import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import { ArrowLeft, ChevronDown } from 'lucide-react';
import { Section, SectionHeading, FeatureCard, Step } from '@/components/patterns/site-sections';
import { WhatsAppCta } from '@/components/patterns/site-chrome';
import { cn } from '@/lib/cn';
import { SECTORS, SECTOR_BY_KEY, type SectorKey } from './sectors';

export type ServicePageContent = {
  sector: SectorKey;
  title: string;
  lead: string;
  /** Short proof points under the hero, three or four. */
  highlights: string[];
  capabilities: { icon: LucideIcon; title: string; body: string }[];
  flow: { eyebrow: string; title: string; steps: { title: string; body: string }[] };
  security: { title: string; body: string }[];
  faq: { q: string; a: string }[];
  cta: { title: string; body: string };
};

/**
 * One layout for every sector's service page — the restaurant page's
 * structure (hero, capabilities, role tour, the flow, security, call to
 * action) plus questions and a way across to the other sectors — so the
 * three read as one product. The sector's accent marks the hero and the
 * capability icons; the brand colour stays the brand.
 */
export function ServicePage({ content, tour }: { content: ServicePageContent; tour: React.ReactNode }) {
  const s = SECTOR_BY_KEY[content.sector];
  const others = SECTORS.filter((x) => x.key !== content.sector);

  return (
    <>
      <section className="relative overflow-hidden border-b border-line bg-surface">
        <div aria-hidden className={cn('pointer-events-none absolute inset-0 bg-gradient-to-bl to-transparent to-60%', s.accent.wash)} />
        <div className="relative mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
          <nav aria-label="مسار الصفحة" className="text-xs text-muted">
            <ol className="flex flex-wrap items-center gap-1.5">
              <li><Link href="/" className="hover:text-primary">الرئيسية</Link></li>
              <li aria-hidden>/</li>
              <li><Link href="/services" className="hover:text-primary">الخدمات</Link></li>
              <li aria-hidden>/</li>
              <li aria-current="page" className="font-semibold text-fg">{s.label}</li>
            </ol>
          </nav>
          <p className={cn('mt-6 inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-bold', s.accent.soft)}>
            <s.icon className="h-4 w-4" aria-hidden="true" /> خدمة Local Basic · {s.label}
          </p>
          <h1 className="mt-4 max-w-3xl text-3xl font-extrabold leading-[1.25] text-fg sm:text-4xl">{content.title}</h1>
          <p className="mt-4 max-w-2xl text-base leading-relaxed text-muted sm:text-lg">{content.lead}</p>
          <div className="mt-7 flex flex-wrap gap-3">
            <WhatsAppCta message={s.whatsapp}>اطلب عرضًا توضيحيًا</WhatsAppCta>
            <Link href="/contact"
              className="inline-flex h-12 items-center justify-center rounded border border-line bg-elevated px-6 text-base font-semibold text-fg transition-colors hover:bg-surface">
              تواصل معنا
            </Link>
          </div>
          <ul className="mt-8 flex flex-wrap gap-2">
            {content.highlights.map((h) => (
              <li key={h} className="inline-flex items-center gap-2 rounded-full border border-line bg-elevated px-3 py-1.5 text-sm text-fg">
                <span className={cn('h-2 w-2 rounded-full', s.accent.dot)} aria-hidden /> {h}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <Section>
        <SectionHeading eyebrow="المكوّنات" title="ماذا يشمل النظام" />
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {content.capabilities.map((c) => (
            <FeatureCard key={c.title} title={c.title} iconClassName={s.accent.soft}
              icon={<c.icon className="h-5 w-5" aria-hidden="true" />}>
              {c.body}
            </FeatureCard>
          ))}
        </div>
      </Section>

      <Section tone="surface">
        <SectionHeading eyebrow="جولة سريعة" title="شاشة لكل دور" lead="اختر دورًا لترى ما يراه صاحبه بالضبط — ولا يرى غيره." />
        <div className="mt-10">{tour}</div>
      </Section>

      <Section>
        <SectionHeading eyebrow={content.flow.eyebrow} title={content.flow.title} />
        <ol className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {content.flow.steps.map((st, i) => <Step key={st.title} n={i + 1} title={st.title}>{st.body}</Step>)}
        </ol>
      </Section>

      <Section tone="surface">
        <SectionHeading eyebrow="الأمان" title="بُني آمنًا من الأساس" />
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {content.security.map((x) => <FeatureCard key={x.title} title={x.title}>{x.body}</FeatureCard>)}
        </div>
      </Section>

      <Section>
        <SectionHeading eyebrow="أسئلة شائعة" title="قبل ما تبدأ" />
        <div className="mx-auto mt-10 max-w-3xl divide-y divide-line rounded-lg border border-line bg-elevated">
          {content.faq.map((f) => (
            <details key={f.q} className="group p-5 [&_summary::-webkit-details-marker]:hidden">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-bold text-fg">
                {f.q}
                <ChevronDown className="h-4 w-4 shrink-0 text-muted transition-transform group-open:rotate-180" aria-hidden="true" />
              </summary>
              <p className="mt-3 text-sm leading-relaxed text-muted">{f.a}</p>
            </details>
          ))}
        </div>
      </Section>

      <Section tone="surface">
        <SectionHeading eyebrow="نفس المنصة" title="أنشطة أخرى على Local Basic" />
        <div className="mx-auto mt-10 grid max-w-4xl gap-4 sm:grid-cols-2">
          {others.map((o) => (
            <Link key={o.key} href={o.detailsHref}
              className="group flex items-center gap-4 rounded-lg border border-line bg-elevated p-5 shadow-card transition hover:-translate-y-0.5 hover:shadow-pop">
              <span className={cn('inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-lg', o.accent.solid)}>
                <o.icon className="h-6 w-6" aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-bold text-fg">{o.label}</span>
                <span className="mt-0.5 block text-sm text-muted">{o.tagline}</span>
              </span>
              <ArrowLeft className="h-5 w-5 shrink-0 text-muted transition-transform group-hover:-translate-x-1" aria-hidden="true" />
            </Link>
          ))}
        </div>
      </Section>

      <Section>
        <div className="rounded-lg border border-line bg-primary px-6 py-14 text-center text-primary-fg">
          <h2 className="text-2xl font-extrabold sm:text-3xl">{content.cta.title}</h2>
          <p className="mx-auto mt-3 max-w-xl text-base leading-relaxed text-primary-fg/85">{content.cta.body}</p>
          <div className="mt-7 flex justify-center">
            <WhatsAppCta message={s.whatsapp}>تواصل عبر واتساب</WhatsAppCta>
          </div>
        </div>
      </Section>
    </>
  );
}
