'use client';

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { Check, Copy, Gift, MapPin, Receipt, RotateCcw, Search, ShoppingBag, UserRound, UtensilsCrossed } from 'lucide-react';
import { BottomSheet } from '@/components/menu/food-ui';
import { LiquidLink } from '@/components/menu/liquid';
import { focusMenuSearch } from '@/components/menu/menu-filter-bar';
import { showStoreToast } from '@/components/menu/store-toast';
import { cn } from '@/lib/cn';
import { formatPrice } from '@/lib/price';
import { getDeviceId } from '@/modules/restaurant/guest-verification/device';
import {
  ACTIVE_STATUSES,
  type CustomerProfile,
  type ProfileAddress,
  type ProfileOrder,
  type ProfileScope,
  type ReorderLine,
} from '@/modules/restaurant/customer/types';
import { claimRewardAction, getCustomerProfileAction } from '@/app/(public)/profile-actions';

// ---------------------------------------------------------------------------
// Page-level plumbing: opening the sheet, and knowing whether an order is live
// ---------------------------------------------------------------------------
const OPEN_EVENT = 'lb-open-profile';
export function openCustomerProfile() {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT));
}

/** Controls a profile sheet from anywhere on the page (header, bottom nav). */
export function useProfileSheet() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const on = () => setOpen(true);
    window.addEventListener(OPEN_EVENT, on);
    return () => window.removeEventListener(OPEN_EVENT, on);
  }, []);
  return { open, setOpen };
}

const ACTIVE_EVENT = 'lb-active-orders';
let lastActiveCount = 0;
function publishActiveOrders(count: number) {
  lastActiveCount = count;
  window.dispatchEvent(new CustomEvent(ACTIVE_EVENT, { detail: count }));
}

const isActive = (status: string) => (ACTIVE_STATUSES as readonly string[]).includes(status);

/** True while this guest has an order in progress (drives the header/nav dot). */
export function useActiveOrderDot(): boolean {
  const [count, setCount] = useState(0);
  useEffect(() => {
    setCount(lastActiveCount);
    const on = (e: Event) => setCount((e as CustomEvent<number>).detail);
    window.addEventListener(ACTIVE_EVENT, on);
    return () => window.removeEventListener(ACTIVE_EVENT, on);
  }, []);
  return count > 0;
}

/**
 * Quietly loads the profile of a returning guest (their device + saved phone)
 * so the page knows — before the sheet is ever opened — whether an order is
 * live and what their points balance is. Refreshes every 30 s while the tab is
 * visible, and shortly after a new order is placed.
 */
export function useGuestSnapshot(scope: ProfileScope) {
  const [profile, setProfile] = useState<CustomerProfile | null>(null);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const scopeKey = JSON.stringify(scope);

  const refresh = useCallback(async () => {
    let phone = '';
    try { phone = localStorage.getItem('lb-guest-phone') ?? ''; } catch { /* no storage */ }
    if (phone.trim().length < 6) return;
    const res = await getCustomerProfileAction({ scope: scopeRef.current, deviceId: getDeviceId(), phone: phone.trim() });
    if (!res.ok) return;
    setProfile(res.data);
    if (res.data.verified) publishActiveOrders(res.data.orders.filter((o) => isActive(o.status)).length);
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 30_000);
    // A freshly placed order shows up in the profile once the server has it.
    let late: ReturnType<typeof setTimeout> | undefined;
    const onPlaced = () => { clearTimeout(late); late = setTimeout(() => void refresh(), 2500); };
    window.addEventListener('lb-active-order', onPlaced);
    return () => {
      clearInterval(timer);
      clearTimeout(late);
      window.removeEventListener('lb-active-order', onPlaced);
    };
    // scopeKey: a different store is a different snapshot.
  }, [refresh, scopeKey]);

  return { profile, refresh };
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------
function ActiveDot({ className }: { className?: string }) {
  return (
    <span className={cn('absolute flex h-2.5 w-2.5', className)} aria-hidden="true" data-testid="active-order-dot">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-60" />
      <span className="relative inline-flex h-2.5 w-2.5 rounded-full border-2 border-bg bg-primary" />
    </span>
  );
}

