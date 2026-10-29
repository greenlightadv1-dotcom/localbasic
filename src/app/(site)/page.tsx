import Link from 'next/link';
import type { Metadata } from 'next';
import {
  BarChart3, Building2, KeyRound, Languages, MessageCircle, Smartphone, Wallet,
} from 'lucide-react';
import { Section, SectionHeading, FeatureCard, Step } from '@/components/patterns/site-sections';
import { WhatsAppCta } from '@/components/patterns/site-chrome';
import { WHATSAPP_MESSAGES } from '@/config/site';
import { cn } from '@/lib/cn';
import { SECTORS } from './_landing/sectors';
import { VerticalSwitcher } from './_landing/vertical-switcher';
import { RoleTour } from './_landing/role-tour';

export const metadata: Metadata = {
  title: 'Local Basic — نظام واحد لتشغيل نشاطك التجاري',
  description:
    'منصة تشغيل للأعمال المحلية بالعربية: المطاعم والكافيهات، المتاجر والتجزئة، والعيادات الطبية — نقطة بيع، مخزون، مواعيد، ملف المريض، خزينة وتقارير في نظام واحد.',
  robots: { index: true, follow: true },
};

/** What every sector shares: the core the trade-specific screens sit on. */
const CORE = [
  { icon: Wallet, title: 'خزينة لا تُعدَّل', body: 'كل حركة مالية مقيّدة ومنسوبة لموظف ووقت وفرع.' },
  { icon: BarChart3, title: 'تقارير لحظية', body: 'المبيعات والأصناف والفروع في أي لحظة، لا آخر اليوم.' },
  { icon: KeyRound, title: 'صلاحيات دقيقة', body: 'كل موظف يرى ما يخص دوره فقط، والحساسة بموافقة المدير.' },
  { icon: Building2, title: 'فروع متعددة', body: 'كل الفروع من حساب واحد، والبيانات معزولة لكل منشأة.' },
  { icon: Smartphone, title: 'أي جهاز', body: 'كاشير، تابلت، أو موبايل — نفس النظام من المتصفح.' },
  { icon: Languages, title: 'عربي أولًا', body: 'واجهة من اليمين لليسار بالكامل، لا ترجمة فوق نظام أجنبي.' },
];

