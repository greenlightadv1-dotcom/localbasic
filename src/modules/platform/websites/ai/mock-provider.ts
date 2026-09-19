import { SITE_DEFINITION_VERSION } from '../definition';
import { resolveTheme } from '../theme';
import type {
  GenerateSiteInput,
  ProviderResult,
  ReviseSiteInput,
  WebsiteAIProvider,
} from './provider';

/**
 * A provider that calls nothing.
 *
 * It builds a plausible starting site from the customer's own data, which
 * makes it useful twice over: an operator can create a real draft today
 * without any AI being wired up, and every test of the service boundary runs
 * deterministically and offline.
 *
 * It returns `raw: unknown` like any other provider, and WebsiteAIService
 * validates it like any other provider's. No provider is trusted, including
 * the one we wrote.
 */
export class MockWebsiteAIProvider implements WebsiteAIProvider {
  readonly name = 'mock';

  async generateSite(input: GenerateSiteInput): Promise<ProviderResult> {
    const { business, brief, locale } = input;
    const name = business.branding.displayName ?? business.organizationName;
    const theme = resolveTheme(input.theme, business.branding);

    const sections: unknown[] = [
      {
        type: 'hero',
        props: {
          title: name,
          subtitle: brief.notes.slice(0, 280) || `${name} — ${business.organizationSlug}`,
          cta: { label: 'تواصل معنا', target: '/contact' },
        },
      },
      {
        type: 'about',
        props: {
          title: 'نبذة',
          body: brief.audience ? `نخدم ${brief.audience}.` : `تعرّف على ${name}.`,
        },
      },
    ];

    // The vertical decides what the home page leads with, using the section
    // that reads the customer's real data rather than a copy of it.
    if (input.siteType === 'restaurant') {
      sections.push({ type: 'menu', props: { title: 'المنيو', show_prices: true } });
    } else if (input.siteType === 'retail') {
      sections.push({ type: 'products', props: { title: 'منتجاتنا', items: [] } });
    } else {
      sections.push({ type: 'services', props: { title: 'خدماتنا', items: [] } });
    }

    if (business.openingHours) {
      sections.push({ type: 'opening_hours', props: { title: 'مواعيد العمل' } });
    }

    return {
      provider: this.name,
      raw: {
        version: SITE_DEFINITION_VERSION,
        metadata: {
          name,
          locale,
          direction: locale === 'ar' ? 'rtl' : 'ltr',
          ...(business.branding.logoUrl ? { logo_url: business.branding.logoUrl } : {}),
        },
        theme,
        navigation: [
          { label: 'الرئيسية', target: '/' },
          { label: 'تواصل', target: '/contact' },
        ],
        pages: [
          { slug: '/', title: 'الرئيسية', sections },
          {
            slug: '/contact',
            title: 'تواصل',
            sections: [
              {
                type: 'contact',
                props: {
                  title: 'تواصل معنا',
                  show_phone: Boolean(business.contact.phone),
                  show_email: Boolean(business.contact.email),
                  show_whatsapp: Boolean(business.contact.whatsapp),
                },
              },
            ],
          },
        ],
        settings: { show_branding: true, analytics_enabled: false },
      },
    };
  }

  /**
   * Revision without a model is the identity. Returning the document unchanged
   * is honest — it is exactly what "no AI configured" should do — and it keeps
   * the service's validation path exercised either way.
   */
  async reviseSite(input: ReviseSiteInput): Promise<ProviderResult> {
    return { provider: this.name, raw: input.current };
  }
}