export function ProfileHeaderButton({ className }: { className?: string }) {
  const live = useActiveOrderDot();
  return (
    <button
      type="button"
      onClick={openCustomerProfile}
      aria-label={live ? 'حسابي — لديك طلب قيد التنفيذ' : 'حسابي'}
      data-testid="profile-header-button"
      className={cn(
        'relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-line bg-elevated text-primary shadow-sm transition-transform duration-150 hover:scale-105 active:scale-90',
        className,
      )}
    >
      <UserRound className="h-5 w-5" aria-hidden="true" />
      {live ? <ActiveDot className="-end-0.5 -top-0.5" /> : null}
    </button>
  );
}

/**
 * Bottom tab bar: menu · cart · my account. The sticky cart bar (when the cart
 * has items) sits just above it.
 */
export function StoreBottomNav({ cartCount, onCart }: { cartCount: number; onCart: () => void }) {
  const live = useActiveOrderDot();
  const tab =
    'relative flex flex-1 flex-col items-center justify-center gap-0.5 py-1.5 text-[11px] font-semibold text-muted outline-offset-[-2px] transition-all duration-150 active:scale-90 active:text-primary';
  return (
    <nav
      aria-label="التنقل"
      data-testid="store-bottom-nav"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-elevated/95 backdrop-blur"
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
    >
      <div className="mx-auto flex h-14 max-w-2xl">
        <button type="button" className={tab} onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>
          <UtensilsCrossed className="h-5 w-5" aria-hidden="true" />
          القائمة
        </button>
        <button type="button" className={tab} onClick={focusMenuSearch}>
          <Search className="h-5 w-5" aria-hidden="true" />
          بحث
        </button>
        <button type="button" className={tab} onClick={onCart}>
          <span className="relative">
            <ShoppingBag className="h-5 w-5" aria-hidden="true" />
            {cartCount > 0 ? (
              <span key={cartCount} className="lb-numeric absolute -end-2 -top-2 flex h-4 min-w-4 animate-pop items-center justify-center rounded-full bg-primary px-1 text-[10px] font-extrabold text-primary-fg">
                {cartCount}
              </span>
            ) : null}
          </span>
          السلة
        </button>
        <button type="button" className={tab} onClick={openCustomerProfile} aria-label={live ? 'حسابي — لديك طلب قيد التنفيذ' : 'حسابي'}>
          <span className="relative">
            <UserRound className="h-5 w-5" aria-hidden="true" />
            {live ? <ActiveDot className="-end-1.5 -top-1" /> : null}
          </span>
          حسابي
        </button>
      </div>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Small motion helpers
// ---------------------------------------------------------------------------
const reducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Counts up to `target` once on mount (and again if it changes). */
function useCountUp(target: number, ms = 700) {
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (reducedMotion() || target === 0) { setValue(target); return; }
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / ms);
      setValue(Math.round(target * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return value;
}

/** 0 on first paint, then `pct` — so a bar animates in instead of appearing. */
function useGrowIn(pct: number) {
  const [w, setW] = useState(0);
  useEffect(() => {
    const id = requestAnimationFrame(() => setW(pct));
    return () => cancelAnimationFrame(id);
  }, [pct]);
  return w;
}

function useCopy() {
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const copy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Older webviews: fall back to a hidden textarea.
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch { /* nothing more to try */ }
      document.body.removeChild(ta);
    }
    setCopied(text);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(null), 2000);
  }, []);
  return { copied, copy };
}

/** A price kept in one piece inside right-to-left text ("20 EGP", not "EGP 20"). */
function Money({ cents, currency }: { cents: number; currency: string }) {
  return <bdi className="lb-numeric">{formatPrice(cents, currency)}</bdi>;
}

// ---------------------------------------------------------------------------
// Active order tracker
// ---------------------------------------------------------------------------
const STATUS_LABEL: Record<string, string> = {
  new: 'تم الاستلام', confirmed: 'تم التأكيد', preparing: 'قيد التحضير', ready: 'جاهز',
  served: 'تم التقديم', completed: 'مكتمل', cancelled: 'ملغي',
};

