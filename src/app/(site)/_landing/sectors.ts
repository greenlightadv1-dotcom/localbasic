import type { LucideIcon } from 'lucide-react';
import {
  Barcode, Bike, CalendarClock, ChefHat, ClipboardList, Coffee, FileHeart, LayoutGrid, MessageCircle,
  Pill, QrCode, Repeat, Scale, ScanLine, ShoppingBasket, SlidersHorizontal, Stethoscope, Store, Truck,
  UtensilsCrossed, Wallet,
} from 'lucide-react';
import { WHATSAPP_MESSAGES } from '@/config/site';

/**
 * The three sectors the landing page sells. Marketing copy only — nothing
 * here reads tenant data. Each sector carries its own accent so a visitor
 * can tell at a glance which world they are looking at; the accent sits on
 * top of the brand tokens (primary stays the brand), never instead of them.
 */
export type SectorKey = 'restaurant' | 'retail' | 'clinic';

export type Sector = {
  key: SectorKey;
  label: string;
  short: string;
  icon: LucideIcon;
  tagline: string;
  lead: string;
  features: { icon: LucideIcon; title: string; body: string }[];
  /** A day in the business, start to finish, in four beats. */
  flow: string[];
  stats: [string, string][];
  whatsapp: string;
  cta: string;
  detailsHref?: string;
  accent: {
    /** Selected tab / solid chip. */
    solid: string;
    /** Soft badge and icon tile. */
    soft: string;
    /** Thin top border on the panel. */
    edge: string;
    /** Background wash behind the panel. */
    wash: string;
    dot: string;
  };
};

