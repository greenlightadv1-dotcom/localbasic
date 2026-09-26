/**
 * The builder's vocabulary, shared between the server service and the client
 * forms.
 *
 * Separate from builder.ts because that module is `server-only`: importing a
 * section label from it would drag the Supabase server client into the browser
 * bundle and fail the build.
 */

export const SECTION_TYPES = [
  'hero', 'about', 'menu', 'gallery', 'contact', 'hours', 'branches', 'cta',
] as const;
export type SectionType = (typeof SECTION_TYPES)[number];

export const SECTION_LABELS: Record<SectionType, string> = {
  hero: 'الواجهة',
  about: 'من نحن',
  menu: 'المنيو',
  gallery: 'معرض الصور',
  contact: 'تواصل معنا',
  hours: 'مواعيد العمل',
  branches: 'الفروع',
  cta: 'دعوة للطلب',
};

export const SECTION_HINTS: Record<SectionType, string> = {
  hero: 'أول ما يراه الزائر: عنوان وصورة وزر الطلب.',
  about: 'نبذة عن المطعم.',
  menu: 'المنيو الحقيقي من نظامك — الأسعار والتوافر تأتي من المنيو نفسه.',
  gallery: 'صور من المطعم، بروابط https فقط.',
  contact: 'أرقام التواصل من إعدادات الهوية.',
  hours: 'مواعيد العمل من إعدادات الموقع.',
  branches: 'فروعك النشطة فقط.',
  cta: 'شريط يدعو الزائر للطلب أو لتصفّح المنيو.',
};

/** Sections that carry authoritative data and make no sense twice on a page. */
export const SINGLETON_SECTIONS: SectionType[] = [
  'hero', 'about', 'menu', 'hours', 'branches', 'contact',
];

export const THEME_FONTS = ['system', 'cairo', 'tajawal', 'ibm-plex-arabic'] as const;
export type ThemeFont = (typeof THEME_FONTS)[number];

export const THEME_FONT_LABELS: Record<ThemeFont, string> = {
  system: 'الخط الافتراضي',
  cairo: 'Cairo',
  tajawal: 'Tajawal',
  'ibm-plex-arabic': 'IBM Plex Arabic',
};

export const THEME_BACKGROUNDS = ['light', 'dark', 'warm', 'lavechi'] as const;
export type ThemeBackground = (typeof THEME_BACKGROUNDS)[number];
export const THEME_BACKGROUND_LABELS: Record<ThemeBackground, string> = {
  light: 'فاتح',
  dark: 'داكن',
  warm: 'دافئ',
  // A complete, fixed identity (deep green + gold, Reem Kufi/Cairo) rather
  // than a tint of the organization's own colors, unlike the other three —
  // see src/modules/restaurant/website/lavechi-theme.ts.
  lavechi: 'لافيتشي',
};

export const BUTTON_STYLES = ['rounded', 'square', 'pill'] as const;
export type ButtonStyle = (typeof BUTTON_STYLES)[number];
export const BUTTON_STYLE_LABELS: Record<ButtonStyle, string> = {
  rounded: 'حواف خفيفة',
  square: 'حواف حادة',
  pill: 'دائري',
};

export const CONTAINER_WIDTHS = ['normal', 'wide'] as const;
export type ContainerWidth = (typeof CONTAINER_WIDTHS)[number];
export const CONTAINER_WIDTH_LABELS: Record<ContainerWidth, string> = {
  normal: 'عادي',
  wide: 'عريض',
};

export const CTA_TARGETS = ['order', 'menu', 'contact', 'branches'] as const;
export type CtaTarget = (typeof CTA_TARGETS)[number];
export const CTA_TARGET_LABELS: Record<CtaTarget, string> = {
  order: 'صفحة الطلب',
  menu: 'المنيو',
  contact: 'تواصل معنا',
  branches: 'الفروع',
};

export type Theme = {
  primaryColor: string | null;
  accentColor: string | null;
  background: ThemeBackground;
  font: ThemeFont;
  buttonStyle: ButtonStyle;
  width: ContainerWidth;
};

