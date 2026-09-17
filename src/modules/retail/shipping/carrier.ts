import 'server-only';

/**
 * The shipping boundary.
 *
 * LocalBasic integrates with no courier today, and this file is how it stays
 * honest about that rather than pretending otherwise. It states the two
 * questions a carrier is ever asked — "take this parcel" and "where is it
 * now" — so that adding a real courier later is a class here and a row in
 * `retail_shipping_providers`, not a schema change and not a rewrite of the
 * screens.
 *
 * Note what an adapter may NOT do:
 *
 *   * decide a shipment's status. It REPORTS what the carrier said; the state
 *     machine in migration 0049 decides whether that is a legal move, so an
 *     adapter returning nonsense is refused rather than believed.
 *
 *   * invent a tracking code. A code the shop shows a customer has to be one
 *     the carrier will recognise. An adapter with nothing to report returns
 *     null, and the screen says the parcel is not yet tracked.
 *
 *   * see an address it was not given. The address is copied from the order
 *     inside the database; this layer passes on the snapshot and nothing more.
 */

export type ParcelAddress = {
  recipientName: string;
  phone: string;
  city: string;
  addressLine: string;
};

export type Parcel = {
  shipmentId: string;
  orderNumber: string;
  address: ParcelAddress;
  /** What the shop expects to pay, in minor units. */
  costCents: number;
  currency: string;
  note: string | null;
};

/** What a carrier can tell us back. Both fields are optional: many cannot. */
export type CarrierBooking = {
  trackingCode: string | null;
  trackingUrl: string | null;
};

/** The statuses an adapter may report. A superset is not accepted. */
export type CarrierStatus = 'pending' | 'dispatched' | 'delivered' | 'failed';

export type CarrierUpdate = {
  status: CarrierStatus;
  /** Required by the database when the status is 'failed'. */
  reason?: string | null;
};

export type ShippingCarrier = {
  /** Stable identifier, matching `retail_shipping_providers.provider_key`. */
  readonly key: string;
  /** Hand the parcel over. Returns whatever the carrier can identify it by. */
  book(parcel: Parcel): Promise<CarrierBooking>;
  /**
   * Ask where a parcel is.
   *
   * Returns null when the carrier has nothing new to say — which, for a
   * carrier with no API, is always. The caller must treat null as "no change",
   * never as "delivered".
   */
  track(trackingCode: string): Promise<CarrierUpdate | null>;
};

/**
 * The shop's own rider, or a courier whose updates a human types in.
 *
 * This is not a stub standing in for a real integration: for most Egyptian
 * neighbourhood shops it IS the real workflow, and it is the honest default
 * until a courier account exists. It books nothing, tracks nothing, and says
 * so, so the screens show a parcel that staff move by hand.
 */
export class ManualCarrier implements ShippingCarrier {
  readonly key = 'manual';

  // The parameters are declared even though nothing reads them: dropping them
  // would still satisfy the interface structurally, but it makes the method
  // uncallable with the arguments every caller actually passes.
  async book(_parcel: Parcel): Promise<CarrierBooking> {
    // Nothing is contacted and nothing is generated. An operator types a code
    // in if the courier gave them one.
    return { trackingCode: null, trackingUrl: null };
  }

  async track(_trackingCode: string): Promise<CarrierUpdate | null> {
    // No API to ask. "No change" is the truthful answer, and the caller must
    // not read it as progress.
    return null;
  }
}

/**
 * The registry.
 *
 * Deliberately a lookup with one entry rather than a plugin loader: a second
 * carrier is a second entry, and a registry that can load anything is a
 * surface nobody asked for yet.
 */
const CARRIERS = new Map<string, ShippingCarrier>([['manual', new ManualCarrier()]]);

export function getCarrier(providerKey: string): ShippingCarrier {
  // An unknown key falls back to manual rather than throwing: a shop whose
  // courier integration was removed should still be able to send parcels by
  // hand, not find its shipping screen broken.
  return CARRIERS.get(providerKey) ?? CARRIERS.get('manual')!;
}

/** The carrier keys this deployment can actually honour. */
export function availableCarrierKeys(): string[] {
  return [...CARRIERS.keys()];
}
