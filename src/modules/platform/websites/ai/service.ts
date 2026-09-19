import 'server-only';
import { parseSiteDefinition, type SiteDefinition } from '../definition';
import { MockWebsiteAIProvider } from './mock-provider';
import type { GenerateSiteInput, ReviseSiteInput, WebsiteAIProvider } from './provider';

/**
 * The only door model output comes through.
 *
 * Routes and services never hold a provider. They call this, and what they get
 * back is either a SiteDefinition that passed the schema or an error — never a
 * document that merely looks right. A model that invents a section type,
 * smuggles markup into a heading or points a link at another origin produces a
 * rejection here, not a page.
 *
 * The database validates the same document again when it is written. That is
 * not redundancy: this layer gives the operator a usable message, and the
 * database guarantees the rule holds for any path that ever reaches the table.
 */
export type AIGenerationResult =
  | { ok: true; definition: SiteDefinition; provider: string }
  | { ok: false; error: string; provider: string };

export class WebsiteAIService {
  constructor(private readonly provider: WebsiteAIProvider = new MockWebsiteAIProvider()) {}

  get providerName(): string {
    return this.provider.name;
  }

  async generate(input: GenerateSiteInput): Promise<AIGenerationResult> {
    return this.validate(() => this.provider.generateSite(input));
  }

  async revise(input: ReviseSiteInput): Promise<AIGenerationResult> {
    return this.validate(() => this.provider.reviseSite(input));
  }

  private async validate(call: () => Promise<{ raw: unknown }>): Promise<AIGenerationResult> {
    const provider = this.provider.name;

    let raw: unknown;
    try {
      raw = (await call()).raw;
    } catch (cause) {
      // A provider that throws — a timeout, a refusal, a 500 — is a failed
      // generation, not an application error. The operator is told the draft
      // was not produced; nothing is written.
      return { ok: false, provider, error: `تعذّر توليد الموقع (${provider}).` };
    }

    // Model output can be a string containing JSON, and a string that is not
    // JSON at all. Both are handled as invalid output rather than as a crash.
    if (typeof raw === 'string') {
      try {
        raw = JSON.parse(raw);
      } catch {
        return { ok: false, provider, error: 'ناتج المولّد ليس JSON صالحًا.' };
      }
    }

    const parsed = parseSiteDefinition(raw);
    if (!parsed.ok) {
      return { ok: false, provider, error: `ناتج المولّد مرفوض: ${parsed.error}` };
    }
    return { ok: true, provider, definition: parsed.definition };
  }
}

/**
 * The provider this deployment uses.
 *
 * A single place to swap in ClaudeProvider once a key exists. The key will be
 * read here, server-side, and never reach a client component — a provider is
 * constructed in this module or not at all.
 */
export function websiteAIService(): WebsiteAIService {
  return new WebsiteAIService(new MockWebsiteAIProvider());
}
