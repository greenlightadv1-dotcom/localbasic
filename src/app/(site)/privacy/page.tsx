import type { Metadata } from 'next';
import { LegalPage, LegalSection } from '@/components/patterns/legal-page';
import { CONTACT_EMAIL } from '@/config/site';

export const metadata: Metadata = {
  title: 'سياسة الخصوصية',
  description: 'كيف تتعامل Local Basic مع البيانات.',
  robots: { index: true, follow: true },
};

export default function PrivacyPage() {
  return (
    <LegalPage title="سياسة الخصوصية" updated="سبتمبر ٢٠٢٦">
      <LegalSection title="نطاق هذه السياسة">
        <p>
          توضح هذه السياسة كيف نتعامل مع البيانات في منصة Local Basic، سواء بيانات المنشأة
          المشتركة أو بيانات عملائها الذين يستخدمون المنيو أو الطلب أونلاين.
        </p>
      </LegalSection>

      <LegalSection title="البيانات التي نجمعها">
        <p>بيانات الحساب: الاسم، البريد الإلكتروني، ورقم الهاتف عند تقديمه.</p>
        <p>بيانات التشغيل: الطلبات، الأصناف، المدفوعات، وحركة الخزينة الخاصة بالمنشأة.</p>
        <p>
          بيانات عملاء المنشأة: الاسم ورقم الهاتف والعنوان عند الطلب أونلاين، وتُعامل باعتبارها
          بيانات تخص المنشأة.
        </p>
      </LegalSection>

      <LegalSection title="عزل البيانات">
        <p>
          بيانات كل منشأة معزولة عن غيرها على مستوى قاعدة البيانات، ولا يمكن لمستخدم في منشأة
          الوصول إلى بيانات منشأة أخرى.
        </p>
      </LegalSection>

      <LegalSection title="استخدام البيانات">
        <p>
          نستخدم البيانات لتشغيل الخدمة وتأمينها ودعم المشتركين فقط. لا نبيع البيانات ولا
          نؤجّرها لأطراف ثالثة لأغراض تسويقية.
        </p>
      </LegalSection>

      <LegalSection title="الاحتفاظ بالبيانات">
        <p>
          نحتفظ ببيانات التشغيل طوال مدة الاشتراك. السجلات المالية مقيّدة ولا تُعدَّل ولا تُحذف،
          حفاظًا على سلامة الدفاتر.
        </p>
      </LegalSection>

      <LegalSection title="حقوق المنشأة والعميل">
        <p>
          يمكن لمالك المنشأة طلب تصدير بياناته أو إغلاق حسابه. ويمكن لعميل المنشأة طلب تصحيح
          بياناته أو حذفها عبر المنشأة نفسها.
        </p>
      </LegalSection>

      <LegalSection title="التواصل">
        <p>
          لأي استفسار يخص الخصوصية: <a className="text-primary hover:underline" href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
        </p>
      </LegalSection>
    </LegalPage>
  );
}