export default function HomePage() {
  return (
    <>
      {/* ---------------------------------------------------------------- Hero */}
      <section className="relative overflow-hidden border-b border-line">
        {/* Soft brand wash. Pointer-events-none so it never eats a tap. */}
        <div aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgb(var(--lb-primary)/0.10),transparent_60%)]" />
        <div className="relative mx-auto grid max-w-6xl gap-12 px-4 py-16 sm:px-6 sm:py-24 lg:grid-cols-[1.15fr_1fr] lg:items-center">
          <div className="space-y-6">
            <p className="inline-flex items-center gap-2 rounded-full border border-line bg-elevated px-3 py-1 text-xs font-semibold text-primary">
              منصة تشغيل للأعمال المحلية
            </p>
            <h1 className="text-3xl font-extrabold leading-[1.25] text-fg sm:text-5xl lg:text-[2.75rem] xl:text-5xl">
              شغّل نشاطك التجاري بنظام واحد
              <span className="block text-primary">من المبيعات وحتى التقارير</span>
            </h1>
            <p className="max-w-2xl text-base leading-relaxed text-muted sm:text-lg">
              مطعم أو متجر أو عيادة: نقطة بيع، مخزون، مواعيد، خزينة وتقارير لحظية في نظام واحد،
              بالعربية بالكامل، ولكل موظف صلاحياته.
            </p>

            {/* Plain anchors: they work before hydration and tailor the switcher below. */}
            <nav aria-label="اختر نشاطك" className="flex flex-wrap gap-2">
              {SECTORS.map((s) => (
                <a key={s.key} href={`#${s.key}`}
                  className="group inline-flex items-center gap-2 rounded-full border border-line bg-elevated px-4 py-2 text-sm font-semibold text-fg shadow-card transition hover:-translate-y-0.5 hover:shadow-pop">
                  <span className={cn('inline-flex h-7 w-7 items-center justify-center rounded-full', s.accent.soft)}>
                    <s.icon className="h-4 w-4" aria-hidden="true" />
                  </span>
                  {s.label}
                </a>
              ))}
            </nav>

            <div className="flex flex-wrap gap-3 pt-1">
              <WhatsAppCta message={WHATSAPP_MESSAGES.demo}>احجز عرضًا توضيحيًا</WhatsAppCta>
              <a href="#sectors"
                className="inline-flex h-12 items-center justify-center rounded border border-line bg-elevated px-6 text-base font-semibold text-fg transition-colors hover:bg-surface">
                استكشف النظام
              </a>
            </div>
            <p className="text-sm text-muted">بدون رسوم إعداد مخفية · تدريب على النظام · دعم بالعربية</p>
          </div>

          {/* One core, three trades: a stacked collage, decorative only. */}
          <div aria-hidden className="relative mx-auto hidden w-full max-w-md lg:block">
            <div className="absolute -inset-6 rounded-[2rem] bg-gradient-to-br from-orange-500/10 via-emerald-500/10 to-sky-500/10 blur-2xl" />
            <div className="relative space-y-3">
              {SECTORS.map((s, i) => (
                <div key={s.key}
                  className={cn('flex items-center gap-4 rounded-lg border border-line bg-elevated p-4 shadow-pop animate-fade-up',
                    i === 1 && 'ms-8', i === 2 && 'ms-16')}
                  style={{ animationDelay: `${150 + i * 120}ms` }}>
                  <span className={cn('inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-lg', s.accent.solid)}>
                    <s.icon className="h-6 w-6" />
                  </span>
                  <span className="min-w-0">
                    <span className="block font-bold text-fg">{s.label}</span>
                    <span className="block truncate text-sm text-muted">{s.features.slice(0, 3).map((f) => f.title).join(' · ')}</span>
                  </span>
                </div>
              ))}
              <div className="ms-24 flex items-center gap-2 rounded-full border border-line bg-elevated px-4 py-2 text-xs font-semibold text-muted shadow-card">
                <span className="h-2 w-2 rounded-full bg-success" /> خزينة وتقارير وصلاحيات مشتركة
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* --------------------------------------------------------- The sectors */}
      <Section id="sectors" className="scroll-mt-20">
        {/* Hash targets for the hero chips; the switcher reads the hash. */}
        {SECTORS.map((s) => <span key={s.key} id={s.key} className="block scroll-mt-24" aria-hidden />)}
        <SectionHeading
          eyebrow="لكل نشاط شاشاته"
          title="اختر نشاطك وشوف النظام عليه"
          lead="نواة واحدة مجرّبة، وفوقها ما يخص كل نشاط بالضبط — لا نظام عام يحاول يناسب الكل."
        />
        <div className="mt-10">
          <VerticalSwitcher />
        </div>
      </Section>

      {/* ---------------------------------------------------------- Shared core */}
      <Section tone="surface">
        <div className="grid gap-10 lg:grid-cols-[1fr_1.4fr] lg:items-center">
          <SectionHeading
            align="start"
            eyebrow="نواة واحدة"
            title="نفس الأساس تحت كل نشاط"
            lead="Local Basic مبني على فهم أن النشاط المحلي لا يحتاج نظامًا معقدًا، بل نظامًا يعمل من أول يوم، بالعربية، وعلى أي جهاز متاح في المحل."
          />
          <ul className="grid gap-3 sm:grid-cols-2">
            {CORE.map((c) => (
              <li key={c.title} className="flex gap-3 rounded-lg border border-line bg-elevated p-4">
                <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded bg-primary-soft text-primary">
                  <c.icon className="h-5 w-5" aria-hidden="true" />
                </span>
                <span>
                  <span className="block font-bold text-fg">{c.title}</span>
                  <span className="mt-1 block text-sm leading-relaxed text-muted">{c.body}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </Section>

      {/* --------------------------------------------------- Problems we solve */}
      <Section>
        <SectionHeading
          eyebrow="المشكلة"
          title="أغلب الأنشطة تُدار بأدوات متفرقة"
          lead="دفتر للطلبات والمواعيد، واتساب للتنسيق، إكسل للحسابات، وذاكرة المدير لكل شيء آخر. النتيجة: أخطاء، تسريب مالي، وقرارات بلا أرقام."
        />
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <FeatureCard title="طلبات تضيع بين الصالة والمطبخ">
            الطلب يظهر في المطبخ لحظة تسجيله بحالته ووقته، والإضافات مكتوبة بوضوح.
          </FeatureCard>
          <FeatureCard title="مخزون على الورق فقط">
            كل بيع وتحويل ومرتجع يحرّك المخزون فورًا، والنظام يقترح إعادة الطلب قبل ما الصنف يخلص.
          </FeatureCard>
          <FeatureCard title="حجز مزدوج وانتظار بلا نظام">
            المواعيد حسب ورديات كل طبيب، والحجز في موعد محجوز مرفوض من الأساس.
          </FeatureCard>
          <FeatureCard title="فرق في الخزينة بلا تفسير">
            كل حركة مالية مقيّدة ولا تُعدّل ولا تُحذف. الرصيد محسوب من الحركات، لا مكتوب يدويًا.
          </FeatureCard>
          <FeatureCard title="كل موظف يرى كل شيء">
            الكاشير يحصّل، والمطبخ يحضّر بلا أرقام، والاستقبال لا يرى الملف الطبي، والمالك فقط يرى التقارير.
          </FeatureCard>
          <FeatureCard title="لا أحد يعرف الأرقام إلا آخر الشهر">
            مبيعات اليوم، وأكثر صنف مبيعًا، وإيراد كل طبيب — لحظيًا ولكل فرع.
          </FeatureCard>
        </div>
      </Section>

      {/* ------------------------------------------------------ Product preview */}
      <Section tone="surface">
        <SectionHeading
          eyebrow="جولة سريعة"
          title="شاشة لكل دور"
          lead="كل موظف يرى ما يخصه فقط. اختر النشاط ثم الدور لترى واجهته."
        />
        <div className="mt-10">
          <RoleTour />
        </div>
      </Section>

      {/* -------------------------------------------------------- How it works */}
      <Section>
        <SectionHeading eyebrow="كيف نبدأ" title="من أول تواصل حتى التشغيل" />
        <ol className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Step n={1} title="تواصل معنا">راسلنا على واتساب واشرح نشاطك وحجمه واحتياجك.</Step>
          <Step n={2} title="عرض توضيحي">نعرض النظام على حالتك تحديدًا، لا عرضًا عامًا.</Step>
          <Step n={3} title="تجهيز المساحة">ننشئ مساحة عملك ونرفع الأصناف أو الخدمات والفروع والموظفين.</Step>
          <Step n={4} title="تشغيل وتدريب">ندرّب الفريق ونبقى معك بعد التشغيل.</Step>
        </ol>
      </Section>

      {/* ------------------------------------------------------------ Benefits */}
      <Section tone="surface">
        <SectionHeading eyebrow="الأثر" title="ماذا يتغير بعد التشغيل" />
        <div className="mt-10 grid gap-4 sm:grid-cols-3">
          <FeatureCard title="خدمة أسرع">الطلب يصل المطبخ لحظيًا، والفاتورة تُصدر في ثوانٍ، والمريض لا ينتظر بلا سبب.</FeatureCard>
          <FeatureCard title="تحكم مالي">كل جنيه مقيّد ومنسوب لموظف ووقت وفرع.</FeatureCard>
          <FeatureCard title="قرارات بأرقام">تعرف أكثر صنف مبيعًا، وأضعف وقت في اليوم، وأنشط طبيب.</FeatureCard>
        </div>
      </Section>

      {/* ----------------------------------------------------------------- CTA */}
      <Section>
        <div className="rounded-lg border border-line bg-primary px-6 py-14 text-center text-primary-fg">
          <h2 className="text-2xl font-extrabold sm:text-3xl">جاهز تشوف النظام على نشاطك؟</h2>
          <p className="mx-auto mt-3 max-w-xl text-base leading-relaxed text-primary-fg/85">
            راسلنا على واتساب ورتّب عرضًا توضيحيًا لمطعمك أو متجرك أو عيادتك. بدون التزام.
          </p>
          <div className="mt-7 flex flex-wrap justify-center gap-3">
            <WhatsAppCta message={WHATSAPP_MESSAGES.demo}>احجز عرضًا توضيحيًا</WhatsAppCta>
            <Link href="/contact"
              className="inline-flex h-12 items-center justify-center gap-2 rounded border border-primary-fg/30 px-6 text-base font-semibold text-primary-fg transition-colors hover:bg-primary-fg/10">
              <MessageCircle className="h-4 w-4" aria-hidden="true" /> طرق تواصل أخرى
            </Link>
          </div>
        </div>
      </Section>
    </>
  );
}
