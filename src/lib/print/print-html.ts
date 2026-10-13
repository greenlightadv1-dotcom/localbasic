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
    const cleanup = () => frame.remove();
    const finish = (result: PrintResult) => {
      if (done) return;
      done = true;
      resolve(result);
    };

    frame.onload = () => {
      const win = frame.contentWindow;
      if (!win) {
        cleanup();
        finish({ ok: false, error: 'تعذّر فتح نافذة الطباعة.' });
        return;
      }
      try {
        // The frame's own afterprint is the reliable moment to remove it;
        // removing it right after print() can cancel the job in some browsers.
        win.addEventListener('afterprint', cleanup);
        win.focus();
        win.print();
        finish({ ok: true });
        setTimeout(cleanup, CLEANUP_AFTER_MS);
      } catch {
        cleanup();
        finish({ ok: false, error: 'تعذّرت الطباعة. تحقق من إعدادات الطابعة في المتصفح.' });
      }
    };

    document.body.appendChild(frame);
    frame.srcdoc = html;
  });
}
