import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * useLiveOrders without a DOM: React's hooks are replaced by minimal stand-ins
 * (effects run immediately, transitions run synchronously) so the timing and
 * subscription behaviour — the part that can silently go wrong — is what is
 * under test.
 */
const h = vi.hoisted(() => ({
  cleanups: [] as (() => void)[],
  pending: false,
  refresh: vi.fn(),
  statusCb: null as ((s: string) => void) | null,
  eventCb: null as (() => void) | null,
  channels: 0,
  removed: 0,
}));

vi.mock('react', () => ({
  useRef: <T,>(v: T) => ({ current: v }),
  useTransition: () => [h.pending, (fn: () => void) => fn()],
  useEffect: (fn: () => void | (() => void)) => {
    const c = fn();
    if (c) h.cleanups.push(c);
  },
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: h.refresh }) }));
vi.mock('@/lib/supabase/client', () => ({
  createSupabaseBrowserClient: () => ({
    channel: () => {
      h.channels += 1;
      const ch = {
        on: (_t: string, _f: unknown, cb: () => void) => { h.eventCb = cb; return ch; },
        subscribe: (cb: (s: string) => void) => { h.statusCb = cb; return ch; },
      };
      return ch;
    },
    removeChannel: () => { h.removed += 1; },
  }),
}));

import { useLiveOrders } from './use-live-orders';

const doc = { visibilityState: 'visible', addEventListener: vi.fn(), removeEventListener: vi.fn() };

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  doc.visibilityState = 'visible';
  h.cleanups = []; h.pending = false; h.statusCb = null; h.eventCb = null;
  h.channels = 0; h.removed = 0; h.refresh.mockClear();
});
afterEach(() => {
  h.cleanups.forEach((c) => c());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useLiveOrders', () => {
  it('refreshes every 5 seconds', () => {
    useLiveOrders('b1', 'cashier');
    vi.advanceTimersByTime(5_000);
    expect(h.refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000);
    expect(h.refresh).toHaveBeenCalledTimes(3);
  });

  it('does nothing while the tab is hidden, then catches up when it is visible', () => {
    useLiveOrders('b1', 'cashier');
    doc.visibilityState = 'hidden';
    vi.advanceTimersByTime(15_000);
    expect(h.refresh).not.toHaveBeenCalled();
    doc.visibilityState = 'visible';
    vi.advanceTimersByTime(5_000);
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it('never stacks a refresh on one still in flight', () => {
    h.pending = true;
    useLiveOrders('b1', 'cashier');
    vi.advanceTimersByTime(20_000);
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it('collapses a burst of realtime events into one refresh', () => {
    useLiveOrders('b1', 'cashier');
    h.eventCb!(); h.eventCb!(); h.eventCb!();
    vi.advanceTimersByTime(300);
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it('refreshes once the channel (re)subscribes, to catch what it missed', () => {
    useLiveOrders('b1', 'cashier');
    h.statusCb!('SUBSCRIBED');
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it('rebuilds a dead channel with backoff', () => {
    useLiveOrders('b1', 'cashier');
    expect(h.channels).toBe(1);
    h.statusCb!('CHANNEL_ERROR');
    vi.advanceTimersByTime(1_999);
    expect(h.channels).toBe(1);
    vi.advanceTimersByTime(1);
    expect(h.channels).toBe(2);
    expect(h.removed).toBe(1); // the dead channel is removed before reconnecting
    h.statusCb!('CLOSED');
    vi.advanceTimersByTime(3_999);
    expect(h.channels).toBe(2);
    vi.advanceTimersByTime(1);
    expect(h.channels).toBe(3);
  });

  it('stops everything on unmount', () => {
    useLiveOrders('b1', 'cashier');
    h.cleanups.forEach((c) => c());
    h.cleanups = [];
    vi.advanceTimersByTime(30_000);
    expect(h.refresh).not.toHaveBeenCalled();
    h.statusCb?.('CLOSED');
    vi.advanceTimersByTime(60_000);
    expect(h.channels).toBe(1);
  });
});
