import { describe, it, expect, afterEach } from 'vitest';
import {
  DohVerifier, FixtureVerifier, challengeName, getDomainVerifier,
} from './domain-verifier';

/**
 * Which verifier a deployment gets.
 *
 * This is the guard that keeps "verified" honest: production must do a real
 * DNS lookup, and the deterministic fixture must be unreachable there. It is
 * asserted here rather than only end-to-end because the end-to-end suite runs
 * with the local adapter on, so it can never observe the production branch.
 */
/**
 * NODE_ENV is typed as read-only, because application code has no business
 * changing it. A test of the branch that depends on it does.
 */
const env = process.env as Record<string, string | undefined>;

const saved = {
  localDb: process.env.LOCALBASIC_LOCAL_DB,
  nodeEnv: process.env.NODE_ENV,
  fixture: process.env.LOCALBASIC_DNS_FIXTURE,
};

function restore(key: keyof typeof saved, envName: string) {
  const value = saved[key];
  if (value === undefined) delete env[envName];
  else env[envName] = value;
}

afterEach(() => {
  restore('localDb', 'LOCALBASIC_LOCAL_DB');
  restore('nodeEnv', 'NODE_ENV');
  restore('fixture', 'LOCALBASIC_DNS_FIXTURE');
});

describe('getDomainVerifier', () => {
  it('uses the real resolver when the local adapter is off', () => {
    env.LOCALBASIC_LOCAL_DB = '0';
    env.NODE_ENV = 'development';
    expect(getDomainVerifier()).toBeInstanceOf(DohVerifier);
  });

  it('uses the real resolver in production even with the flag set', () => {
    // The fixture would be a way to claim verification without a lookup, so
    // NODE_ENV=production overrides the flag rather than trusting it.
    env.LOCALBASIC_LOCAL_DB = '1';
    env.NODE_ENV = 'production';
    env.LOCALBASIC_DNS_FIXTURE = '_localbasic.example.test=anything';
    expect(getDomainVerifier()).toBeInstanceOf(DohVerifier);
  });

  it('uses the real resolver when no flag is set at all', () => {
    delete env.LOCALBASIC_LOCAL_DB;
    env.NODE_ENV = 'production';
    expect(getDomainVerifier()).toBeInstanceOf(DohVerifier);
  });

  it('uses the fixture only under the local adapter outside production', () => {
    env.LOCALBASIC_LOCAL_DB = '1';
    env.NODE_ENV = 'test';
    expect(getDomainVerifier()).toBeInstanceOf(FixtureVerifier);
  });
});

describe('challengeName', () => {
  it('is the hostname under the _localbasic label', () => {
    expect(challengeName('shop.example.test')).toBe('_localbasic.shop.example.test');
  });
});

describe('FixtureVerifier', () => {
  it('returns only the values recorded for the exact name', async () => {
    const v = new FixtureVerifier('_localbasic.a.test=one,_localbasic.b.test=two');
    expect(await v.lookupTxt('_localbasic.a.test')).toEqual(['one']);
    expect(await v.lookupTxt('_localbasic.b.test')).toEqual(['two']);
  });

  it('returns nothing for a name it was not told about', async () => {
    const v = new FixtureVerifier('_localbasic.a.test=one');
    expect(await v.lookupTxt('_localbasic.c.test')).toEqual([]);
  });

  it('is empty when no fixture is configured', async () => {
    expect(await new FixtureVerifier('').lookupTxt('_localbasic.a.test')).toEqual([]);
  });
});
