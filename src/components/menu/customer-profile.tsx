'use client';

import { useCallback, useEffect, useState, useTransition } from 'react';
import Link from 'next/link';
import { Gift, MapPin, Receipt, RotateCcw, ShoppingBag, UserRound, UtensilsCrossed } from 'lucide-react';
import { BottomSheet } from '@/components/menu/food-ui';
import { cn } from '@/lib/cn';
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

/** The header button and the bottom nav tell the page's profile sheet to open. */
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

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------
export function ProfileHeaderButton({ className }: { className?: string }) {
  return (
    <button
      type="button"
      onClick={openCustomerProfile}
      aria-label="حسابي"
      data-testid="profile-header-button"
      className={cn(
        'flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-line bg-elevated text-primary transition-transform active:scale-90',
        className,
      )}
    >
      <UserRound className="h-5 w-5" aria-hidden="true" />
    </button>
  );
}

/**
 * Bottom tab bar: menu · cart · my account. The sticky cart bar (when the cart
 * has items) sits just above it.
 */
export function StoreBottomNav({
  cartCount,
  onCart,
  hasActiveOrder = false,
}: {
  cartCount: number;
  onCart: () => void;
  hasActiveOrder?: boolean;
}) {
  const tab =
    'relative flex flex-1 flex-col items-center justify-center gap-0.5 py-1.5 text-[11px] font-semibold text-muted outline-offset-[-2px] transition-colors active:text-primary';
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
        <button type="button" className={tab} onClick={onCart}>
          <span className="relative">
            <ShoppingBag className="h-5 w-5" aria-hidden="true" />
            {cartCount > 0 ? (
              <span className="lb-numeric absolute -end-2 -top-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-extrabold text-primary-fg">
                {cartCount}
              </span>
            ) : null}
          </span>
          السلة
        </button>
        <button type="button" className={tab} onClick={openCustomerProfile} aria-label="حسابي">
          <span className="relative">
            <UserRound className="h-5 w-5" aria-hidden="true" />
            {hasActiveOrder ? (
              <span className="absolute -end-1 -top-0.5 h-2 w-2 rounded-full bg-primary" aria-hidden="true" />
            ) : null}
          </span>
          حسابي
        </button>
      </div>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// The sheet
// ---------------------------------------------------------------------------
const money = (cents: number, currency: string) =>
  `${(cents / 100).toLocaleString('ar-EG', { minimumFractionDigits: 2 })} ${currency}`;

const STATUS_LABEL: Record<string, string> = {
  new: 'تم الاستلام', confirmed: 'تم التأكيد', preparing: 'قيد التحضير', ready: 'جاهز',
  served: 'تم التقديم', completed: 'مكتمل', cancelled: 'ملغي',
};

/** The active-order card's emoji, label and progress (0–3). */
function trackerView(order: ProfileOrder): { emoji: string; label: string; step: number } {
  const delivery = order.type === 'delivery';
  switch (order.status) {
    case 'preparing':
      return { emoji: '👨‍🍳', label: 'جارٍ تحضير طلبك', step: 1 };
    case 'ready':
    case 'served':
      return delivery
        ? { emoji: '🛵', label: 'طلبك في الطريق إليك', step: 2 }
        : { emoji: '🛎️', label: 'طلبك جاهز للاستلام', step: 2 };
    case 'completed':
      return { emoji: '✅', label: 'تم تسليم الطلب', step: 3 };
    default:
      return { emoji: '🧾', label: 'تم استلام طلبك', step: 0 };
  }
}

function ActiveOrderCard({ order, currency }: { order: ProfileOrder; currency: string }) {
  const view = trackerView(order);
  return (
    <div className="rounded-[18px] border border-primary/30 bg-primary-soft p-3.5" data-testid="active-order-card">
      <div className="flex items-center gap-3">
        <span className="text-3xl" aria-hidden="true">{view.emoji}</span>
        <div className="min-w-0 flex-1">
          <p className="font-bold text-fg">{view.label}</p>
          <p className="text-xs text-muted">
            طلب <bdi className="lb-numeric">{order.number}</bdi> · {money(order.totalCents, currency)}
          </p>
        </div>
        {order.token ? (
          <Link href={`/order/track/${order.token}`} className="shrink-0 text-xs font-semibold text-primary underline underline-offset-2">
            تفاصيل
          </Link>
        ) : null}
      </div>
      <ol className="mt-3 flex gap-1" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <li key={i} className={cn('h-1.5 flex-1 rounded-full', i <= view.step ? 'bg-primary' : 'bg-line')} />
        ))}
      </ol>
    </div>
  );
}