export const DEFAULT_THEME: Theme = {
  primaryColor: null,
  accentColor: null,
  // The platform default, per the unified-storefront brief: every restaurant
  // that has never customized its theme gets the Lavechi identity out of the
  // box. An organization that opens the builder and picks a different preset
  // overrides this the same way it always could.
  background: 'lavechi',
  font: 'system',
  // 12–15px, not the 'pill' preset's full 9999px — brandStyle() overrides
  // --lb-btn-radius to the Lavechi spec's 13px regardless of this value
  // whenever background is 'lavechi', so this only matters if a restaurant
  // switches to a different preset later.
  buttonStyle: 'rounded',
  width: 'normal',
};

/** A section's content, as the renderer receives it. */
export type SectionConfig = {
  title?: string;
  subtitle?: string;
  body?: string;
  imageUrl?: string;
  images?: string[];
  buttonLabel?: string;
  buttonTarget?: CtaTarget;
  showPrices?: boolean;
  showPhone?: boolean;
  showWhatsapp?: boolean;
  showEmail?: boolean;
  showAddresses?: boolean;
  showOrderButton?: boolean;
};

export type WebsiteSection = {
  id: string;
  type: SectionType;
  sortOrder: number;
  enabled: boolean;
  config: SectionConfig;
};

/** The layout the public site renders: a published revision, or nothing. */
export type PublishedLayout = {
  version: number;
  publishedAt: string;
  theme: Theme;
  sections: { type: SectionType; config: SectionConfig }[];
};

/**
 * The default layout, used by any restaurant that has never published one.
 *
 * This is the D2 page expressed as sections, so an existing restaurant that
 * never opens the builder renders exactly what it rendered before.
 */
export const DEFAULT_SECTIONS: { type: SectionType; config: SectionConfig }[] = [
  { type: 'hero', config: { showOrderButton: true } },
  { type: 'branches', config: {} },
  { type: 'about', config: {} },
  { type: 'menu', config: { showPrices: true } },
  { type: 'contact', config: { showPhone: true, showWhatsapp: true, showEmail: true } },
  { type: 'hours', config: {} },
];

/** Maps the database's snake_case section config onto the renderer's shape. */
export function toSectionConfig(raw: unknown): SectionConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : undefined);
  const bool = (k: string) => (typeof o[k] === 'boolean' ? (o[k] as boolean) : undefined);

  return {
    title: str('title'),
    subtitle: str('subtitle'),
    body: str('body'),
    imageUrl: str('image_url'),
    images: Array.isArray(o['images'])
      ? (o['images'] as unknown[]).filter((i): i is string => typeof i === 'string')
      : undefined,
    buttonLabel: str('button_label'),
    buttonTarget: (CTA_TARGETS as readonly string[]).includes(str('button_target') ?? '')
      ? (str('button_target') as CtaTarget)
      : undefined,
    showPrices: bool('show_prices'),
    showPhone: bool('show_phone'),
    showWhatsapp: bool('show_whatsapp'),
    showEmail: bool('show_email'),
    showAddresses: bool('show_addresses'),
    showOrderButton: bool('show_order_button'),
  };
}

/** Maps a stored theme object onto the renderer's shape, with defaults. */
export function toTheme(raw: unknown): Theme {
  const o = (raw ?? {}) as Record<string, unknown>;
  const pick = <T extends string>(k: string, allowed: readonly T[], fallback: T): T =>
    typeof o[k] === 'string' && (allowed as readonly string[]).includes(o[k] as string)
      ? (o[k] as T)
      : fallback;
  const hex = (k: string) =>
    typeof o[k] === 'string' && /^#[0-9A-Fa-f]{6}$/.test(o[k] as string)
      ? (o[k] as string)
      : null;

  return {
    primaryColor: hex('primary_color'),
    accentColor: hex('accent_color'),
    background: pick('background', THEME_BACKGROUNDS, 'light'),
    font: pick('font', THEME_FONTS, 'system'),
    buttonStyle: pick('button_style', BUTTON_STYLES, 'rounded'),
    width: pick('width', CONTAINER_WIDTHS, 'normal'),
  };
}
