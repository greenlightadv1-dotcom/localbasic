import 'server-only';
import { Socket } from 'net';

/**
 * Fire a raw byte buffer at a LAN thermal printer over its own TCP port
 * (9100 is the near-universal default for Epson/star/generic ESC/POS
 * network printers — "raw 9100 printing"). This never throws: a kitchen
 * printer being unplugged, out of paper, or simply not configured yet must
 * never block or fail placing, confirming, or paying for an order. Callers
 * get a boolean back for their own logging, nothing more.
 */
export async function printToStation(
  ip: string,
  port: number,
  data: Buffer,
  timeoutMs = 4000,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    let settled = false;

    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };

    socket.setTimeout(timeoutMs);
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, ip, () => {
      socket.write(data, (err) => finish(!err));
    });
  });
}
