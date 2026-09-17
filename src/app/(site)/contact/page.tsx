import type { Metadata } from 'next';
import { Section, SectionHeading } from '@/components/patterns/site-sections';
import { WhatsAppCta } from '@/components/patterns/site-chrome';
import { CONTACT_EMAIL, WHATSAPP_DISPLAY, WHATSAPP_MESSAGES } from '@/config/site';

export const metadata: Metadata = {
  title: 'تواصل معنا',
  description: 'تواصل مع فريق Local Basic عبر واتساب أو البريد الإلكتروني.',
  robots: { index: true, follow: true },
};

export default function ContactPage() {
  return (
    <Section>
      <SectionHeading
        eyebrow="تواصل معنا"
        title="نحن على واتساب"
        lead="أسرع طريقة للوصول إلينا. اكتب لنا نوع نشاطك وحجمه وسنرد عليك بعرض مناسب."
      />

      <div className="mx-auto mt-10 grid max-w-3xl gap-4 sm:grid-cols-2">
        <div className="rounded-lg border border-line bg-elevated p-6">
          <h2 className="font-bold text-fg">واتساب</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            للمبيعات والعروض التوضيحية والدعم.
          </p>
          {/* The number itself, because a contact page that only offers a
              button is useless to someone who wants to save it or call. */}
          <p className="lb-numeric mt-3 text-sm font-semibold text-fg" dir="ltr">
            {WHATSAPP_DISPLAY}
          </p>
          <div className="mt-4">
            <WhatsAppCta className="h-11 w-full px-5 text-sm" message={WHATSAPP_MESSAGES.general} />
          </div>
        </div>

        <div className="rounded-lg border border-line bg-elevated p-6">
          <h2 className="font-bold text-fg">البريد الإلكتروني</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            للاستفسارات الرسمية والتعاقدات.
          </p>
          <div className="mt-5">
            <a
              href={`mailto:${CONTACT_EMAIL}`}
              className="inline-flex h-11 w-full items-center justify-center rounded border border-line bg-surface px-5 text-sm font-semibold text-fg transition-colors hover:bg-primary-soft"
            >
              {CONTACT_EMAIL}
            </a>
          </div>
        </div>
      </div>

      <p className="mx-auto mt-8 max-w-3xl text-center text-sm text-muted">
        ساعات العمل: السبت — الخميس، ١٠ صباحًا حتى ٦ مساءً بتوقيت القاهرة.
      </p>
    </Section>
  );
}
