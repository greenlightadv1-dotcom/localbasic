import Link from 'next/link';
import type { Metadata } from 'next';
import { Section, SectionHeading, FeatureCard } from '@/components/patterns/site-sections';
import { WhatsAppCta } from '@/components/patterns/site-chrome';
import { WHATSAPP_MESSAGES } from '@/config/site';

export const metadata: Metadata = {
  title: 'الخدمات',
  description: 'خدمات Local Basic لتشغيل الأعمال المحلية، بدءًا بنظام إدارة المطاعم والكافيهات.',
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

        <div className="mx-auto mt-12 max-w-3xl">
          <article className="rounded-lg border border-line bg-elevated p-6 shadow-card sm:p-8">
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="text-xl font-extrabold text-fg">المطاعم والكافيهات</h2>
              <span className="rounded bg-success/15 px-2.5 py-1 text-xs font-bold text-success">
                متاح الآن
              </span>
            </div>
            <p className="mt-3 text-base leading-relaxed text-muted">
              نظام متكامل: نقطة بيع، شاشة مطبخ، إدارة صالة وطاولات، منيو QR، طلبات أونلاين،
              عملاء، خزينة، تقارير وإيصالات.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link
                href="/services/restaurant"
                className="inline-flex h-11 items-center justify-center rounded bg-primary px-5 text-sm font-semibold text-primary-fg transition-colors hover:bg-primary/90"
              >
                تفاصيل الخدمة
              </Link>
              <WhatsAppCta className="h-11 px-5 text-sm" message={WHATSAPP_MESSAGES.restaurant}>
                اطلب عرضًا
              </WhatsAppCta>
            </div>
          </article>
        </div>
      </Section>

      <Section tone="surface">
        <SectionHeading
          eyebrow="قادم"
          title="أنشطة أخرى قيد التطوير"
          lead="نركّز حاليًا على المطاعم والكافيهات حتى يكون النظام ناضجًا فعلًا قبل التوسع."
        />
        <div className="mt-10 grid gap-4 sm:grid-cols-3">
          <FeatureCard title="التجزئة">نقاط بيع ومخزون للمحلات.</FeatureCard>
          <FeatureCard title="العيادات">حجوزات وملفات مرضى.</FeatureCard>
          <FeatureCard title="الورش">أوامر شغل ومتابعة صيانة.</FeatureCard>
        </div>
        <p className="mt-8 text-center text-sm text-muted">
          هذه الأنشطة غير متاحة للبيع حاليًا.
        </p>
      </Section>
    </>
  );
}
