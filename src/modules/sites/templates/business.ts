import type { SiteTemplate } from './types';

/**
 * "Business" — the first template.
 *
 * A single-page brochure in the shape most small businesses actually want:
 * who you are, what you do, what customers say, how to reach you. The default
 * content is real Arabic copy rather than lorem ipsum, so a site created from
 * it looks finished before anyone has typed anything — and so an owner editing
 * it can see what each field does by reading what is already there.
 */
export const businessTemplate: SiteTemplate = {
  id: 'business',
  nameAr: 'أعمال',
  nameEn: 'Business',
  description: 'صفحة تعريفية للنشاط التجاري: من نحن، الخدمات، آراء العملاء، وبيانات التواصل.',

  theme: {
    primary: '#1e2fc8',
    background: '#ffffff',
    foreground: '#111827',
    border: '#e5e7eb',
  },

  sections: [
    {
      type: 'hero',
      content: {
        title: 'اسم نشاطك هنا',
        subtitle: 'جملة قصيرة تشرح ما تقدّمه ولمن. اجعلها واضحة أكثر من كونها جذابة.',
        ctaLabel: 'تواصل معنا',
        ctaHref: '/contact',
        align: 'center',
      },
    },
    {
      type: 'about',
      content: {
        title: 'من نحن',
        body:
          'اكتب هنا نبذة عن النشاط: متى بدأ، ما الذي يميّزه، ومن يخدم. ' +
          'فقرة واحدة صادقة أفضل من ثلاث فقرات عامة.',
      },
    },
    {
      type: 'services',
      content: {
        title: 'خدماتنا',
        items: [
          { name: 'الخدمة الأولى', description: 'وصف موجز لما تشمله هذه الخدمة.' },
          { name: 'الخدمة الثانية', description: 'وصف موجز لما تشمله هذه الخدمة.' },
          { name: 'الخدمة الثالثة', description: 'وصف موجز لما تشمله هذه الخدمة.' },
        ],
      },
    },
    {
      type: 'testimonials',
      content: {
        title: 'آراء العملاء',
        items: [
          { quote: 'خدمة ممتازة وتعامل محترف. أنصح بهم بشدة.', author: 'عميل' },
        ],
      },
    },
    {
      type: 'contact',
      content: {
        title: 'تواصل معنا',
        phone: '',
        email: '',
        address: '',
      },
    },
    {
      type: 'footer',
      content: { text: 'جميع الحقوق محفوظة.' },
    },
  ],
};