function trackerStages(delivery: boolean) {
  return [
    { emoji: '🧾', label: 'تم الاستلام', headline: 'تم استلام طلبك' },
    { emoji: '👨‍🍳', label: 'التحضير', headline: 'جارٍ تحضير طلبك' },
    delivery
      ? { emoji: '🛵', label: 'في الطريق', headline: 'طلبك في الطريق إليك' }
      : { emoji: '🛎️', label: 'جاهز', headline: 'طلبك جاهز للاستلام' },
    { emoji: '✅', label: 'تم التسليم', headline: 'تم تسليم الطلب' },
  ] as const;
}

function stepOf(status: string): number {
  switch (status) {
    case 'preparing': return 1;
    case 'ready':
    case 'served': return 2;
    case 'completed': return 3;
    default: return 0;
  }
}

function ActiveOrderCard({ order, currency }: { order: ProfileOrder; currency: string }) {
  const stages = trackerStages(order.type === 'delivery');
  const step = stepOf(order.status);
  const current = stages[step]!;
  return (
    <div
      className="overflow-hidden rounded-[22px] border border-primary/25 bg-gradient-to-b from-primary-soft to-elevated p-4 shadow-[0_8px_24px_rgb(var(--lb-primary)/0.12)]"
      data-testid="active-order-card"
    >
      <div className="flex items-center gap-3">
        <span className="relative flex h-14 w-14 shrink-0 items-center justify-center" aria-hidden="true">
          <span className="absolute inset-0 animate-ping rounded-full bg-primary/25" />
          <span className="relative flex h-14 w-14 items-center justify-center rounded-full bg-elevated text-3xl shadow-sm">
            {current.emoji}
          </span>
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[17px] font-extrabold leading-snug text-fg" role="status">{current.headline}</p>
          <p className="text-xs text-muted">
            طلب <bdi className="lb-numeric">#{order.number}</bdi> · <Money cents={order.totalCents} currency={currency} />
          </p>
        </div>
        {order.token ? (
          <LiquidLink
            href={`/order/track/${order.token}`}
            className="shrink-0 rounded-full border border-primary/40 px-3 py-1.5 text-xs font-bold text-primary active:scale-95"
          >
            تفاصيل
          </LiquidLink>
        ) : null}
      </div>

      <ol className="mt-4 flex items-start" aria-label="مراحل الطلب">
        {stages.map((st, i) => {
          const done = i < step;
          const now = i === step;
          return (
            <li key={st.label} className="flex flex-1 items-start last:flex-none" aria-current={now ? 'step' : undefined}>
              <div className="flex w-14 flex-col items-center gap-1">
                <span
                  className={cn(
                    'relative flex h-8 w-8 items-center justify-center rounded-full text-sm transition-colors duration-500',
                    done && 'bg-primary text-primary-fg',
                    now && 'bg-primary text-primary-fg ring-4 ring-primary/25',
                    !done && !now && 'bg-line text-muted',
                  )}
                >
                  {now ? <span className="absolute inset-0 animate-ping rounded-full bg-primary/40" aria-hidden="true" /> : null}
                  <span className="relative">{done ? <Check className="h-4 w-4" aria-hidden="true" /> : st.emoji}</span>
                </span>
                <span className={cn('text-center text-[10px] font-semibold leading-tight', now ? 'text-primary' : 'text-muted')}>
                  {st.label}
                </span>
              </div>
              {i < stages.length - 1 ? (
                <span className="mt-[15px] h-1 flex-1 overflow-hidden rounded-full bg-line" aria-hidden="true">
                  <span
                    className="block h-full rounded-full bg-primary transition-[width] duration-700 ease-out"
                    style={{ width: done ? '100%' : '0%' }}
                  />
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loyalty
// ---------------------------------------------------------------------------
function LoyaltyCard({
  profile, onClaim, claiming, claimError,
}: {
  profile: Extract<CustomerProfile, { verified: true }>;
  onClaim: () => void;
  claiming: boolean;
  claimError: string | null;
}) {
  const { loyalty, currency, coupons } = profile;
  const { copied, copy } = useCopy();
  const pct = Math.min(100, Math.round((loyalty.balance / loyalty.rewardPoints) * 100));
  const width = useGrowIn(pct);
  const shown = useCountUp(loyalty.balance);
  if (!loyalty.enabled) return null;
  const canClaim = loyalty.balance >= loyalty.rewardPoints;
  const remaining = Math.max(0, loyalty.rewardPoints - loyalty.balance);
  const newest = coupons[0];

  return (
    <section
      className="relative overflow-hidden rounded-[22px] bg-gradient-to-br from-primary via-primary to-primary/70 p-4 text-primary-fg shadow-[0_12px_28px_rgb(var(--lb-primary)/0.3)]"
      data-testid="loyalty-card"
    >
      <span className="pointer-events-none absolute -end-10 -top-10 h-32 w-32 rounded-full bg-white/10" aria-hidden="true" />
      <span className="pointer-events-none absolute -bottom-12 start-6 h-28 w-28 rounded-full bg-white/10" aria-hidden="true" />

      <div className="relative flex items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-1.5 text-xs font-bold opacity-90">
            <Gift className="h-4 w-4" aria-hidden="true" /> نقاط المكافآت
          </p>
          <p className="lb-numeric text-[44px] font-extrabold leading-none" data-testid="loyalty-balance">{shown}</p>
        </div>
        {newest ? (
          <button
            type="button"
            onClick={() => void copy(newest.code)}
            data-testid="copy-coupon"
            className="flex h-10 items-center gap-1.5 rounded-full bg-white px-3.5 text-xs font-extrabold text-primary shadow-sm transition-transform active:scale-95"
          >
            {copied === newest.code ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
            {copied === newest.code ? 'تم النسخ' : 'نسخ الكوبون'}
          </button>
        ) : null}
      </div>

      <div className="relative mt-4">
        <div
          role="progressbar" aria-valuemin={0} aria-valuemax={loyalty.rewardPoints}
          aria-valuenow={Math.min(loyalty.balance, loyalty.rewardPoints)} aria-label="التقدم نحو المكافأة"
          className="h-3 overflow-hidden rounded-full bg-white/25"
        >
          <div
            className={cn('h-full rounded-full bg-white transition-[width] duration-[900ms] ease-out', canClaim && 'animate-pulse')}
            style={{ width: `${width}%` }}
          />
        </div>
        <div className="lb-numeric mt-1 flex justify-between text-[11px] font-semibold opacity-80" aria-hidden="true">
          <span>0</span>
          <span>{loyalty.rewardPoints}</span>
        </div>
        <p className="mt-1 text-sm font-bold">
          {canClaim ? (
            <>🎉 يمكنك استبدال <bdi className="lb-numeric">{loyalty.rewardPoints}</bdi> نقطة بخصم <Money cents={loyalty.rewardValueCents} currency={currency} /></>
          ) : (
            <>باقي <bdi className="lb-numeric">{remaining}</bdi> نقطة للحصول على خصم <Money cents={loyalty.rewardValueCents} currency={currency} /></>
          )}
        </p>
      </div>

      {canClaim ? (
        <button
          type="button" onClick={onClaim} disabled={claiming}
          className="relative mt-3 h-12 w-full rounded-full bg-white text-sm font-extrabold text-primary shadow-sm transition-transform active:scale-[0.98] disabled:opacity-60"
        >
          {claiming ? 'جارٍ الاستبدال…' : '🎁 استبدل النقاط بكوبون'}
        </button>
      ) : null}
      {claimError ? <p className="relative mt-2 text-xs font-semibold" role="alert">{claimError}</p> : null}

      {coupons.length > 0 ? (
        <ul className="relative mt-3 space-y-2">
          {coupons.map((c) => (
            <li key={c.code} className="flex items-center gap-3 rounded-2xl border border-dashed border-white/50 bg-white/15 p-3" data-testid="coupon">
              <div className="min-w-0 flex-1">
                <bdi className="lb-numeric block font-mono text-lg font-extrabold tracking-wider">{c.code}</bdi>
                <p className="text-[11px] opacity-90">
                  خصم <Money cents={c.valueCents} currency={currency} /> · صالح حتى {new Date(c.expiresAt).toLocaleDateString('ar-EG')}
                </p>
              </div>
              <button
                type="button" onClick={() => void copy(c.code)}
                aria-label={`نسخ الكود ${c.code}`}
                className="flex h-9 shrink-0 items-center gap-1 rounded-full bg-white/25 px-3 text-xs font-bold active:scale-95"
              >
                {copied === c.code ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
                {copied === c.code ? 'تم' : 'نسخ'}
              </button>
            </li>
          ))}
          <li className="text-center text-[11px] opacity-90">اعرض الكود للكاشير عند الدفع</li>
        </ul>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// The signed-in view of the sheet (presentational: all data arrives as props)
// ---------------------------------------------------------------------------
export function ProfileContent({
  profile: verified,
  onReorder,
  onUseAddress,
  onClose,
  onClaim,
  claiming,
  claimError,
  notice,
}: {
  profile: Extract<CustomerProfile, { verified: true }>;
  onReorder: (order: ProfileOrder) => void;
  onUseAddress?: (a: ProfileAddress) => void;
  onClose: () => void;
  onClaim: () => void;
  claiming: boolean;
  claimError: string | null;
  notice: string | null;
}) {
  const active = verified.orders.filter((o) => isActive(o.status));
  const past = verified.orders;
  return (
    <>
      <div className="flex items-center gap-3">
        <span className="flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br from-primary to-primary/70 text-xl font-extrabold text-primary-fg shadow-sm" aria-hidden="true">
          {(verified.name ?? '؟').slice(0, 1)}
        </span>
        <div className="min-w-0">
          <p className="truncate text-xl font-extrabold text-fg">{verified.name ?? 'ضيفنا العزيز'}</p>
          <p dir="ltr" className="lb-numeric text-start text-sm text-muted">{verified.phone}</p>
        </div>
      </div>

      {active.length > 0 ? (
        <section aria-label="طلباتك الحالية" className="space-y-3">
          {active.map((o) => <ActiveOrderCard key={o.number} order={o} currency={verified.currency} />)}
        </section>
      ) : null}

      <LoyaltyCard profile={verified} onClaim={onClaim} claiming={claiming} claimError={claimError} />

      {verified.addresses.length > 0 ? (
        <section className="space-y-2">
          <h3 className="flex items-center gap-1.5 text-sm font-extrabold text-fg">
            <MapPin className="h-4 w-4 text-primary" aria-hidden="true" /> عناويني المحفوظة
          </h3>
          <ul className="space-y-2">
            {verified.addresses.map((a, i) => (
              <li key={i} className="flex items-center gap-3 rounded-2xl border border-line bg-elevated p-3" data-testid="saved-address">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary" aria-hidden="true">
                  <MapPin className="h-5 w-5" />
                </span>
                <div className="min-w-0 flex-1 text-sm">
                  <p className="truncate font-bold text-fg">{a.address}</p>
                  <p className="truncate text-xs text-muted">{[a.area, a.city, a.landmark].filter(Boolean).join(' · ')}</p>
                </div>
                {onUseAddress ? (
                  <button
                    type="button"
                    onClick={() => { onUseAddress(a); onClose(); }}
                    className="shrink-0 rounded-full bg-primary-soft px-3.5 py-2 text-xs font-extrabold text-primary active:scale-95"
                  >
                    استخدم
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="space-y-2">
        <h3 className="flex items-center gap-1.5 text-sm font-extrabold text-fg">
          <Receipt className="h-4 w-4 text-primary" aria-hidden="true" /> طلباتي السابقة
        </h3>
        {past.length === 0 ? <p className="text-sm text-muted">لا توجد طلبات بعد.</p> : null}
        <ul className="space-y-3">
          {past.map((o) => (
            <li key={o.number} className="rounded-2xl border border-line bg-elevated p-3.5" data-testid="past-order">
              <div className="flex items-center justify-between gap-2 text-sm">
                <span className="font-extrabold text-fg"><bdi className="lb-numeric">#{o.number}</bdi></span>
                <span className={cn(
                  'rounded-full px-2.5 py-0.5 text-xs font-bold',
                  o.status === 'cancelled' ? 'bg-danger/10 text-danger' : 'bg-primary-soft text-primary',
                )}>
                  {STATUS_LABEL[o.status] ?? o.status}
                </span>
              </div>
              <p className="mt-0.5 text-xs text-muted">
                {new Date(o.placedAt).toLocaleDateString('ar-EG', { day: 'numeric', month: 'long' })} · <Money cents={o.totalCents} currency={verified.currency} />
              </p>
              <ul className="mt-2 space-y-0.5 text-[13px] text-fg">
                {o.items.map((it, i) => (
                  <li key={i}>
                    <span className="lb-numeric text-muted">{it.quantity}×</span> {it.productName}
                    {it.variantName !== 'default' ? ` — ${it.variantName}` : ''}
                  </li>
                ))}
              </ul>
              {o.items.length > 0 && o.status !== 'cancelled' ? (
                <button
                  type="button" onClick={() => onReorder(o)}
                  data-testid="reorder"
                  className="mt-3 flex h-12 w-full items-center justify-center gap-2 rounded-full bg-primary text-[15px] font-extrabold text-primary-fg shadow-[0_6px_16px_rgb(var(--lb-primary)/0.35)] transition-transform duration-150 hover:brightness-110 active:scale-[0.97]"
                >
                  <RotateCcw className="h-[18px] w-[18px]" aria-hidden="true" /> إعادة الطلب
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
      {notice ? <p className="text-center text-sm font-semibold text-danger" role="status">{notice}</p> : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// The sheet
// ---------------------------------------------------------------------------
export function CustomerProfileSheet({
  scope,
  initial,
  onClose,
  onReorder,
  onOpenCart,
  onUseAddress,
}: {
  scope: ProfileScope;
  /** What the page already knows (useGuestSnapshot): painted instantly. */
  initial?: CustomerProfile | null;
  onClose: () => void;
  /** Adds the lines to the cart; returns how many were added and skipped. */
  onReorder: (lines: ReorderLine[]) => { added: number; skipped: number };
  /** The toast's "view cart" action. */
  onOpenCart: () => void;
  /** Storefront only: copies a saved address into the delivery form. */
  onUseAddress?: (a: ProfileAddress) => void;
}) {
  const [phone, setPhone] = useState('');
  const [typed, setTyped] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [profile, setProfile] = useState<CustomerProfile | null>(initial ?? null);
  const [loading, setLoading] = useState(!initial);
  const [error, setError] = useState<string | null>(null);
  // True once the guest has typed a number and we looked it up.
  const [attempted, setAttempted] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [claiming, startClaim] = useTransition();

  const load = useCallback(
    async (device: string, number: string, quiet = false) => {
      if (!quiet) setLoading(true);
      const res = await getCustomerProfileAction({ scope, deviceId: device, phone: number });
      if (!quiet) setLoading(false);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setError(null);
      setProfile(res.data);
      if (res.data.verified) {
        try { localStorage.setItem('lb-guest-phone', number); } catch { /* best effort */ }
        publishActiveOrders(res.data.orders.filter((o) => isActive(o.status)).length);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(scope)],
  );

  useEffect(() => {
    const device = getDeviceId();
    setDeviceId(device);
    let saved = '';
    try { saved = localStorage.getItem('lb-guest-phone') ?? ''; } catch { /* no storage */ }
    setPhone(saved);
    if (saved.trim().length >= 6) void load(device, saved.trim(), Boolean(initial));
    else setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  // Keep an open sheet fresh: an order's status moves while the guest looks.
  useEffect(() => {
    if (!deviceId || !phone || !(profile && profile.verified)) return;
    const t = setInterval(() => void load(deviceId, phone, true), 15_000);
    return () => clearInterval(t);
  }, [deviceId, phone, profile, load]);

  function lookUp(e: React.FormEvent) {
    e.preventDefault();
    const n = typed.trim();
    if (n.length < 6) return;
    setPhone(n);
    setAttempted(true);
    void load(deviceId, n);
  }

  function retry() {
    const n = (phone || typed).trim();
    if (n.length >= 6) void load(deviceId, n);
  }

  function claim() {
    setClaimError(null);
    startClaim(async () => {
      const res = await claimRewardAction({ scope, deviceId, phone });
      if (!res.ok) {
        setClaimError(res.error);
        return;
      }
      await load(deviceId, phone, true);
      showStoreToast({ message: `🎁 كوبونك ${res.data.code} جاهز` });
    });
  }

  function reorder(order: ProfileOrder) {
    const { added, skipped } = onReorder(order.items);
    if (added === 0) {
      setNotice('الأصناف دي مش متاحة حاليًا.');
      return;
    }
    onClose();
    showStoreToast({
      message:
        `تمت إضافة ${added} ${added === 1 ? 'صنف' : 'أصناف'} إلى السلة` +
        (skipped > 0 ? ` (${skipped} غير متاح)` : ''),
      actionLabel: 'عرض السلة',
      onAction: onOpenCart,
    });
  }

  const verified = profile && profile.verified ? profile : null;

  return (
    <BottomSheet title="حسابي" onClose={onClose}>
      <div className="space-y-5" data-testid="customer-profile">
        {loading ? (
          <div className="space-y-3 py-2" role="status" aria-label="جارٍ التحميل">
            <div className="h-14 animate-pulse rounded-2xl bg-line/60" />
            <div className="h-32 animate-pulse rounded-[22px] bg-line/60" />
            <div className="h-24 animate-pulse rounded-2xl bg-line/60" />
          </div>
        ) : null}

        {!loading && !verified ? (
          <div className="space-y-3 py-2 text-center">
            <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-primary-soft text-primary">
              <UserRound className="h-8 w-8" aria-hidden="true" />
            </span>
            <p className="text-base font-extrabold text-fg">لا توجد بيانات لهذا الجهاز بعد</p>
            <p className="text-xs leading-relaxed text-muted">
              اطلب أول طلب وأكّد رقمك عبر واتساب، وسيظهر هنا سجل طلباتك وعناوينك ونقاطك.
              لحمايتك لا يُعرض شيء إلا على جهاز تم تأكيده لهذا الرقم.
            </p>
            {profile && !profile.verified && profile.unavailable ? (
              <div className="rounded-2xl bg-primary-soft p-3 text-sm text-fg" role="status" data-testid="profile-unavailable">
                <p className="font-semibold">تعذّر تحميل حسابك الآن.</p>
                <p className="text-xs text-muted">لا تقلق، طلباتك محفوظة. حاول مرة أخرى بعد قليل.</p>
                <button type="button" onClick={retry} className="mt-2 rounded-full bg-primary px-4 py-1.5 text-xs font-extrabold text-primary-fg active:scale-95">
                  إعادة المحاولة
                </button>
              </div>
            ) : attempted && !loading && !error ? (
              <p className="rounded-2xl bg-primary-soft p-3 text-sm font-semibold text-fg" role="status" data-testid="profile-not-found">
                لم نجد طلبات مؤكدة لهذا الرقم على هذا الجهاز. إذا طلبت من جهاز آخر، أكّد رقمك عبر واتساب عند أول طلب هنا.
              </p>
            ) : null}
            <form onSubmit={lookUp} className="flex gap-2">
              <input
                type="tel" inputMode="tel" dir="ltr" value={typed} onChange={(e) => setTyped(e.target.value)}
                placeholder="رقم الهاتف" aria-label="رقم الهاتف"
                className="h-12 min-w-0 flex-1 rounded-[14px] border border-line bg-elevated px-3.5 text-base text-fg focus:border-primary focus:outline-none"
              />
              <button type="submit" className="h-12 shrink-0 rounded-[14px] bg-primary px-5 text-sm font-extrabold text-primary-fg active:scale-95">
                عرض
              </button>
            </form>
            {error ? <p className="text-xs text-danger" role="alert">{error}</p> : null}
          </div>
        ) : null}

        {verified ? (
          <ProfileContent
            profile={verified}
            onReorder={reorder}
            onUseAddress={onUseAddress}
            onClose={onClose}
            onClaim={claim}
            claiming={claiming}
            claimError={claimError}
            notice={notice}
          />
        ) : null}
      </div>
    </BottomSheet>
  );
}
