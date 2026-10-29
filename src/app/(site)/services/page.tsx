import Link from 'next/link';
import type { Metadata } from 'next';
import { Section, SectionHeading, FeatureCard } from '@/components/patterns/site-sections';
import { WhatsAppCta } from '@/components/patterns/site-chrome';
import { cn } from '@/lib/cn';
import { SECTORS } from '../_landing/sectors';

export const metadata: Metadata = {
  title: 'الخدمات',
  description: 'خدمات Local Basic لتشغيل الأعمال المحلية: المطاعم والكافيهات، المتاجر والتجزئة، والعيادات الطبية.',
  robots: { index: true, follow: true },
};

export default function ServicesPage() {
  return (
    <>
      <Section>
        <SectionHeading
          eyebrow="الخدمات"
          title="أنظمة تشغيل للأعمال المحلية"
          lead="نبني كل خدمة على نواة واحدة: مؤسسات، فروع، موظفون، صلاحيات، خزينة وتقارير — ثم نضيف فوقها ما يخص كل نشاط."
        />

        <div className="mt-12 grid gap-4 lg:grid-cols-3">
          {SECTORS.map((sector) => (
            <article key={sector.key}
              className={cn('flex flex-col rounded-lg border border-t-4 border-line bg-elevated p-6 shadow-card', sector.accent.edge)}>
              <div className="flex flex-wrap items-center gap-3">
                <span className={cn('inline-flex h-10 w-10 items-center justify-center rounded', sector.accent.soft)}>
                  <sector.icon className="h-5 w-5" aria-hidden="true" />
                </span>
                <h2 className="text-xl font-extrabold text-fg">{sector.label}</h2>
                <span className="rounded bg-success/15 px-2.5 py-1 text-xs font-bold text-success">متاح الآن</span>
              </div>
              <p className="mt-3 text-base leading-relaxed text-muted">{sector.lead}</p>
              <ul className="mt-4 flex-1 space-y-1.5 text-sm text-fg">
                {sector.features.map((f) => (
                  <li key={f.title} className="flex items-center gap-2">
                    <f.icon className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" /> {f.title}
                  </li>
                ))}
              </ul>
              <div className="mt-6 flex flex-wrap gap-3">
                {(
                  <Link href={sector.detailsHref}
                    className="inline-flex h-11 items-center justify-center rounded bg-primary px-5 text-sm font-semibold text-primary-fg transition-colors hover:bg-primary/90">
                    تفاصيل الخدمة
                  </Link>
                )}
                <WhatsAppCta className="h-11 px-5 text-sm" message={sector.whatsapp}>اطلب عرضًا</WhatsAppCta>
              </div>
            </article>
          ))}
        </div>
      </Section>

      <Section tone="surface">
        <SectionHeading
          eyebrow="قادم"
          title="أنشطة أخرى قيد التطوير"
          lead="نضيف النشاط فقط حين يكون ناضجًا فعلًا على نفس النواة."
        />
        <div className="mx-auto mt-10 grid max-w-md gap-4">
          <FeatureCard title="الورش ومراكز الصيانة">أوامر شغل ومتابعة صيانة.</FeatureCard>
        </div>
        <p className="mt-8 text-center text-sm text-muted">
          هذا النشاط غير متاح للبيع حاليًا.
        </p>
      </Section>
    </>
  );
}
