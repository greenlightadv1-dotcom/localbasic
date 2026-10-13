import { describe, expect, it } from 'vitest';
import { buildKitchenTicket, type Ticket } from './escpos';

const base: Ticket = {
  stationName: 'بار',
  orderNumber: '000031',
  orderType: 'dine_in',
  tableName: '4',
  channel: 'qr',
  placedAt: new Date('2026-10-13T12:00:00Z'),
  note: null,
  lines: [],
};

describe('station ticket', () => {
  it('prints internal prep specs under the dish, one row per line', () => {
    const out = buildKitchenTicket({
      ...base,
      lines: [{
        productName: 'لاتيه', variantName: 'default', quantity: 2, note: null,
        modifiers: ['كراميل'], prepNotes: '18g بن\nلبن 150 مل',
      }],
    }).toString('utf8');
    expect(out).toContain('تحضير: 18g بن');
    expect(out).toContain('تحضير: لبن 150 مل');
    expect(out).toContain('+ كراميل');
  });

  it('prints nothing extra when a dish has no specs', () => {
    const out = buildKitchenTicket({
      ...base,
      lines: [{ productName: 'عصير', variantName: 'default', quantity: 1, note: null, modifiers: [], prepNotes: null }],
    }).toString('utf8');
    expect(out).not.toContain('تحضير:');
  });
});
