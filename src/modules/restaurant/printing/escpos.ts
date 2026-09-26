/**
 * A minimal ESC/POS ticket builder — no dependency, because a kitchen ticket
 * needs maybe a dozen control codes total (initialize, bold, double-height,
 * cut, feed) and every network thermal printer on the market understands
 * this exact subset regardless of brand.
 *
 * Text is encoded as UTF-8. Most Epson-compatible printers accept UTF-8 for
 * Arabic today; a printer that does not is a hardware/firmware limitation no
 * byte sequence here can work around, and is out of scope for this module.
 */

const ESC = 0x1b;
const GS = 0x1d;

const INIT = Buffer.from([ESC, 0x40]);
const BOLD_ON = Buffer.from([ESC, 0x45, 1]);
const BOLD_OFF = Buffer.from([ESC, 0x45, 0]);
const DOUBLE_ON = Buffer.from([GS, 0x21, 0x11]);
const DOUBLE_OFF = Buffer.from([GS, 0x21, 0x00]);
const ALIGN_CENTER = Buffer.from([ESC, 0x61, 1]);
const ALIGN_LEFT = Buffer.from([ESC, 0x61, 0]);
const FEED = (lines: number) => Buffer.from([ESC, 0x64, lines]);
const CUT = Buffer.from([GS, 0x56, 0x00]);

export type TicketLine = {
  productName: string;
  variantName: string;
  quantity: number;
  note: string | null;
  modifiers: string[];
};

export type Ticket = {
  stationName: string;
  orderNumber: string;
  /** 'dine_in' | 'takeaway' | 'pickup' | 'delivery' */
  orderType: string;
  /** null for a dine-in order taken without a table, or any non-dine-in order. */
  tableName: string | null;
  /** 'online' when placed through the customer-facing storefront, else the staff channel. */
  channel: string;
  placedAt: Date;
  note: string | null;
  lines: TicketLine[];
};

function text(s: string): Buffer {
  return Buffer.from(`${s}\n`, 'utf8');
}

/** Builds the full byte sequence for one station's copy of one order. */
export function buildKitchenTicket(ticket: Ticket): Buffer {
  const parts: Buffer[] = [INIT, ALIGN_CENTER, BOLD_ON, DOUBLE_ON, text(ticket.stationName)];
  parts.push(DOUBLE_OFF, BOLD_OFF, ALIGN_LEFT);
  parts.push(text('-'.repeat(32)));
  parts.push(BOLD_ON, text(`طلب ${ticket.orderNumber}`), BOLD_OFF);

  const originLabel = ticket.channel === 'online' ? 'أونلاين' : 'كاشير/كابتن';
  if (ticket.tableName) {
    parts.push(text(`طاولة: ${ticket.tableName}`));
  } else {
    parts.push(text(`النوع: ${ticket.orderType} (${originLabel})`));
  }
  parts.push(
    text(
      ticket.placedAt.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }),
    ),
  );
  parts.push(text('-'.repeat(32)));

  for (const line of ticket.lines) {
    const label =
      line.variantName && line.variantName !== 'default'
        ? `${line.productName} — ${line.variantName}`
        : line.productName;
    parts.push(BOLD_ON, text(`${line.quantity} × ${label}`), BOLD_OFF);
    for (const mod of line.modifiers) parts.push(text(`  + ${mod}`));
    if (line.note) parts.push(text(`  ملاحظة: ${line.note}`));
  }

  if (ticket.note) {
    parts.push(text('-'.repeat(32)));
    parts.push(text(`ملاحظة الطلب: ${ticket.note}`));
  }

  parts.push(FEED(3), CUT);
  return Buffer.concat(parts);
}
