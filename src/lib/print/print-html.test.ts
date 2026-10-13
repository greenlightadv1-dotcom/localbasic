import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { printHtml } from './print-html';

/** A just-enough iframe: loads (fires onload) as soon as srcdoc is set. */
function stubDocument(opts: { printThrows?: boolean; noWindow?: boolean } = {}) {
  const print = vi.fn(() => { if (opts.printThrows) throw new Error('blocked'); });
  const frame: Record<string, unknown> = {
    style: {},
    removed: false,
    setAttribute: vi.fn(),
    remove() { (frame as { removed: boolean }).removed = true; },
    onload: null as null | (() => void),
    contentWindow: opts.noWindow ? null : { addEventListener: vi.fn(), focus: vi.fn(), print },
  };
  Object.defineProperty(frame, 'srcdoc', {
    set() { queueMicrotask(() => (frame.onload as () => void)?.()); },
  });
  vi.stubGlobal('document', {
    createElement: () => frame,
    body: { appendChild: vi.fn() },
  });
  return { frame, print };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('printHtml', () => {
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
