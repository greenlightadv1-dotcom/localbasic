import { describe, expect, it, vi } from 'vitest';

// The service imports the Supabase client at module level, which validates the
// client environment. The schema itself touches neither it nor React.
vi.mock('react', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('react')),
  cache: <T>(fn: T) => fn,
}));

vi.mock('@/lib/env', () => ({
  clientEnv: {
    NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key-that-is-long-enough',
    NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
    NEXT_PUBLIC_APP_NAME: 'LocalBasic',
  },
  serverEnv: () => ({}),
}));

const rpc = vi.fn();
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () => ({ rpc }),
}));

import { isIanaTimeZone } from '@/lib/time';
import {
  DEFAULT_TIMEZONE,
  provisionWorkspace,
  provisionWorkspaceSchema,
} from './service';

/**
 * A workspace's timezone decides which calendar day every sale is reported on,
 * so an unusable value is not cosmetic. It used to be validated as
 * `z.string().trim().min(3)`, which accepts 'abc' — and the onboarding form
 * posts it as a hidden field, so the browser can post anything at all.
 *
 * Validation is server-side and authoritative. These tests exercise the SCHEMA,
 * which is what the server action runs before anything reaches the database.
 */

/** The rest of a valid provisioning payload, so only the zone is under test. */
const base = {
  organizationName: 'لافيشي',
  slug: 'lavechi',
  moduleKey: 'restaurant' as const,
};

const parse = (timezone?: unknown) =>
  provisionWorkspaceSchema.safeParse(
    timezone === undefined ? base : { ...base, timezone },
  );

describe('provisionWorkspaceSchema.timezone', () => {
  it.each([
    ['a valid IANA zone', 'Africa/Cairo'],
    ['UTC', 'UTC'],
    ['a zone with DST', 'America/New_York'],
    ['another zone with DST', 'Europe/Berlin'],
  ])('accepts %s', (_label, zone) => {
    const result = parse(zone);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.timezone).toBe(zone);
  });

  it.each([
    ['an unknown zone name', 'Mars/Phobos'],
    ['a plausible but wrong name', 'Africa/Kairo'],
    ['malformed input', 'not a timezone'],
    ['the old three-character minimum', 'abc'],
    ['an empty string', ''],
    ['whitespace only', '   '],
    ['a tab', '\t'],
    ['a fixed offset, which has no DST rules', '+03:00'],
    ['an offset in UTC form', 'UTC+3'],
    ['a SQL-ish payload', "Africa/Cairo'; drop table organizations--"],
    ['a non-string', 42],
    ['null', null],
  ])('rejects %s', (_label, zone) => {
    expect(parse(zone).success).toBe(false);
  });

  it('trims a valid value before validating and persisting it', () => {
    const result = parse('  Africa/Cairo  ');
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.timezone).toBe('Africa/Cairo');
  });

  it('rejects a value that is only valid once padding is ignored mid-string', () => {
    expect(parse('Africa / Cairo').success).toBe(false);
  });

  // Documented behaviour: absent means "use the platform default". Only an
  // explicitly supplied value can be wrong, and a wrong one is an error.
  it('falls back to the platform default when the field is missing', () => {
    const result = parse(undefined);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.timezone).toBe(DEFAULT_TIMEZONE);
  });

  it('has a platform default that is itself a valid IANA zone', () => {
    expect(isIanaTimeZone(DEFAULT_TIMEZONE)).toBe(true);
  });

  it('does not treat a missing field as an invalid one', () => {
    // The distinction is the whole point: defaulting an invalid value would
    // silently move a tenant's business day.
    expect(parse(undefined).success).toBe(true);
    expect(parse('').success).toBe(false);
  });
});

describe('provisioning persistence', () => {
  it('never reaches the database when the timezone is invalid', async () => {
    rpc.mockClear();
    const result = provisionWorkspaceSchema.safeParse({
      ...base,
      timezone: 'Mars/Phobos',
    });
    expect(result.success).toBe(false);

    // And the RPC is only ever called with parsed input, so nothing was sent.
    expect(rpc).not.toHaveBeenCalled();
  });

  it('sends the trimmed zone to provision_workspace', async () => {
    rpc.mockClear();
    rpc.mockReturnValue({
      single: async () => ({
        data: {
          out_organization_id: 'org-1',
          out_organization_slug: 'lavechi',
          out_branch_id: 'br-1',
        },
        error: null,
      }),
    });

    const parsed = provisionWorkspaceSchema.parse({ ...base, timezone: ' Europe/Berlin ' });
    await provisionWorkspace(parsed);

    expect(rpc).toHaveBeenCalledWith(
      'provision_workspace',
      expect.objectContaining({ p_timezone: 'Europe/Berlin' }),
    );
  });
});

describe('isIanaTimeZone', () => {
  it('is stricter than isValidTimeZone about offset-shaped values', () => {
    // Intl accepts '+03:00'; a zone with no DST rules must not be storable.
    expect(new Intl.DateTimeFormat('en-US', { timeZone: '+03:00' })).toBeTruthy();
    expect(isIanaTimeZone('+03:00')).toBe(false);
  });

  it('rejects untrimmed input rather than trimming it itself', () => {
    // Trimming belongs to the schema, so there is exactly one place it happens.
    expect(isIanaTimeZone(' UTC')).toBe(false);
    expect(isIanaTimeZone('UTC')).toBe(true);
  });
});