function LoyaltyCard({
  profile, onClaim, claiming, claimError,
}: {
  profile: Extract<CustomerProfile, { verified: true }>;
  onClaim: () => void;
  claiming: boolean;
  claimError: string | null;
}) {
  const { loyalty, currency, coupons } = profile;
  if (!loyalty.enabled) return null;
  const pct = Math.min(100, Math.round((loyalty.balance / loyalty.rewardPoints) * 100));
  const canClaim = loyalty.balance >= loyalty.rewardPoints;
  const remaining = Math.max(0, loyalty.rewardPoints - loyalty.balance);
  return (
    <section className="rounded-[18px] bg-primary p-4 text-primary-fg" data-testid="loyalty-card">
      <div className="flex items-center gap-2">
        <Gift className="h-5 w-5" aria-hidden="true" />
        <h3 className="font-bold">نقاط المكافآت</h3>
        <span className="lb-numeric ms-auto text-2xl font-extrabold" data-testid="loyalty-balance">{loyalty.balance}</span>
      </div>
      <div
        role="progressbar" aria-valuemin={0} aria-valuemax={loyalty.rewardPoints} aria-valuenow={Math.min(loyalty.balance, loyalty.rewardPoints)}
        aria-label="التقدم نحو المكافأة"
        className="mt-3 h-2.5 overflow-hidden rounded-full bg-white/25"
      >
        <div className="h-full rounded-full bg-white transition-all" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-2 text-xs opacity-90">
        {canClaim
          ? `يمكنك الآن استبدال ${loyalty.rewardPoints} نقطة بخصم ${money(loyalty.rewardValueCents, currency)}`
          : `باقي ${remaining} نقطة للحصول على خصم ${money(loyalty.rewardValueCents, currency)}`}
      </p>
      {canClaim ? (
        <button
          type="button" onClick={onClaim} disabled={claiming}
          className="mt-3 h-11 w-full rounded-full bg-white text-sm font-extrabold text-primary disabled:opacity-60"
        >
          {claiming ? 'جارٍ الاستبدال…' : 'استبدل النقاط بكوبون'}
        </button>
      ) : null}
      {claimError ? <p className="mt-2 text-xs font-semibold">{claimError}</p> : null}
      {coupons.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {coupons.map((c) => (
            <li key={c.code} className="rounded-[14px] bg-white/15 p-3" data-testid="coupon">
              <div className="flex items-center justify-between gap-2">
                <bdi className="lb-numeric font-mono text-lg font-extrabold tracking-wider">{c.code}</bdi>
                <span className="text-sm font-bold">{money(c.valueCents, currency)}</span>
              </div>
              <p className="text-[11px] opacity-90">
                اعرض الكود للكاشير عند الدفع · صالح حتى {new Date(c.expiresAt).toLocaleDateString('ar-EG')}
              </p>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** The signed-in view of the sheet. Presentational: all data arrives as props. */
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
  const active = verified.orders.filter((o) => (ACTIVE_STATUSES as readonly string[]).includes(o.status));
  const past = verified.orders;
  return (
    <>
            <div className="flex items-center gap-3">
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-primary text-lg font-extrabold text-primary-fg" aria-hidden="true">
                {(verified.name ?? '؟').slice(0, 1)}
              </span>
              <div className="min-w-0">
                <p className="truncate text-lg font-extrabold text-fg">{verified.name ?? 'ضيفنا العزيز'}</p>
                <p dir="ltr" className="lb-numeric text-start text-sm text-muted">{verified.phone}</p>
              </div>
            </div>

            {active.length > 0 ? (
              <section aria-label="طلباتك الحالية" className="space-y-2">
                {active.map((o) => <ActiveOrderCard key={o.number} order={o} currency={verified.currency} />)}
              </section>
            ) : null}

            <LoyaltyCard profile={verified} onClaim={onClaim} claiming={claiming} claimError={claimError} />

            {verified.addresses.length > 0 ? (
              <section className="space-y-2">
                <h3 className="flex items-center gap-1.5 text-sm font-bold text-fg">
                  <MapPin className="h-4 w-4 text-primary" aria-hidden="true" /> عناويني المحفوظة
                </h3>
                <ul className="space-y-2">
                  {verified.addresses.map((a, i) => (
                    <li key={i} className="flex items-center gap-2 rounded-[14px] border border-line bg-elevated p-3" data-testid="saved-address">
                      <div className="min-w-0 flex-1 text-sm">
                        <p className="truncate font-semibold text-fg">{a.address}</p>
                        <p className="truncate text-xs text-muted">{[a.area, a.city, a.landmark].filter(Boolean).join(' · ')}</p>
                      </div>
                      {onUseAddress ? (
                        <button
                          type="button"
                          onClick={() => { onUseAddress(a); onClose(); }}
                          className="shrink-0 rounded-full bg-primary-soft px-3 py-1.5 text-xs font-bold text-primary"
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
              <h3 className="flex items-center gap-1.5 text-sm font-bold text-fg">
                <Receipt className="h-4 w-4 text-primary" aria-hidden="true" /> طلباتي السابقة
              </h3>
              {past.length === 0 ? <p className="text-sm text-muted">لا توجد طلبات بعد.</p> : null}
              <ul className="space-y-2">
                {past.map((o) => (
                  <li key={o.number} className="rounded-[14px] border border-line bg-elevated p-3" data-testid="past-order">
                    <div className="flex items-center justify-between gap-2 text-sm">
                      <span className="font-bold text-fg">
                        <bdi className="lb-numeric">#{o.number}</bdi>
                      </span>
                      <span className="rounded-full bg-primary-soft px-2 py-0.5 text-xs font-semibold text-primary">
                        {STATUS_LABEL[o.status] ?? o.status}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-muted">
                      {new Date(o.placedAt).toLocaleDateString('ar-EG', { day: 'numeric', month: 'long' })} · {money(o.totalCents, verified.currency)}
                    </p>
                    <ul className="mt-2 space-y-0.5 text-xs text-fg">
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
                        className="mt-2.5 flex h-10 w-full items-center justify-center gap-2 rounded-full border border-primary text-sm font-bold text-primary active:scale-[0.98]"
                      >
                        <RotateCcw className="h-4 w-4" aria-hidden="true" /> إعادة الطلب
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

export function CustomerProfileSheet({
  scope,
  onClose,
  onReorder,
  onUseAddress,
  onActiveOrders,
}: {
  scope: ProfileScope;
  onClose: () => void;
  /** Adds the lines to the cart; returns how many were added and skipped. */
  onReorder: (lines: ReorderLine[]) => { added: number; skipped: number };
  /** Storefront only: copies a saved address into the delivery form. */
  onUseAddress?: (a: ProfileAddress) => void;
  onActiveOrders?: (count: number) => void;
}) {
  const [phone, setPhone] = useState('');
  const [typed, setTyped] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [profile, setProfile] = useState<CustomerProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
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
        onActiveOrders?.(res.data.orders.filter((o) => (ACTIVE_STATUSES as readonly string[]).includes(o.status)).length);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scope],
  );

  useEffect(() => {
    const device = getDeviceId();
    setDeviceId(device);
    let saved = '';
    try { saved = localStorage.getItem('lb-guest-phone') ?? ''; } catch { /* no storage */ }
    setPhone(saved);
    if (saved.trim().length >= 6) void load(device, saved.trim());
    else setLoading(false);
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
    void load(deviceId, n);
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
    });
  }

  function reorder(order: ProfileOrder) {
    const { added, skipped } = onReorder(order.items);
    if (added === 0) {
      setNotice('الأصناف دي مش متاحة حاليًا.');
      return;
    }
    onClose();
    // The caller opens the cart; the notice only matters if the sheet stays.
    void skipped;
  }

  const verified = profile && profile.verified ? profile : null;

  return (
    <BottomSheet title="حسابي" onClose={onClose}>
      <div className="space-y-4" data-testid="customer-profile">
        {loading ? <p className="py-8 text-center text-sm text-muted" role="status">جارٍ التحميل…</p> : null}

        {!loading && !verified ? (
          <div className="space-y-3 py-2 text-center">
            <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-primary-soft text-primary">
              <UserRound className="h-7 w-7" aria-hidden="true" />
            </span>
            <p className="text-sm font-semibold text-fg">لا توجد بيانات لهذا الجهاز بعد</p>
            <p className="text-xs text-muted">
              اطلب أول طلب وأكّد رقمك عبر واتساب، وسيظهر هنا سجل طلباتك وعناوينك ونقاطك.
              لحمايتك لا يُعرض شيء إلا على جهاز تم تأكيده لهذا الرقم.
            </p>
            <form onSubmit={lookUp} className="flex gap-2">
              <input
                type="tel" inputMode="tel" dir="ltr" value={typed} onChange={(e) => setTyped(e.target.value)}
                placeholder="رقم الهاتف" aria-label="رقم الهاتف"
                className="h-12 min-w-0 flex-1 rounded-[14px] border border-line bg-elevated px-3.5 text-base text-fg focus:border-primary focus:outline-none"
              />
              <button type="submit" className="h-12 shrink-0 rounded-[14px] bg-primary px-4 text-sm font-bold text-primary-fg">
                عرض
              </button>
            </form>
            {error ? <p className="text-xs text-danger">{error}</p> : null}
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
