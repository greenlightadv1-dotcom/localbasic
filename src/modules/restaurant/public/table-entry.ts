import 'server-only';
import { getPublicContext } from './service';

/**
 * `?table=<code>` on a menu address (the online menu, or a store's own domain).
 *
 * A table QR already carries an unguessable code that names the restaurant,
 * branch and table together (the same code /p/[code] uses). Scanning it with
 * the code in `?table=` must land the guest in that table's menu with nothing to
 * pick or type, so this resolves the code on the server and the caller redirects
 * to it. The code is the table binding: it is checked here, and checked again
 * when the order is placed.
 *
 * A bare table NUMBER is deliberately not accepted. Anyone can guess "5", and
 * an order would then land on a table whose guest never asked for it; an
 * unguessable code cannot be walked.
 *
 * Returns the code only when it resolves; anything else (missing, malformed,
 * revoked, expired) is null and the page renders the ordinary menu.
 */
export async function resolveTableCode(param: string | string[] | undefined): Promise<string | null> {
  const code = Array.isArray(param) ? param[0] : param;
  if (!code || !/^[A-Za-z0-9_-]{22,64}$/.test(code)) return null;
  try {
    await getPublicContext(code);
    return code;
  } catch {
    return null;
  }
}
