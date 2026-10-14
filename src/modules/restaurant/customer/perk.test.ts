import { describe, expect, it } from 'vitest';
import { loyaltyPerk, type LoyaltyPublic } from './perk';

const L: LoyaltyPublic = { enabled: true, centsPerPoint: 1000, rewardPoints: 100, rewardValueCents: 2000 };

describe('loyaltyPerk', () => {
  it('shows nothing when loyalty is off or the cart is empty', () => {
    expect(loyaltyPerk({ cartCents: 5000, loyalty: { ...L, enabled: false }, balance: 10 })).toBeNull();
    expect(loyaltyPerk({ cartCents: 5000, loyalty: null, balance: 10 })).toBeNull();
    expect(loyaltyPerk({ cartCents: 0, loyalty: L, balance: 10 })).toBeNull();
  });

  it('estimates points for a guest whose balance is unknown', () => {
    const p = loyaltyPerk({ cartCents: 25000, loyalty: L, balance: null })!;
    expect(p.text).toContain('25');
    expect(p.progress).toBeNull();
    expect(loyaltyPerk({ cartCents: 500, loyalty: L, balance: null })).toBeNull();
  });

  it('tracks progress toward the reward', () => {
    const p = loyaltyPerk({ cartCents: 20000, loyalty: L, balance: 50 })!;
    expect(p.progress).toBeCloseTo(0.7);
    expect(p.reached).toBe(false);
    expect(p.text).toContain('تكسب 20');
    expect(p.text).toContain('30');
  });

  it('celebrates when this order completes the reward, or one is already waiting', () => {
    expect(loyaltyPerk({ cartCents: 60000, loyalty: L, balance: 50 })).toMatchObject({ reached: true, progress: 1 });
    expect(loyaltyPerk({ cartCents: 1000, loyalty: L, balance: 120 })).toMatchObject({ reached: true, progress: 1 });
  });
});
