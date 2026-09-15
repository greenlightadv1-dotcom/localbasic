import Link from 'next/link';
import type { Metadata } from 'next';
import { Section, SectionHeading, FeatureCard, Step } from '@/components/patterns/site-sections';
import { WhatsAppCta } from '@/components/patterns/site-chrome';
import { WHATSAPP_MESSAGES } from '@/config/site';
import { PreviewTabs } from './preview-tabs';

export const metadata: Metadata = {
  title: 'نظام إدارة المطاعم والكافيهات',
  description:
    'نقطة بيع، شاشة مطبخ، إدارة صالة وطاولات، منيو QR، طلبات أونلاين، عملاء، خزينة، تقارير وإيصالات — نظام واحد للمطاعم والكافيهات بالعربية.',
  robots: { index: true, follow: true },
};

const CAPABILITIES: [string, string][] = [
  ['نقطة البيع / الكاشير', 'شاشة سريعة بأزرار كبيرة، خصومات بصلاحية، وتحصيل نقدي بإيصال فوري.'],
  ['شاشة المطبخ', 'الطلبات بترتيب ورودها وحالتها ووقتها. بدون أي مبالغ أو تقارير.'],
  ['الكابتن / الصالة', 'فتح الطلب، الإضافة عليه، وتسليمه للعميل — بصلاحيات محدودة.'],
  ['الطاولات', 'خريطة صالة بحالات واضحة: متاحة، مشغولة، جاهزة، محجوزة.'],
  ['منيو QR', 'رابط مُعمّى لكل طاولة. الضيف يمسح ويطلب من جواله دون تطبيق.'],
  ['الطلبات أونلاين', 'استلام أو توصيل، سلة، حساب عميل، وعناوين محفوظة.'],
  ['العملاء', 'سجل العميل وطلباته وعناوينه — معزول لكل مطعم على حدة.'],
  ['الخزينة', 'قيود غير قابلة للتعديل أو الحذف، والرصيد محسوب من الحركات.'],
  ['التقارير', 'مبيعات بالفترة والفرع، الأصناف الأكثر طلبًا، وحركة الخزينة.'],
  ['الإيصالات', 'إيصال عميل واضح وقابل للطباعة على طابعة حرارية.'],
  ['التنبيهات', 'إشعار عند طلب جديد أو طلب جاهز، لكل دور بحسب صلاحيته.'],
  ['موقع المطعم', 'صفحة عامة للمطعم متصلة بالمنيو ومحرك الطلبات نفسه.'],
];

export default function RestaurantServicePage() {
  return (
    <>
      <section className="border-b border-line bg-surface">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
          <p className="text-sm font-bold text-primary">خدمة Local Basic</p>
          <h1 className="mt-3 max-w-3xl text-3xl font-extrabold leading-[1.25] text-fg sm:text-4xl">
            نظام إدارة المطاعم والكافيهات
          </h1>
          <p className="mt-4 max-w-2xl text-base leading-relaxed text-muted sm:text-lg">
            نظام تشغيل متكامل يغطي دورة المطعم كاملة: من لحظة دخول الضيف، مرورًا بالطلب
            والمطبخ والتحصيل، وحتى الإيصال والتقرير وحركة الخزينة.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <WhatsAppCta message={WHATSAPP_MESSAGES.restaurant}>اطلب عرضًا توضيحيًا</WhatsAppCta>
            <Link
              href="/contact"
              className="inline-flex h-12 items-center justify-center rounded border border-line bg-elevated px-6 text-base font-semibold text-fg transition-colors hover:bg-surface"
            >
              تواصل معنا
            </Link>
          </div>
        </div>
      </section>

      <Section>
        <SectionHeading eyebrow="المكوّنات" title="ماذا يشمل النظام" />
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {CAPABILITIES.map(([t, d]) => (
            <FeatureCard key={t} title={t}>{d}</FeatureCard>
          ))}
        </div>
      </Section>

      <Section tone="surface">
        <SectionHeading
          eyebrow="جولة سريعة"
          title="شاشة لكل دور"
          lead="اختر دورًا لترى ما يراه صاحبه بالضبط — ولا يرى غيره."
        />
        <div className="mt-10">
          <PreviewTabs />
        </div>
      </Section>

      <Section>
        <SectionHeading eyebrow="دورة الطلب" title="كيف يسير الطلب داخل النظام" />
        <ol className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Step n={1} title="الطلب">من الكاشير أو الكابتن أو QR أو أونلاين — نفس المحرك.</Step>
          <Step n={2} title="المطبخ">يظهر فورًا على الشاشة بحالته ووقته.</Step>
          <Step n={3} title="التقديم">الكابتن يسلّم الطلب ويغيّر حالته.</Step>
          <Step n={4} title="التحصيل">الكاشير يحصّل، فيصدر الإيصال وتُقيَّد الخزينة.</Step>
        </ol>
      </Section>

      <Section tone="surface">
        <SectionHeading eyebrow="الأمان" title="بُني آمنًا من الأساس" />
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <FeatureCard title="عزل كامل للبيانات">بيانات كل مطعم معزولة على مستوى قاعدة البيانات نفسها.</FeatureCard>
          <FeatureCard title="صلاحيات دقيقة">لكل دور صلاحياته، ولكل فرع نطاقه.</FeatureCard>
          <FeatureCard title="قيود مالية ثابتة">المدفوعات وحركة الخزينة لا تُعدَّل ولا تُحذف.</FeatureCard>
          <FeatureCard title="حساب الأسعار على الخادم">لا يُقبل أي سعر أو إجمالي قادم من المتصفح.</FeatureCard>
        </div>
      </Section>

      <Section>
        <div className="rounded-lg border border-line bg-primary px-6 py-14 text-center text-primary-fg">
          <h2 className="text-2xl font-extrabold sm:text-3xl">نبدأ بمكالمة قصيرة</h2>
          <p className="mx-auto mt-3 max-w-xl text-base leading-relaxed text-primary-fg/85">
            راسلنا على واتساب، نفهم احتياج مطعمك، ونعرض النظام عمليًا. بعدها نتفق ونجهّز مساحتك.
          </p>
          <div className="mt-7 flex justify-center">
            <WhatsAppCta message={WHATSAPP_MESSAGES.restaurant}>تواصل عبر واتساب</WhatsAppCta>
          </div>
        </div>
      </Section>
    </>
  );
}