export const SECTORS: Sector[] = [
  {
    key: 'restaurant',
    label: 'المطاعم والكافيهات',
    short: 'مطاعم',
    icon: UtensilsCrossed,
    tagline: 'من الطاولة للمطبخ للخزينة — بدون ورق',
    lead: 'الطلب يُسجَّل مرة واحدة ويظهر في المطبخ لحظيًا، والطاولة تعرف حالتها، والحساب يتقسّم في ثوانٍ.',
    features: [
      { icon: LayoutGrid, title: 'الصالة والطاولات', body: 'خريطة لحظية: متاحة، مشغولة، محجوزة، تطلب الحساب — مع نقل ودمج وتقسيم الفاتورة.' },
      { icon: ChefHat, title: 'شاشة المطبخ والبار', body: 'كل محطة تجهّز أصنافها، بعدّاد وتنبيه صوتي للطلب الجديد والمتأخر.' },
      { icon: SlidersHorizontal, title: 'الإضافات والتعديلات', body: 'جبنة زيادة، بدون بصل، الصوص جانبًا — بحد أدنى وأقصى وسعر لكل اختيار.' },
      { icon: Bike, title: 'الدليفري والكول سنتر', body: 'استلام الطلب بالتليفون، توزيع على المناديب، وتسوية عهدة كل مندوب.' },
      { icon: QrCode, title: 'منيو QR وطلب أونلاين', body: 'الضيف يطلب من جواله، والطلب يدخل نفس المطبخ ونفس الخزينة.' },
      { icon: Coffee, title: 'الوصفات وتكلفة الصنف', body: 'خصم الخامات تلقائيًا مع كل طلب، وهامش ربح كل صنف قدامك.' },
    ],
    flow: ['الكابتن يفتح طلب الطاولة', 'المطبخ والبار يجهّزان كلٌّ أصنافه', 'التقديم وطلب الحساب', 'تحصيل وتقسيم الفاتورة'],
    stats: [['٤', 'أنواع تقسيم للفاتورة'], ['لحظي', 'من الطلب للمطبخ'], ['٠', 'مبالغ على شاشة المطبخ']],
    whatsapp: WHATSAPP_MESSAGES.restaurant,
    cta: 'اطلب عرضًا لمطعمك',
    detailsHref: '/services/restaurant',
    accent: {
      solid: 'bg-orange-600 text-white',
      soft: 'bg-orange-500/10 text-orange-700 dark:text-orange-300',
      edge: 'border-t-orange-500',
      wash: 'from-orange-500/10',
      dot: 'bg-orange-500',
    },
  },
  {
    key: 'retail',
    label: 'المتاجر والتجزئة',
    short: 'تجزئة',
    icon: Store,
    tagline: 'كاشير سريع ومخزون مضبوط في كل فرع',
    lead: 'امسح الباركود أو زِن على الميزان، والعروض تتطبق لوحدها، والمخزون ينقص من الفرع الصح ويطلب نفسه لما يقرب يخلص.',
    features: [
      { icon: ScanLine, title: 'نقطة بيع بالباركود', body: 'مسح سريع، بحث بالاسم، وأكثر من طريقة دفع في نفس الفاتورة.' },
      { icon: Scale, title: 'الميزان والأصناف الموزونة', body: 'باركود الميزان يُقرأ بالوزن والسعر مباشرة — خضار، لحوم، مكسرات.' },
      { icon: Repeat, title: 'المرتجع والاستبدال', body: 'من رقم الفاتورة، برصيد للعميل أو استرداد نقدي بموافقة المدير.' },
      { icon: Truck, title: 'التحويل بين الفروع', body: 'طلب ← موافقة ← شحن ← استلام، والعجز في الاستلام يتسجّل تلقائيًا.' },
      { icon: ShoppingBasket, title: 'إعادة الطلب التلقائية', body: 'اقتراحات شراء من حد الطلب ومعدل البيع، وأمر شراء للمورد بضغطة.' },
      { icon: Barcode, title: 'العروض والولاء', body: 'اشتري ٢ والتالت هدية، كود خصم للمواسم، ورصيد ونقاط للعميل.' },
    ],
    flow: ['الكاشير يمسح الباركود ويطبّق العروض', 'المخزون ينقص من الفرع لحظيًا', 'تحويل بضاعة من فرع لفرع', 'اقتراح إعادة الطلب للمورد'],
    stats: [['ثانية', 'لكل صنف على الكاشير'], ['٤', 'مراحل لتحويل البضاعة'], ['تلقائي', 'اقتراح إعادة الطلب']],
    whatsapp: WHATSAPP_MESSAGES.retail,
    cta: 'اطلب عرضًا لمتجرك',
    accent: {
      solid: 'bg-emerald-600 text-white',
      soft: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
      edge: 'border-t-emerald-500',
      wash: 'from-emerald-500/10',
      dot: 'bg-emerald-500',
    },
  },
  {
    key: 'clinic',
    label: 'العيادات الطبية',
    short: 'عيادات',
    icon: Stethoscope,
    tagline: 'مواعيد منظمة وملف مريض كامل وروشتة على واتساب',
    lead: 'الاستقبال يحجز في المواعيد المتاحة فعلًا حسب ورديات كل طبيب، والطبيب يكتب الكشف والروشتة، والمريض يستلمها على موبايله.',
    features: [
      { icon: CalendarClock, title: 'المواعيد والورديات', body: 'جدول يومي وأسبوعي لكل طبيب، ومنع الحجز المزدوج أو خارج الوردية.' },
      { icon: ClipboardList, title: 'قائمة الانتظار', body: 'وصل، في الانتظار، داخل الكشف — الاستقبال والطبيب يشوفوا نفس القائمة.' },
      { icon: FileHeart, title: 'ملف المريض الطبي', body: 'التاريخ المرضي والحساسية والعلامات الحيوية والمرفقات، بسجل لا يُمسح.' },
      { icon: Pill, title: 'الروشتة الإلكترونية', body: 'أدوية بالجرعة والمدة، وطباعة بهوية العيادة.' },
      { icon: MessageCircle, title: 'إرسال الروشتة على واتساب', body: 'رابط آمن بصلاحية محددة يفتحه المريض من غير حساب.' },
      { icon: Wallet, title: 'فاتورة الكشف والعمولات', body: 'الكشف والإجراءات والمستهلكات في فاتورة، وعمولة كل طبيب محسوبة.' },
    ],
    flow: ['الاستقبال يحجز في موعد متاح', 'المريض يصل ويدخل قائمة الانتظار', 'الطبيب يكتب الكشف والروشتة', 'الروشتة على واتساب والفاتورة للخزينة'],
    stats: [['٠', 'حجز مزدوج لنفس الطبيب'], ['واتساب', 'للروشتة برابط آمن'], ['سجل', 'طبي لا يُحذف']],
    whatsapp: WHATSAPP_MESSAGES.clinic,
    cta: 'اطلب عرضًا لعيادتك',
    accent: {
      solid: 'bg-sky-600 text-white',
      soft: 'bg-sky-500/10 text-sky-700 dark:text-sky-300',
      edge: 'border-t-sky-500',
      wash: 'from-sky-500/10',
      dot: 'bg-sky-500',
    },
  },
];

export const SECTOR_BY_KEY = Object.fromEntries(SECTORS.map((s) => [s.key, s])) as Record<SectorKey, Sector>;

export function isSectorKey(v: string | null | undefined): v is SectorKey {
  return v === 'restaurant' || v === 'retail' || v === 'clinic';
}
