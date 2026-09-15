import Link from 'next/link';
import type { Metadata } from 'next';
import { Section, SectionHeading, FeatureCard, Step } from '@/components/patterns/site-sections';
import { WhatsAppCta } from '@/components/patterns/site-chrome';
import { WHATSAPP_MESSAGES } from '@/config/site';
import { PreviewTabs } from './services/restaurant/preview-tabs';

export const metadata: Metadata = {
  title: 'Local Basic — نظام إدارة المطاعم والكافيهات',
  description:
    'منصة تشغيل للأعمال المحلية. نظام متكامل لإدارة المطاعم والكافيهات: نقطة بيع، مطبخ، صالة، QR، طلبات أونلاين، خزينة وتقارير — بالعربية بالكامل.',
  robots: { index: true, follow: true },
};

export default function HomePage() {
  return (
    <>
      {/* ---------------------------------------------------------------- Hero */}
      <section className="relative overflow-hidden border-b border-line">
        {/* Soft brand wash. Pointer-events-none so it never eats a tap. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgb(var(--lb-primary)/0.10),transparent_60%)]"
        />
        <div className="relative mx-auto max-w-6xl px-4 py-20 sm:px-6 sm:py-28">
          <div className="max-w-3xl space-y-6">
            <p className="inline-flex items-center gap-2 rounded-full border border-line bg-elevated px-3 py-1 text-xs font-semibold text-primary">
              مخصص للمطاعم والكافيهات
            </p>
            <h1 className="text-3xl font-extrabold leading-[1.25] text-fg sm:text-5xl">
              شغّل مطعمك بنظام واحد
              <span className="block text-primary">من الطلب حتى التقرير</span>
            </h1>
            <p className="max-w-2xl text-base leading-relaxed text-muted sm:text-lg">
              نقطة بيع سريعة، شاشة مطبخ، إدارة صالة، منيو QR، طلبات أونلاين، خزينة
              وتقارير لحظية — كل ذلك بالعربية، وبصلاحيات دقيقة لكل موظف.
            </p>
            <div className="flex flex-wrap gap-3 pt-2">
              <WhatsAppCta message={WHATSAPP_MESSAGES.demo}>احجز عرضًا توضيحيًا</WhatsAppCta>
              <Link
                href="/services/restaurant"
                className="inline-flex h-12 items-center justify-center rounded border border-line bg-elevated px-6 text-base font-semibold text-fg transition-colors hover:bg-surface"
              >
                استكشف النظام
              </Link>
            </div>
            <p className="pt-2 text-sm text-muted">
              بدون رسوم إعداد مخفية · تدريب على النظام · دعم بالعربية
            </p>
          </div>
        </div>
      </section>

      {/* ----------------------------------------------------------- Who we are */}
      <Section>
        <div className="grid gap-10 md:grid-cols-2 md:items-center">
          <SectionHeading
            align="start"
            eyebrow="من نحن"
            title="نبني أدوات تشغيل للأعمال المحلية"
            lead="Local Basic منصة سعودية-مصرية التوجه، مبنية على فهم أن المطعم المحلي لا يحتاج نظامًا معقدًا بل نظامًا يعمل من أول يوم، بالعربية، وعلى أي جهاز متاح في المحل."
          />
          <dl className="grid gap-4 sm:grid-cols-2">
            {[
              ['عربي أولًا', 'واجهة RTL بالكامل، وليست ترجمة فوق نظام أجنبي.'],
              ['يعمل على أي جهاز', 'كاشير، تابلت، أو موبايل — نفس النظام.'],
              ['صلاحيات دقيقة', 'الكاشير لا يرى التقارير، والمطبخ لا يرى الأموال.'],
              ['بياناتك ملكك', 'عزل كامل لبيانات كل مطعم على مستوى قاعدة البيانات.'],
            ].map(([t, d]) => (
              <div key={t} className="rounded-lg border border-line bg-elevated p-4">
                <dt className="font-bold text-fg">{t}</dt>
                <dd className="mt-1 text-sm leading-relaxed text-muted">{d}</dd>
              </div>
            ))}
          </dl>
        </div>
      </Section>

      {/* --------------------------------------------------- Problems we solve */}
      <Section tone="surface">
        <SectionHeading
          eyebrow="المشكلة"
          title="أغلب المطاعم تُدار بأدوات متفرقة"
          lead="دفتر للطلبات، واتساب للمطبخ، إكسل للحسابات، وذاكرة المدير لكل شيء آخر. النتيجة: أخطاء، تسريب مالي، وقرارات بلا أرقام."
        />
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <FeatureCard title="طلبات تضيع بين الصالة والمطبخ">
            الطلب يُكتب على ورقة ثم يُقرأ خطأ. شاشة المطبخ تنهي هذا: الطلب يظهر لحظة تسجيله بحالته ووقته.
          </FeatureCard>
          <FeatureCard title="لا أحد يعرف المبيعات إلا آخر اليوم">
            التقارير اللحظية تعطي المبيعات والأصناف الأكثر طلبًا والخزينة في أي لحظة.
          </FeatureCard>
          <FeatureCard title="فرق في الخزينة بلا تفسير">
            كل حركة مالية مقيّدة ولا تُعدّل ولا تُحذف. الرصيد محسوب من الحركات، لا مكتوب يدويًا.
          </FeatureCard>
          <FeatureCard title="كل موظف يرى كل شيء">
            صلاحيات على مستوى الفرع والوظيفة: الكاشير يحصّل، والمطبخ يحضّر، والمالك فقط يرى الأرقام.
          </FeatureCard>
          <FeatureCard title="المنيو الورقي يتغير كل شهر">
            منيو QR يُحدَّث من لوحة التحكم، والسعر الجديد يظهر فورًا دون طباعة.
          </FeatureCard>
          <FeatureCard title="الطلب أونلاين عبر واتساب فقط">
            طلبات أونلاين بسلة وحساب عميل وعناوين محفوظة، تدخل نفس محرك الطلبات مباشرة.
          </FeatureCard>
        </div>
      </Section>

      {/* -------------------------------------------------- Restaurant service */}
      <Section>
        <SectionHeading
          eyebrow="الخدمة"
          title="نظام إدارة المطاعم والكافيهات"
          lead="خدمتنا الأولى، مبنية بالكامل ومتاحة الآن."
        />
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            ['نقطة البيع', 'شاشة كاشير سريعة بأزرار كبيرة، تعمل باللمس.'],
            ['شاشة المطبخ', 'الطلبات بحالتها ووقتها، بدون أي صلاحية مالية.'],
            ['الصالة والطاولات', 'خريطة طاولات بحالات واضحة وربط بالطلب.'],
            ['منيو QR', 'رابط مُعمّى لكل طاولة، والضيف يطلب من جواله.'],
            ['طلبات أونلاين', 'استلام أو توصيل، بسلة وحساب عميل.'],
            ['الخزينة', 'قيود مالية غير قابلة للتعديل أو الحذف.'],
            ['التقارير', 'مبيعات، أصناف، فترات، وفروع.'],
            ['الإيصالات', 'إيصال عميل واضح وقابل للطباعة.'],
          ].map(([t, d]) => (
            <FeatureCard key={t} title={t!}>{d}</FeatureCard>
          ))}
        </div>
        <div className="mt-8 text-center">
          <Link
            href="/services/restaurant"
            className="inline-flex h-12 items-center justify-center rounded bg-primary px-6 text-base font-semibold text-primary-fg transition-colors hover:bg-primary/90"
          >
            تفاصيل نظام المطاعم
          </Link>
        </div>
      </Section>

      {/* -------------------------------------------------------- How it works */}
      <Section tone="surface">
        <SectionHeading eyebrow="كيف نبدأ" title="من أول تواصل حتى التشغيل" />
        <ol className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Step n={1} title="تواصل معنا">راسلنا على واتساب واشرح حجم مطعمك واحتياجك.</Step>
          <Step n={2} title="عرض توضيحي">نعرض النظام على حالتك تحديدًا، لا عرضًا عامًا.</Step>
          <Step n={3} title="تجهيز المساحة">ننشئ مساحة عملك ونرفع المنيو والفروع والموظفين.</Step>
          <Step n={4} title="تشغيل وتدريب">ندرّب الفريق ونبقى معك بعد التشغيل.</Step>
        </ol>
      </Section>

      {/* ------------------------------------------------------ Product preview */}
      <Section>
        <SectionHeading
          eyebrow="جولة سريعة"
          title="شاشة لكل دور"
          lead="كل موظف يرى ما يخصه فقط. اختر دورًا لترى واجهته."
        />
        <div className="mt-10">
          <PreviewTabs />
        </div>
      </Section>

      {/* ------------------------------------------------------------ Benefits */}
      <Section tone="surface">
        <SectionHeading eyebrow="الأثر" title="ماذا يتغير بعد التشغيل" />
        <div className="mt-10 grid gap-4 sm:grid-cols-3">
          <FeatureCard title="خدمة أسرع">الطلب يصل المطبخ لحظة تسجيله، بلا ورق ولا نداء.</FeatureCard>
          <FeatureCard title="تحكم مالي">كل جنيه مقيّد ومنسوب لموظف ووقت وفرع.</FeatureCard>
          <FeatureCard title="قرارات بأرقام">تعرف أكثر صنف مبيعًا وأضعف وقت في اليوم.</FeatureCard>
        </div>
      </Section>

      {/* ----------------------------------------------------------------- CTA */}
      <Section>
        <div className="rounded-lg border border-line bg-primary px-6 py-14 text-center text-primary-fg">
          <h2 className="text-2xl font-extrabold sm:text-3xl">جاهز تشوف النظام على مطعمك؟</h2>
          <p className="mx-auto mt-3 max-w-xl text-base leading-relaxed text-primary-fg/85">
            راسلنا على واتساب ورتّب عرضًا توضيحيًا. بدون التزام.
          </p>
          <div className="mt-7 flex flex-wrap justify-center gap-3">
            <WhatsAppCta message={WHATSAPP_MESSAGES.demo}>احجز عرضًا توضيحيًا</WhatsAppCta>
            <Link
              href="/contact"
              className="inline-flex h-12 items-center justify-center rounded border border-primary-fg/30 px-6 text-base font-semibold text-primary-fg transition-colors hover:bg-primary-fg/10"
            >
              طرق تواصل أخرى
            </Link>
          </div>
        </div>
      </Section>
    </>
  );
}
