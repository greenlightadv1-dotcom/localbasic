import type { Metadata } from 'next';
import { Section, SectionHeading, FeatureCard } from '@/components/patterns/site-sections';
import { WhatsAppCta } from '@/components/patterns/site-chrome';

export const metadata: Metadata = {
  title: 'من نحن',
  description: 'Local Basic — منصة تشغيل للأعمال المحلية، من Green Light.',
  robots: { index: true, follow: true },
};

export default function AboutPage() {
  return (
    <>
      <Section>
        <SectionHeading
          eyebrow="من نحن"
          title="نبني أنظمة تشغيل تُستخدم فعلًا"
          lead="Local Basic منتج من Green Light. بدأنا من ملاحظة بسيطة: أغلب الأنظمة المتاحة للأعمال المحلية إما أجنبية ومعقّدة، أو محلية وغير مكتملة."
        />
        <div className="mx-auto mt-10 max-w-3xl space-y-4 text-base leading-relaxed text-muted">
          <p>
            اخترنا أن نبدأ بنشاط واحد — المطاعم والكافيهات — وأن نُنضجه بالكامل قبل التوسع،
            بدل أن نقدّم عشرة أنشطة نصف جاهزة.
          </p>
          <p>
            النظام مبني بالعربية أولًا، لا كترجمة لاحقة، ويعمل على الأجهزة الموجودة فعلًا في
            المحل: جهاز الكاشير، التابلت، وموبايل الكابتن.
          </p>
        </div>
      </Section>

      <Section tone="surface">
        <SectionHeading eyebrow="مبادئنا" title="كيف نتخذ قراراتنا" />
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <FeatureCard title="الوضوح قبل الميزات">شاشة يفهمها موظف جديد في دقائق أهم من قائمة ميزات طويلة.</FeatureCard>
          <FeatureCard title="الأمان ليس خيارًا">عزل البيانات والصلاحيات جزء من التصميم، لا إضافة لاحقة.</FeatureCard>
          <FeatureCard title="الأرقام لا تُمسّ">السجلات المالية مقيّدة ولا تقبل التعديل أو الحذف.</FeatureCard>
          <FeatureCard title="لا وعود زائفة">لا ندّعي تكاملًا أو اعتمادًا رسميًا لا نملكه فعلًا.</FeatureCard>
        </div>
      </Section>

      <Section>
        <div className="mx-auto max-w-2xl rounded-lg border border-line bg-elevated p-8 text-center">
          <h2 className="text-xl font-extrabold text-fg">تحب تعرف أكثر؟</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            راسلنا مباشرة وسنرد عليك بنفسنا.
          </p>
          <div className="mt-6 flex justify-center">
            <WhatsAppCta />
          </div>
        </div>
      </Section>
    </>
  );
}
