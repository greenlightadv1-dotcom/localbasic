/** Client-safe pieces shared by the hub's tabs. */

export type Scope = { organizationSlug: string; branchSlug: string };

export type PosCan = {
  order: boolean;
  pay: boolean;
  discount: boolean;
  split: boolean;
  setStatus: boolean;
  serve: boolean;
  delivery: boolean;
};

/** A menu item as the composer needs it (the shape of listMenu()). */
export type PosMenuItem = {
  id: string;
  name: string;
  categoryId: string | null;
  categoryName: string | null;
  imageUrl: string | null;
  variants: { id: string; name: string; priceCents: number; isAvailableHere: boolean }[];
  modifierGroupCount: number;
};

export type PosModifierGroup = {
  id: string;
  productId: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  modifiers: { id: string; name: string; priceCents: number }[];
};

export type CartLine = {
  key: string;
  productName: string;
  variantId: string;
  variantName: string;
  unitPriceCents: number;
  modifiers: { id: string; name: string; priceCents: number }[];
  quantity: number;
  note: string;
};

export const ORDER_STATUS_AR: Record<string, string> = {
  new: 'لم يُرسل للمطبخ',
  confirmed: 'في المطبخ',
  preparing: 'تحت التحضير',
  ready: 'جاهز',
  served: 'تم التقديم',
  completed: 'مغلق',
  cancelled: 'ملغي',
};

export const ORDER_TYPE_AR: Record<string, string> = { dine_in: 'صالة', takeaway: 'تيك أواي', delivery: 'دليفري' };

export function minutesSince(iso: string, now = Date.now()) {
  return Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
}

/** mm:ss (or h:mm:ss) since a moment — the KDS ticket clock. */
export function clock(fromIso: string, now = Date.now()) {
  const s = Math.max(0, Math.floor((now - new Date(fromIso).getTime()) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** The composer's estimate before tax; the database prices the real order. */
export function cartLineCents(l: Pick<CartLine, 'unitPriceCents' | 'modifiers' | 'quantity'>) {
  return Math.round((l.unitPriceCents + l.modifiers.reduce((s, m) => s + m.priceCents, 0)) * l.quantity);
}

/** Validate one item's modifier choices against its groups' min/max. */
export function choiceErrors(groups: PosModifierGroup[], chosen: Record<string, string[]>): string[] {
  const errors: string[] = [];
  for (const g of groups) {
    const n = (chosen[g.id] ?? []).length;
    if (n < g.minSelect) errors.push(g.minSelect === 1 ? `اختر من "${g.name}"` : `اختر ${g.minSelect} على الأقل من "${g.name}"`);
    if (n > g.maxSelect) errors.push(`حتى ${g.maxSelect} من "${g.name}"`);
  }
  return errors;
}

/** Same item, same choices, same note: one line with a bigger quantity. */
export function lineKey(variantId: string, modifierIds: string[], note: string) {
  return `${variantId}|${[...modifierIds].sort().join(',')}|${note.trim()}`;
}

/** A short chime or alert tone through Web Audio; silent where audio is blocked. */
export function tone(kind: 'new' | 'late' | 'ready') {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const notes = kind === 'new' ? [880, 1175] : kind === 'ready' ? [1319, 1568, 2093] : [440, 330, 440];
    notes.forEach((f, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = kind === 'late' ? 'square' : 'sine';
      osc.frequency.value = f;
      const t = ctx.currentTime + i * 0.18;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(kind === 'late' ? 0.08 : 0.15, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.17);
    });
    setTimeout(() => void ctx.close(), 1200);
  } catch {
    /* audio is a nicety */
  }
}
