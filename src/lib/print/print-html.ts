/**
 * Prints an HTML document through the browser's print dialog, from a hidden
 * frame, so the page the user is on is untouched — no navigation, no popup
 * (a popup would be blocked when the print follows an async fetch), and
 * nothing of the app's own screen on the paper.
 *
 * "The printer" is whatever the device has installed: a USB or network thermal
 * printer set up in the operating system shows up in the dialog like any other.
 * The document sizes itself for an 80mm roll with @page.
 *
 * Never throws; returns what happened so the caller can tell the user.
 */
export type PrintResult = { ok: true } | { ok: false; error: string };

const CLEANUP_AFTER_MS = 60_000;
/** Give up if the document never loads (a blocked frame, a crashed renderer). */
const LOAD_TIMEOUT_MS = 10_000;

/**
 * Whether this load is the receipt itself. A new iframe first holds an empty
 * about:blank document, and browsers fire `load` for it when the frame joins
 * the page — printing then produced a blank, unstyled page (and the dialog for
 * it), with the real receipt arriving only afterwards. srcdoc documents report
 * the URL about:srcdoc (HTML spec), so that is what we wait for.
 */
function isReceiptDocument(win: Window): boolean {
  try {
    return win.location.href === 'about:srcdoc';
  } catch {
    return false;
  }
}

export function printHtml(html: string): Promise<PrintResult> {
  return new Promise((resolve) => {
    if (typeof document === 'undefined') {
      resolve({ ok: false, error: 'الطباعة متاحة من المتصفح فقط.' });
      return;
    }

    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;inset-inline-end:0;bottom:0;width:0;height:0;border:0;visibility:hidden';

    let done = false;
    let printing = false;
    const cleanup = () => frame.remove();
    const finish = (result: PrintResult) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const fail = (error: string) => {
      cleanup();
      finish({ ok: false, error });
    };

    const timeout = setTimeout(() => fail('تعذّر تجهيز الإيصال للطباعة. حاول مرة أخرى.'), LOAD_TIMEOUT_MS);

    const print = (win: Window) => {
      try {
        // The frame's own afterprint is the reliable moment to remove it;
        // removing it right after print() can cancel the job in some browsers.
        win.addEventListener('afterprint', cleanup);
        win.focus();
        win.print();
        finish({ ok: true });
        setTimeout(cleanup, CLEANUP_AFTER_MS);
      } catch {
        fail('تعذّرت الطباعة. تحقق من إعدادات الطابعة في المتصفح.');
      }
    };

    frame.onload = () => {
      const win = frame.contentWindow;
      if (!win) {
        fail('تعذّر فتح نافذة الطباعة.');
        return;
      }
      // Ignore the initial about:blank load, and print exactly once.
      if (printing || !isReceiptDocument(win)) return;
      printing = true;
      // Let the receipt's fonts load and lay out once before the dialog
      // snapshots it; without fonts the first print can fall back to a
      // default face and different line breaks.
      const fonts = (win.document as Document & { fonts?: { ready?: Promise<unknown> } }).fonts?.ready;
      Promise.resolve(fonts)
        .catch(() => undefined)
        .then(() => {
          if (typeof win.requestAnimationFrame === 'function') win.requestAnimationFrame(() => print(win));
          else print(win);
        });
    };

    // The document is set BEFORE the frame joins the page, so the first real
    // navigation is already the receipt.
    frame.srcdoc = html;
    document.body.appendChild(frame);
  });
}
