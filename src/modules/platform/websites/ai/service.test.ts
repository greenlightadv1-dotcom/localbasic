import { describe, expect, it } from 'vitest';
import { WebsiteAIService } from './service';
import { MockWebsiteAIProvider } from './mock-provider';
import type { GenerateSiteInput, ProviderResult, WebsiteAIProvider } from './provider';

const BUSINESS = {
  organizationName: 'مطعم لافيشي',
  organizationSlug: 'lavechi',
  primaryModule: 'restaurant',
  currency: 'EGP',
  branding: {
    logoUrl: null,
    displayName: null,
    primaryColor: '#1E2FC8',
    secondaryColor: '#6B8BFA',
  },
  contact: { phone: '0100', whatsapp: null, email: 'a@b.example' },
  openingHours: null,
  branchCount: 1,
};

const INPUT: GenerateSiteInput = {
  siteType: 'restaurant',
  locale: 'ar',
  business: BUSINESS,
  brief: { notes: 'موقع بسيط' },
};

/** A provider that returns whatever a test hands it. */
class Fake implements WebsiteAIProvider {
  readonly name = 'fake';
  constructor(private readonly output: unknown | (() => never)) {}
  private result(): ProviderResult {
    if (typeof this.output === 'function') (this.output as () => never)();
    return { raw: this.output, provider: this.name };
  }
  async generateSite(): Promise<ProviderResult> { return this.result(); }
  async reviseSite(): Promise<ProviderResult> { return this.result(); }
}

describe('WebsiteAIService', () => {
  it('accepts the mock provider’s output', async () => {
    const result = await new WebsiteAIService(new MockWebsiteAIProvider()).generate(INPUT);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.definition.pages.some((p) => p.slug === '/')).toBe(true);
  });

  // The whole point of the boundary: what a model returns is a candidate, not
  // a definition, and nothing downstream sees it until it has parsed.
  it('rejects a model that invents a section type', async () => {
    const bad = {
      version: 1,
      metadata: { name: 'x', locale: 'ar', direction: 'rtl' },
      theme: {
        colors: { primary: '#000000', secondary: '#000000', accent: '#000000',
                  background: '#FFFFFF', text: '#000000' },
        fonts: { heading: 'cairo', body: 'cairo' }, radius: 'medium', style: 'minimal',
      },
      navigation: [],
      pages: [{ slug: '/', title: 'x', sections: [{ type: 'remote_code', props: {} }] }],
      settings: { show_branding: true, analytics_enabled: false },
    };
    const result = await new WebsiteAIService(new Fake(bad)).generate(INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('مرفوض');
  });

  it('rejects prose, markdown fences and empty output', async () => {
    for (const bad of ['I cannot help with that', '```json\n{}\n```', null, undefined, '']) {
      const r = await new WebsiteAIService(new Fake(bad)).generate(INPUT);
      expect(r.ok, JSON.stringify(bad)).toBe(false);
    }
  });

  // Providers time out and refuse. That is a failed generation, not a crash,
  // and nothing is written either way.
  it('turns a provider throwing into a failed generation', async () => {
    const thrower = new Fake(() => { throw new Error('upstream 500'); });
    const r = await new WebsiteAIService(thrower).generate(INPUT);
    expect(r.ok).toBe(false);
    // The upstream message is not passed through to the operator.
    if (!r.ok) expect(r.error).not.toContain('upstream 500');
  });

  it('parses a provider that returns JSON as a string', async () => {
    const mock = await new MockWebsiteAIProvider().generateSite(INPUT);
    const r = await new WebsiteAIService(new Fake(JSON.stringify(mock.raw))).generate(INPUT);
    expect(r.ok).toBe(true);
  });

  it('names the provider in every result', async () => {
    expect((await new WebsiteAIService(new Fake(null)).generate(INPUT)).provider).toBe('fake');
  });
});

describe('MockWebsiteAIProvider', () => {
  it('builds the site from the customer’s own data', async () => {
    const { raw } = await new MockWebsiteAIProvider().generateSite(INPUT);
    expect(JSON.stringify(raw)).toContain('مطعم لافيشي');
  });

  it('leads a restaurant with the live menu section', async () => {
    const { raw } = await new MockWebsiteAIProvider().generateSite(INPUT);
    const types = (raw as any).pages[0].sections.map((s: any) => s.type);
    expect(types).toContain('menu');
  });

  it('leads a retail site with products instead', async () => {
    const { raw } = await new MockWebsiteAIProvider()
      .generateSite({ ...INPUT, siteType: 'retail' });
    const types = (raw as any).pages[0].sections.map((s: any) => s.type);
    expect(types).toContain('products');
    expect(types).not.toContain('menu');
  });
});
