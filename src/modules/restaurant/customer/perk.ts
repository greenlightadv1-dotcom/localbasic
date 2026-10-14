/**
 * What the sticky cart bar tells a guest about loyalty while they fill the
 * cart. Pure so the wording and the arithmetic are testable.
 *
 * Points are earned on the order's total, floor(total / centsPerPoint) — the
 * same rule the database applies to completed orders — so this is an
 * estimate (tax and delivery are in the real total), shown with "~".
 */
export type LoyaltyPublic = {
  enabled: boolean;
  centsPerPoint: number;
  rewardPoints: number;
  rewardValueCents: number;
};

export type CartPerk = {
  text: string;
  /** 0..1 toward the next reward; null when the balance is unknown. */
  progress: number | null;
  reached: boolean;
};

export function loyaltyPerk(input: {
  cartCents: number;
  loyalty: LoyaltyPublic | null | undefined;
  /** The guest's current balance, when their profile is known. */
  balance: number | null;
}): CartPerk | null {
  const { cartCents, loyalty, balance } = input;
  if (!loyalty?.enabled || cartCents <= 0 || loyalty.centsPerPoint <= 0) return null;

  const earn = Math.floor(cartCents / loyalty.centsPerPoint);

  if (balance === null) {
    return earn > 0
      ? { text: `🎁 ستكسب ~${earn} نقطة بهذا الطلب`, progress: null, reached: false }
      : null;
  }
  if (balance >= loyalty.rewardPoints) {
    return { text: '🎁 عندك مكافأة جاهزة — استبدلها من «حسابي»', progress: 1, reached: true };
  }
  const after = balance + earn;
  if (after >= loyalty.rewardPoints) {
    return { text: '🎉 هذا الطلب يكمّل مكافأتك القادمة', progress: 1, reached: true };
  }
  return {
    text: `تكسب ${earn} نقطة · باقي ${loyalty.rewardPoints - after} للمكافأة`,
    progress: after / loyalty.rewardPoints,
    reached: false,
  };
}
