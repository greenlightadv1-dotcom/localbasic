import type { Metadata } from 'next';
import { LegalPage, LegalSection } from '@/components/patterns/legal-page';
import { CONTACT_EMAIL } from '@/config/site';

export const metadata: Metadata = {
  title: 'الشروط والأحكام',
  description: 'شروط استخدام منصة Local Basic.',
  robots: { index: true, follow: true },
};

export default function TermsPage() {
  return (
    <LegalPage title="الشروط والأحكام" updated="سبتمبر ٢٠٢٦">
      <LegalSection title="قبول الشروط">
        <p>
          باستخدام منصة Local Basic تقرّ بموافقتك على هذه الشروط. إذا كنت تستخدم المنصة نيابة
          عن منشأة، فأنت تقرّ بأنك مخوّل بذلك.
        </p>
      </LegalSection>

      <LegalSection title="الحساب والمسؤولية">
        <p>
          المشترك مسؤول عن سرية بيانات الدخول وعن تصرفات المستخدمين الذين يمنحهم صلاحيات داخل
          مساحة عمله.
        </p>
      </LegalSection>

      <LegalSection title="الاشتراك والدفع">
        <p>
          يتم الاتفاق على قيمة الاشتراك وطريقة سداده مباشرة مع فريق المبيعات. لا تتم حاليًا أي
          عملية دفع إلكتروني عبر الموقع.
        </p>
      </LegalSection>

      <LegalSection title="حدود الخدمة">
        <p>
          نبذل جهدًا معقولًا لإتاحة الخدمة واستمراريتها، دون ضمان عدم الانقطاع. ولا نتحمل
          مسؤولية الأضرار غير المباشرة الناتجة عن الاستخدام.
        </p>
      </LegalSection>

      <LegalSection title="المستندات المالية">
        <p>
          المستندات التي تصدرها المنصة للعميل النهائي هي <strong className="text-fg">إيصالات</strong>،
          ولا تُمثّل فاتورة ضريبية ولا تدّعي أي اعتماد من أي جهة ضريبية.
        </p>
      </LegalSection>

      <LegalSection title="إنهاء الخدمة">
        <p>
          يجوز لأي من الطرفين إنهاء الاشتراك وفق ما يتم الاتفاق عليه. وعند الإنهاء يمكن للمشترك
          طلب نسخة من بياناته خلال مدة معقولة.
        </p>
      </LegalSection>

      <LegalSection title="التواصل">
        <p>
          للاستفسارات: <a className="text-primary hover:underline" href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
        </p>
      </LegalSection>
    </LegalPage>
  );
}
