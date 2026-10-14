/** Client-safe shapes for the guest profile (0095). */
export type ProfileScope = { kind: 'slug'; orgSlug: string } | { kind: 'token'; token: string };

export type ReorderLine = {
  variantId: string;
  quantity: number;
  modifierIds: string[];
  note: string | null;
};

export type ProfileOrder = {
  number: string;
  status: string;
  type: string;
  totalCents: number;
  placedAt: string;
  /** Tracking-page token while it is still valid; null once expired. */
  token: string | null;
  items: (ReorderLine & { productName: string; variantName: string })[];
};

export type ProfileAddress = {
  recipientName: string;
  phone: string;
  city: string | null;
  area: string | null;
  address: string;
  landmark: string | null;
};

export type ProfileCoupon = { code: string; valueCents: number; expiresAt: string };

export type CustomerProfile =
  /**
   * Nothing to show: a phone this device is not verified for, a number nobody
   * has ordered with, or (`unavailable`) a lookup that could not run at all.
   * Never an error — the sheet shows a calm empty state.
   */
  | { verified: false; unavailable?: boolean }
  | {
      verified: true;
      name: string | null;
      phone: string;
      currency: string;
      addresses: ProfileAddress[];
      orders: ProfileOrder[];
      loyalty: {
        enabled: boolean;
        earned: number;
        spent: number;
        balance: number;
        rewardPoints: number;
        rewardValueCents: number;
        centsPerPoint: number;
      };
      coupons: ProfileCoupon[];
    };

/** Orders a guest would still want to follow. */
export const ACTIVE_STATUSES = ['new', 'confirmed', 'preparing', 'ready', 'served'] as const;
