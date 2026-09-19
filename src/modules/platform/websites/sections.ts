import { z } from 'zod';

/**
 * The section registry.
 *
 * A website is described by a list of sections drawn from this table and
 * nothing else. The registry is the single place that answers three questions
 * that must never disagree: what a section is called, what it may contain, and
 * how the editor should describe it to an operator.
 *
 * The closed list is the security property, not a convenience. A definition
 * carrying an unknown type is refused — here, and again by the database, which
 * holds the same list in app.site_section_types(). Adding a section means
 * adding it in both places and giving the renderer a case for it, which is the
 * point: no section can reach a page without someone having drawn it.
 *
 * Nothing in a section is markup. Every string is plain text, every image is an
 * https URL, and every destination is a page of this same site. There is no
 * `html` prop anywhere and there must never be one.
 */

/**
 * Plain text: bounded, and refused outright if it contains angle brackets.
 *
 * Not sanitisation — nothing is stripped or escaped. A value carrying markup is
 * rejected, so no renderer downstream can be talked into treating stored text
 * as HTML. Mirrors app.website_text_ok in the database.
 */
export const plainText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((v) => !/[<>]/.test(v), { message: 'لا يُسمح بوسوم HTML' });

/** https only. javascript:, data: and every other scheme are refused. */
export const httpsUrl = z
  .string()
  .trim()
  .max(500)
  .regex(/^https:\/\/[^\s<>"]+$/, 'الرابط يجب أن يبدأ بـ https://');

export const hexColor = z
  .string()
  .trim()
  .regex(/^#[0-9A-Fa-f]{6}$/, 'اللون يجب أن يكون بصيغة #1E2FC8');

/** A fixed list. Free text never reaches a stylesheet. */
export const FONTS = ['system', 'cairo', 'tajawal', 'ibm-plex-arabic'] as const;
export const fontKey = z.enum(FONTS);

/**
 * A destination inside this site. Never an absolute URL: a section whose link
 * a model could choose freely would make every generated page an open redirect.
 */
export const pageSlug = z
  .string()
  .trim()
  .regex(/^\/[a-z0-9-]*(\/[a-z0-9-]+)*$/, 'المسار غير صالح');

const link = z.object({ label: plainText(60), target: pageSlug });

/** An item shared by the list-shaped sections. */
const item = z.object({
  title: plainText(120),
  body: plainText(600).optional(),
  image_url: httpsUrl.optional(),
  icon: plainText(40).optional(),
});

/**
 * Props per section type.
 *
 * `.strict()` everywhere: an unknown key is an error rather than something
 * quietly carried into a snapshot for a future renderer to discover.
 */
export const SECTION_PROPS = {
  hero: z
    .object({
      title: plainText(160),
      subtitle: plainText(300).optional(),
      image_url: httpsUrl.optional(),
      cta: link.optional(),
    })
    .strict(),

  about: z
    .object({
      title: plainText(120),
      body: plainText(4000),
      image_url: httpsUrl.optional(),
    })
    .strict(),

  services: z
    .object({
      title: plainText(120),
      subtitle: plainText(300).optional(),
      items: z.array(item).max(24),
    })
    .strict(),

  products: z
    .object({
      title: plainText(120),
      subtitle: plainText(300).optional(),
      items: z.array(item).max(24),
      show_prices: z.boolean().optional(),
    })
    .strict(),

  menu: z
    .object({
      title: plainText(120),
      subtitle: plainText(300).optional(),
      show_prices: z.boolean().optional(),
    })
    .strict(),

  gallery: z
    .object({
      title: plainText(120).optional(),
      images: z.array(httpsUrl).max(24),
    })
    .strict(),

  testimonials: z
    .object({
      title: plainText(120),
      items: z
        .array(z.object({ quote: plainText(600), author: plainText(80) }))
        .max(12),
    })
    .strict(),

  features: z
    .object({
      title: plainText(120),
      subtitle: plainText(300).optional(),
      items: z.array(item).max(12),
    })
    .strict(),

  contact: z
    .object({
      title: plainText(120),
      subtitle: plainText(300).optional(),
      show_phone: z.boolean().optional(),
      show_email: z.boolean().optional(),
      show_whatsapp: z.boolean().optional(),
    })
    .strict(),

  location: z
    .object({
      title: plainText(120),
      address: plainText(300).optional(),
      /** Coordinates, not an embed URL: nothing third-party is framed. */
      latitude: z.number().min(-90).max(90).optional(),
      longitude: z.number().min(-180).max(180).optional(),
    })
    .strict(),

  opening_hours: z.object({ title: plainText(120) }).strict(),

  call_to_action: z
    .object({
      title: plainText(160),
      subtitle: plainText(300).optional(),
      cta: link,
    })
    .strict(),

  footer: z
    .object({
      note: plainText(300).optional(),
      links: z.array(link).max(8).optional(),
    })
    .strict(),
} as const;

export type SectionType = keyof typeof SECTION_PROPS;

/** The closed list, in the order the editor offers them. */
export const SECTION_TYPES = Object.keys(SECTION_PROPS) as SectionType[];

export function isSectionType(value: unknown): value is SectionType {
  return typeof value === 'string' && value in SECTION_PROPS;
}

/** What the editor calls each section, and what it is for. */
export const SECTION_LABELS: Record<SectionType, { label: string; hint: string }> = {
  hero: { label: 'الواجهة', hint: 'أول ما يراه الزائر: العنوان والصورة الكبيرة.' },
  about: { label: 'نبذة', hint: 'تعريف بالنشاط.' },
  services: { label: 'الخدمات', hint: 'قائمة بما يقدّمه النشاط.' },
  products: { label: 'المنتجات', hint: 'عرض منتجات مختارة.' },
  menu: { label: 'المنيو', hint: 'يعرض المنيو الحقيقي من النظام، لا نسخة منه.' },
  gallery: { label: 'معرض الصور', hint: 'صور من المكان أو المنتجات.' },
  testimonials: { label: 'آراء العملاء', hint: 'اقتباسات منسوبة لأصحابها.' },
  features: { label: 'المميزات', hint: 'نقاط قصيرة تميّز النشاط.' },
  contact: { label: 'تواصل', hint: 'وسائل الاتصال المسجّلة في النظام.' },
  location: { label: 'الموقع', hint: 'العنوان وإحداثيات الخريطة.' },
  opening_hours: { label: 'مواعيد العمل', hint: 'يعرض المواعيد الحقيقية من النظام.' },
  call_to_action: { label: 'دعوة لإجراء', hint: 'زر يقود الزائر إلى صفحة أخرى.' },
  footer: { label: 'التذييل', hint: 'أسفل الصفحة.' },
};

/**
 * A section, validated against its own type's props.
 *
 * A discriminated union rather than `type: string, props: unknown`, so the
 * props of a `hero` can never be read as the props of a `menu`, and an unknown
 * type fails at the union rather than somewhere deeper.
 */
export const sectionSchema = z.discriminatedUnion(
  'type',
  SECTION_TYPES.map((type) =>
    z.object({ type: z.literal(type), props: SECTION_PROPS[type] }).strict(),
  ) as unknown as [
    z.ZodObject<{ type: z.ZodLiteral<SectionType>; props: z.ZodTypeAny }>,
    ...z.ZodObject<{ type: z.ZodLiteral<SectionType>; props: z.ZodTypeAny }>[],
  ],
);

export type Section = z.infer<typeof sectionSchema>;
