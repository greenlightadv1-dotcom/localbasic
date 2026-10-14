'use client';

import { useEffect, useRef, useState } from 'react';
import { Plus, ShoppingBag, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { iconForCategory } from './category-icon';

/**
 * The customer-facing menu kit — what the online storefront and the table-QR
 * menu are both built from, modelled on a modern food-ordering app: a store
 * header, a sticky rail of round category icons, image-first food cards with a
 * one-tap add button, and a sticky bottom cart bar.
 *
 * Presentation only. Nothing here knows about carts, prices or checkout; the
 * callers own that, so the two ordering flows cannot drift apart visually and
 * neither can break the other's logic. Every color is a platform token
 * (bg-primary, text-fg, border-line…), so the whole kit re-themes from the
 * store's brand colors — see lib/theme/brand-theme.ts.
 */


// ---------------------------------------------------------------------------
// Image with a themed placeholder
// ---------------------------------------------------------------------------
/**
 * A photo that fills its parent, or — when there is none, or the URL fails to
 * load (a deleted upload, a dead link) — a placeholder in the store's own
 * colors: a soft tint of the brand color with a category icon in the brand
 * color. Never an empty box and never the browser's broken-image mark, and it
 * fills the same space, so cards in a row stay the same height.
 */
export function ImageOrIcon({
  src, categoryName, iconClassName, imgClassName, placeholderClassName,
}: {
  src: string | null | undefined;
  /** Picks the placeholder icon (a pizza section gets a pizza). */
  categoryName?: string | null;
  iconClassName?: string;
  imgClassName?: string;
  placeholderClassName?: string;
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const usable = Boolean(src) && failedSrc !== src;
  const imgRef = useRef<HTMLImageElement>(null);

  // The server renders this <img> before the page hydrates, so a URL that fails
  // fast can finish failing before React attaches onError — the event is
  // simply missed and the browser's broken-image mark stays. Once mounted,
  // look at the element itself: finished loading with no pixels means failed.
  useEffect(() => {
    const el = imgRef.current;
    if (el && src && el.complete && el.naturalWidth === 0) setFailedSrc(src);
  }, [src]);

  if (usable) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- a Storage URL, not a build asset.
      <img
        ref={imgRef}
        src={src!}
        alt=""
        loading="lazy"
        onError={() => setFailedSrc(src!)}
        className={cn('h-full w-full object-cover', imgClassName)}
      />
    );
  }

  const Icon = iconForCategory(categoryName);
  return (
    <span
      data-testid="image-placeholder"
      className={cn(
        'flex h-full w-full items-center justify-center bg-primary-soft text-primary',
        placeholderClassName,
      )}
    >
      <Icon className={cn('h-6 w-6 opacity-80', iconClassName)} strokeWidth={1.6} aria-hidden="true" />
    </span>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------
export function StoreHeader({
  name, logoUrl, description, chips = [], action,
}: {
  name: string;
  logoUrl: string | null;
  description?: string | null;
  /** Short facts under the name: branch, table, opening state. */
  chips?: string[];
  /** Trailing control, e.g. the profile button. */
  action?: React.ReactNode;
}) {
  return (
    <header className="flex items-center gap-3 px-4 pb-3 pt-5">
      {logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- an organization-supplied URL.
        <img src={logoUrl} alt="" className="h-14 w-14 shrink-0 rounded-full border border-line object-cover" />
      ) : (
        <span
          aria-hidden="true"
          className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-primary text-lg font-extrabold text-primary-fg"
        >
          {name.slice(0, 2)}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-xl font-extrabold text-fg">{name}</h1>
        {description ? <p className="line-clamp-2 text-sm text-muted">{description}</p> : null}
        {chips.length > 0 ? (
          <ul className="mt-1.5 flex flex-wrap gap-1.5">
            {chips.map((c) => (
              <li key={c} className="rounded-full bg-primary-soft px-2.5 py-0.5 text-xs font-semibold text-primary">
                {c}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {action ? <div className="shrink-0 self-start">{action}</div> : null}
    </header>
  );
}

// ---------------------------------------------------------------------------
// Category rail
// ---------------------------------------------------------------------------
export type RailCategory = { id: string; name: string; imageUrl: string | null };

/** The element id a category's section must carry for the rail to find it. */
export const categorySectionId = (id: string) => `menu-cat-${id}`;

/**
 * Sticky, horizontally scrolling round icons. Tapping one scrolls its section
 * into view; while scrolling, the icon of the section on screen is highlighted
 * (and kept in view in the rail), the way a delivery app's tab bar behaves.
 */
export function CategoryRail({ categories }: { categories: RailCategory[] }) {
  const [active, setActive] = useState(categories[0]?.id ?? '');
  const railRef = useRef<HTMLUListElement>(null);
  // While a tap-initiated scroll is running the observer must not fight it.
  const lockedUntil = useRef(0);

  // Scroll-spy: the active category is the last one whose heading has reached
  // the band under the sticky rail. Computed from positions on every (frame-
  // throttled) scroll rather than from intersection events, which only report
  // changes and so drift when sections enter and leave together.
  useEffect(() => {
    if (categories.length === 0) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      if (Date.now() < lockedUntil.current) return;
      let current = categories[0]!.id;
      for (const c of categories) {
        const el = document.getElementById(categorySectionId(c.id));
        if (el && el.getBoundingClientRect().top <= 150) current = c.id;
      }
      // A short last section can never reach the band; at the end of the page
      // it is the one being read.
      const atEnd = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
      setActive(atEnd && window.scrollY > 0 ? categories[categories.length - 1]!.id : current);
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [categories]);

  // Keep the active icon visible inside the rail.
  useEffect(() => {
    const el = railRef.current?.querySelector<HTMLElement>(`[data-cat="${CSS.escape(active)}"]`);
    el?.scrollIntoView?.({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }, [active]);

  function jump(id: string) {
    setActive(id);
    lockedUntil.current = Date.now() + 700;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    document.getElementById(categorySectionId(id))?.scrollIntoView({
      behavior: reduce ? 'auto' : 'smooth', block: 'start',
    });
  }

  if (categories.length < 2) return null;

  return (
    <nav aria-label="أقسام المنيو" className="sticky top-0 z-20 border-b border-line bg-bg/95 backdrop-blur">
      <ul ref={railRef} className="flex gap-4 overflow-x-auto px-4 py-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {categories.map((c) => {
          const on = c.id === active;
          return (
            <li key={c.id} data-cat={c.id} className="shrink-0">
              <button
                type="button"
                onClick={() => jump(c.id)}
                aria-current={on ? 'true' : undefined}
                className="flex w-[68px] flex-col items-center gap-1.5 outline-offset-4"
              >
                <span
                  className={cn(
                    'flex h-12 w-12 items-center justify-center overflow-hidden rounded-full bg-surface ring-2 ring-offset-2 ring-offset-bg transition-all',
                    on ? 'scale-105 ring-primary' : 'ring-transparent',
                  )}
                >
                  <ImageOrIcon src={c.imageUrl} categoryName={c.name} iconClassName="h-5 w-5" />
                </span>
                <span className={cn('line-clamp-1 w-full text-center text-xs font-semibold', on ? 'text-primary' : 'text-muted')}>
                  {c.name}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Food card
// ---------------------------------------------------------------------------
export function FoodCard({
  name, description, priceLabel, imageUrl, categoryName, soldOut = false, canOrder = true, onAdd, count = 0,
}: {
  name: string;
  description?: string | null;
  /** Already formatted, e.g. "45.00 EGP" or "من 45.00 EGP". */
  priceLabel: string;
  imageUrl: string | null;
  /** The item's category, which picks the icon shown when there is no photo. */
  categoryName?: string | null;
  soldOut?: boolean;
  /** False for a read-only menu: the add button is not shown. */
  canOrder?: boolean;
  onAdd?: () => void;
  /** How many of this item are already in the cart, shown on the button. */
  count?: number;
}) {
  return (
    <li className="group flex flex-col overflow-hidden rounded-2xl border border-line bg-elevated shadow-[0_6px_18px_rgb(var(--lb-primary)/0.07)] transition-transform duration-150 active:scale-[0.98]">
      <div className="relative aspect-[16/10] w-full overflow-hidden bg-surface">
        <ImageOrIcon
          src={imageUrl}
          categoryName={categoryName}
          imgClassName={soldOut ? 'opacity-50 grayscale' : undefined}
          placeholderClassName={soldOut ? 'opacity-60' : undefined}
          iconClassName="h-7 w-7"
        />
        {soldOut ? (
          <span className="absolute start-1.5 top-1.5 rounded-full bg-danger px-2 py-0.5 text-[11px] font-bold text-white">نفدت الكمية</span>
        ) : null}
        {canOrder && !soldOut && onAdd ? (
          <button
            type="button"
            onClick={onAdd}
            aria-label={`أضف ${name} للسلة`}
            className="absolute bottom-1.5 end-1.5 flex h-9 min-w-9 items-center justify-center gap-1 rounded-full bg-primary px-2.5 text-sm font-extrabold text-primary-fg shadow-[0_4px_12px_rgb(var(--lb-primary)/0.4)] transition-transform duration-150 hover:scale-105 active:scale-90"
          >
            {count > 0 ? <span key={count} className="lb-numeric animate-pop">{count}</span> : null}
            <Plus className="h-4 w-4" aria-hidden="true" />
          </button>
        ) : null}
      </div>
      <div className="flex flex-1 flex-col gap-0.5 p-2">
        <h3 className="line-clamp-1 text-[13px] font-bold leading-snug text-fg">{name}</h3>
        {description ? <p className="line-clamp-1 text-[11px] text-muted">{description}</p> : null}
        <p className="lb-numeric mt-auto pt-0.5 text-[13px] font-extrabold text-primary">{priceLabel}</p>
      </div>
    </li>
  );
}

/** The grid every category's cards sit in: two columns on a phone. */
export function FoodGrid({ children }: { children: React.ReactNode }) {
  return <ul className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">{children}</ul>;
}

/** A category's titled section, addressable by the rail. */
export function CategorySection({
  id, name, description, children,
}: { id: string; name: string; description?: string | null; children: React.ReactNode }) {
  return (
    <section id={categorySectionId(id)} className="scroll-mt-28 px-4 pt-5">
      <h2 className="text-lg font-extrabold text-fg">{name}</h2>
      {description ? <p className="mb-2 text-sm text-muted">{description}</p> : <div className="mb-2" />}
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Sticky cart bar
// ---------------------------------------------------------------------------
export function CartBar({
  count, totalLabel, onClick, label = 'عرض السلة', perk,
}: {
  count: number;
  totalLabel: string | null;
  onClick: () => void;
  label?: string;
  /** A loyalty line with an optional progress bar (see loyaltyPerk). */
  perk?: { text: string; progress: number | null; reached: boolean } | null;
}) {
  if (count <= 0) return null;
  return (
    <div
      className="fixed inset-x-0 z-30 animate-sheet-up px-4 pt-3"
      // Sits above the 56px bottom nav (StoreBottomNav) and its safe-area inset.
      style={{ bottom: 'calc(56px + env(safe-area-inset-bottom, 0px))', paddingBottom: '10px' }}
    >
      <div className="mx-auto max-w-2xl overflow-hidden rounded-[28px] bg-primary text-primary-fg shadow-[0_10px_30px_rgb(var(--lb-primary)/0.35)]">
        {perk ? (
          <div className="px-5 pt-2.5" data-testid="cart-perk">
            <p className={cn('truncate text-[12px] font-bold', perk.reached ? 'text-primary-fg' : 'opacity-90')}>
              {perk.text}
            </p>
            {perk.progress !== null ? (
              <div
                role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(perk.progress * 100)}
                aria-label="التقدم نحو المكافأة"
                className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/25"
              >
                <div
                  className={cn('h-full rounded-full bg-white transition-[width] duration-500 ease-out', perk.reached && 'animate-pulse')}
                  style={{ width: `${Math.round(perk.progress * 100)}%` }}
                />
              </div>
            ) : null}
          </div>
        ) : null}
        <button
          type="button"
          onClick={onClick}
          data-testid="cart-bar"
          className="flex h-14 w-full items-center gap-3 px-5 transition-transform active:scale-[0.99]"
        >
          <span className="relative flex h-9 w-9 items-center justify-center rounded-full bg-white/20">
            <ShoppingBag className="h-5 w-5" aria-hidden="true" />
            <span key={count} className="lb-numeric absolute -end-1 -top-1 flex h-5 min-w-5 animate-pop items-center justify-center rounded-full bg-bg px-1 text-[11px] font-extrabold text-primary">
              {count}
            </span>
          </span>
          <span className="flex-1 text-start text-base font-bold">{label}</span>
          {totalLabel ? <span className="lb-numeric text-base font-extrabold">{totalLabel}</span> : null}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bottom sheet
// ---------------------------------------------------------------------------
/**
 * A modal bottom sheet: backdrop, Escape and backdrop-tap to close, body scroll
 * locked while open. Rendered only while open, so its inputs and state reset on
 * each opening.
 */
export function BottomSheet({
  title, onClose, children,
}: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex animate-fade-in flex-col justify-end bg-black/45 backdrop-blur-[2px]" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className="mx-auto max-h-[92dvh] w-full max-w-2xl animate-sheet-up overflow-y-auto overscroll-contain rounded-t-[28px] bg-bg px-4 pb-4 pt-2 shadow-[0_-12px_40px_rgba(0,0,0,.25)]"
        style={{ paddingBottom: 'calc(16px + env(safe-area-inset-bottom, 0px))' }}
      >
        <div className="mx-auto mb-2 h-1.5 w-10 rounded-full bg-line" aria-hidden="true" />
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-lg font-extrabold text-fg">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="إغلاق"
            className="flex h-10 w-10 items-center justify-center rounded-full border border-line text-muted"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
