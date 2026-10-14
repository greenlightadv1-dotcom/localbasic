import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { printHtml } from './print-html';

/**
 * A just-enough iframe that behaves like Chromium: joining the page fires
 * `load` for the initial about:blank document first (synchronously), then the
 * srcdoc document loads. `printedHref` records which document was printed.
 */
function stubDocument(opts: { printThrows?: boolean; noWindow?: boolean; neverLoads?: boolean } = {}) {
  const location = { href: 'about:blank' };
  const printedHref: string[] = [];
  const print = vi.fn(() => {
    printedHref.push(location.href);
    if (opts.printThrows) throw new Error('blocked');
  });
  let hasSrcdoc = false;
  const frame: Record<string, unknown> = {
    style: {},
    removed: false,
    setAttribute: vi.fn(),
    remove() { (frame as { removed: boolean }).removed = true; },
    onload: null as null | (() => void),
    contentWindow: opts.noWindow ? null : { addEventListener: vi.fn(), focus: vi.fn(), print, location, document: {} },
  };
  Object.defineProperty(frame, 'srcdoc', { set() { hasSrcdoc = true; } });
  vi.stubGlobal('document', {
    createElement: () => frame,
    body: {
      appendChild: vi.fn(() => {
        (frame.onload as () => void)?.(); // the initial about:blank load
        if (hasSrcdoc && !opts.neverLoads) {
          queueMicrotask(() => {
            location.href = 'about:srcdoc';
            (frame.onload as () => void)?.();
          });
        }
      }),
    },
  });
  return { frame, print, printedHref };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('printHtml', () => {
  it('prints the receipt document once, never the blank page that loads first', async () => {
    const { print, printedHref } = stubDocument();
    const p = printHtml('<html></html>');
    await vi.advanceTimersByTimeAsync(0);
    await expect(p).resolves.toEqual({ ok: true });
    expect(print).toHaveBeenCalledTimes(1);
    expect(printedHref).toEqual(['about:srcdoc']);
  });

  it('gives up cleanly if the receipt never loads', async () => {
    const { frame, print } = stubDocument({ neverLoads: true });
    const p = printHtml('<html></html>');
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(p).resolves.toMatchObject({ ok: false });
    expect(print).not.toHaveBeenCalled();
    expect(frame.removed).toBe(true);
  });

  it('opens the print dialog for the document and reports success', async () => {
    const { print } = stubDocument();
    const p = printHtml('<html></html>');
    await vi.advanceTimersByTimeAsync(0);
    await expect(p).resolves.toEqual({ ok: true });
    expect(print).toHaveBeenCalledTimes(1);
  });

  it('removes the hidden frame afterwards', async () => {
    const { frame } = stubDocument();
    const p = printHtml('<html></html>');
    await vi.advanceTimersByTimeAsync(0);
    await p;
    expect(frame.removed).toBe(false);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(frame.removed).toBe(true);
  });

  it('reports, rather than throws, when printing is blocked', async () => {
    const { frame } = stubDocument({ printThrows: true });
    const p = printHtml('<html></html>');
    await vi.advanceTimersByTimeAsync(0);
    await expect(p).resolves.toMatchObject({ ok: false });
    expect(frame.removed).toBe(true);
  });

  it('reports when the frame has no window', async () => {
    stubDocument({ noWindow: true });
    const p = printHtml('<html></html>');
    await vi.advanceTimersByTimeAsync(0);
    await expect(p).resolves.toMatchObject({ ok: false });
  });

  it('is safe to call outside a browser', async () => {
    vi.stubGlobal('document', undefined);
    await expect(printHtml('x')).resolves.toMatchObject({ ok: false });
  });
});
