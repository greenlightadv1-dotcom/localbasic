import 'server-only';

/**
 * The DNS verification boundary.
 *
 * LocalBasic asks one question of the outside world — "what TXT records does
 * this name have?" — and that question is the whole reason this interface
 * exists. Production answers it over DNS. Tests answer it from a fixture.
 * Nothing else about verification differs between the two, so a test exercises
 * the real comparison logic rather than a simulation of it.
 *
 * Note what an implementation may NOT do: decide whether a domain is verified.
 * It reports what DNS said; the database hashes those values and compares them
 * against the stored challenge. A verifier that lied about the records would
 * still not be able to produce the right hash.
 */
export type DomainVerifier = {
  /** The TXT record values at `name`, or [] when the name has none. */
  lookupTxt(name: string): Promise<string[]>;
};

/** The name a customer must create the TXT record at. */
export function challengeName(hostname: string): string {
  return `_localbasic.${hostname}`;
}

/**
 * Production: DNS over HTTPS.
 *
 * Chosen over node:dns because it works unchanged on Vercel's runtimes and
 * needs no dependency. Cloudflare's resolver is used for the lookup only — it
 * never learns anything but the name being checked, and its answer is not
 * trusted beyond being hashed and compared.
 */
export class DohVerifier implements DomainVerifier {
  constructor(private readonly endpoint = 'https://cloudflare-dns.com/dns-query') {}

  async lookupTxt(name: string): Promise<string[]> {
    const url = `${this.endpoint}?name=${encodeURIComponent(name)}&type=TXT`;
    const response = await fetch(url, {
      headers: { accept: 'application/dns-json' },
      // A verification click should fail fast rather than hold a request open.
      signal: AbortSignal.timeout(5_000),
      cache: 'no-store',
    });
    if (!response.ok) {
      throw new Error(`DNS lookup failed with status ${response.status}`);
    }

    const body = (await response.json()) as { Answer?: { type: number; data: string }[] };
    return (body.Answer ?? [])
      .filter((a) => a.type === 16) // TXT
      .map((a) => a.data);
  }
}

/**
 * Tests: a fixture read from the environment.
 *
 * Active only under the local development adapter, which cannot run in
 * production. The format is `name=value` pairs separated by commas, e.g.
 *   LOCALBASIC_DNS_FIXTURE="_localbasic.a.test=abc,_localbasic.b.test=def"
 *
 * This lets the end-to-end tests drive a real verification — the same RPC, the
 * same hashing, the same state machine — without owning a domain, while never
 * shipping a code path that can claim success without a lookup.
 */
export class FixtureVerifier implements DomainVerifier {
  constructor(private readonly raw = process.env.LOCALBASIC_DNS_FIXTURE ?? '') {}

  async lookupTxt(name: string): Promise<string[]> {
    return this.raw
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const at = entry.indexOf('=');
        return at === -1 ? null : { name: entry.slice(0, at).trim(), value: entry.slice(at + 1) };
      })
      .filter((e): e is { name: string; value: string } => e !== null && e.name === name)
      .map((e) => e.value);
  }
}

/**
 * Which verifier this deployment uses.
 *
 * The fixture is reachable only with the local adapter active, which is itself
 * refused in production — so a deployed LocalBasic always does a real lookup.
 */
export function getDomainVerifier(): DomainVerifier {
  const localDb =
    process.env.LOCALBASIC_LOCAL_DB === '1' && process.env.NODE_ENV !== 'production';
  return localDb ? new FixtureVerifier() : new DohVerifier();
}
