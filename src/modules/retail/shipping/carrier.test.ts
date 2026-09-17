import { describe, it, expect } from 'vitest';
import {
  ManualCarrier, availableCarrierKeys, getCarrier, type Parcel,
} from './carrier';

/**
 * The shipping boundary's contract.
 *
 * These are the promises the rest of the system relies on: an adapter reports
 * and never decides, and the default adapter admits it knows nothing rather
 * than inventing progress. Asserted here because the end-to-end suite runs
 * against the manual carrier, where "no news" and "delivered" would be
 * indistinguishable if the adapter lied.
 */
const parcel: Parcel = {
  shipmentId: '00000000-0000-0000-0000-000000000001',
  orderNumber: '000001',
  address: {
    recipientName: 'المستلم',
    phone: '01000000000',
    city: 'القاهرة',
    addressLine: 'شارع 9',
  },
  costCents: 4000,
  currency: 'EGP',
  note: null,
};

describe('ManualCarrier', () => {
  it('books without inventing a tracking code', async () => {
    const booking = await new ManualCarrier().book(parcel);
    expect(booking.trackingCode).toBeNull();
    expect(booking.trackingUrl).toBeNull();
  });

  it('reports no change rather than progress', async () => {
    // The caller must read null as "nothing new", never as delivered. A
    // carrier with no API has nothing truthful to say.
    expect(await new ManualCarrier().track('anything')).toBeNull();
  });

  it('identifies itself with the key the database stores', () => {
    expect(new ManualCarrier().key).toBe('manual');
  });
});

describe('getCarrier', () => {
  it('returns the adapter for a known key', () => {
    expect(getCarrier('manual').key).toBe('manual');
  });

  it('falls back to manual for a key this deployment cannot honour', () => {
    // A shop whose courier integration was removed must still be able to send
    // parcels by hand, not find its shipping screen broken.
    expect(getCarrier('some_courier_we_do_not_have').key).toBe('manual');
  });

  it('only advertises carriers it can actually honour', () => {
    expect(availableCarrierKeys()).toEqual(['manual']);
  });
});
