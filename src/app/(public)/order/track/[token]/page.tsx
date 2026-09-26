import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { getOrderByToken } from '@/modules/restaurant/online/service';
import { lavechiCssVars, LAVECHI_CARD_SHADOW } from '@/modules/restaurant/website/lavechi-theme';
import { LavechiShell } from '../../../r/[orgSlug]/parts';
import { EditWindow } from './track';
import { OrderProgress } from './order-progress';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'متابعة الطلب',
  robots: { index: false, follow: false },
};

function money(cents: number, currency: string) {
  return `${(cents / 100).toLocaleString('ar-EG', { minimumFractionDigits: 2 })} ${currency}`;
}

/**
 * Follow one order, by token.
 *
 * The token is the whole authorization: it resolves server-side to exactly one
 * order and there is no id in the request to substitute. An unknown or revoked
 * token is not found — indistinguishable from one that never existed.
 */
export default async function TrackPage({ params }: { params: { token: string } }) {
  const order = await getOrderByToken(params.token);
  if (!order) notFound();

  return (
    <LavechiShell>
      <div
        className="mx-auto min-h-dvh max-w-lg bg-[radial-gradient(circle_at_50%_18%,#0C3624,#07231A_60%)] px-4 py-10 text-[#F4F1E4] sm:px-6"
        style={lavechiCssVars() as React.CSSProperties}
      >
      <p className="text-sm text-muted">طلب رقم</p>
      <h1 className="mb-4 font-reem text-2xl font-normal tracking-wide text-fg" dir="ltr">{order.number}</h1>

      <div className="mb-6">
        <OrderProgress token={params.token} initialStatus={order.status} />
      </div>

      {order.status === 'new' ? (
        <div className="mb-6">
          <EditWindow token={params.token} canEdit={order.canEdit} secondsLeft={order.secondsLeft} />
        </div>
      ) : null}

      <div className="rounded-[18px] border border-line bg-elevated p-4" style={{ boxShadow: LAVECHI_CARD_SHADOW }}>
        <ul className="space-y-2 border-b border-line pb-3 text-sm">
          {order.items.map((i, idx) => (
            <li key={idx} className="flex justify-between gap-3">
              <span className="text-fg">
                {i.productName}
                {i.variantName !== 'default' ? ` — ${i.variantName}` : ''}
                <span className="text-muted"> ×{i.quantity}</span>
              </span>
              <span className="text-muted">{money(i.lineTotalCents, order.currency)}</span>
            </li>
          ))}
        </ul>
        <div className="mt-3 space-y-1 text-sm">
          <div className="flex justify-between text-muted">
            <span>الإجمالي الفرعي</span><span>{money(order.subtotalCents, order.currency)}</span>
          </div>
          {order.deliveryFeeCents > 0 ? (
            <div className="flex justify-between text-muted">
              <span>التوصيل</span><span>{money(order.deliveryFeeCents, order.currency)}</span>
            </div>
          ) : null}
          <div className="flex justify-between border-t border-line pt-1 text-base font-extrabold text-fg">
            <span>الإجمالي</span>
            <span data-testid="order-total">{money(order.totalCents, order.currency)}</span>
          </div>
        </div>
      </div>

      <p className="mt-4 text-center text-xs text-muted">
        {order.type === 'dine_in' ? 'الدفع عند الكاشير أو مع الكابتن.' : 'الدفع نقدًا عند الاستلام.'}
      </p>

      {/* Optional, and offered after the order is already placed: an account
          is a convenience, never a step on the way to ordering. The link
          carries the token this page was reached with, which is what
          authorises attaching the order — nothing else would. */}
      <div className="mt-6 rounded-lg border border-line bg-surface p-4 text-center">
        <p className="text-sm font-semibold text-fg">أنشئ حسابًا لحفظ طلباتك وعناوينك</p>
        <p className="mt-1 text-xs text-muted">اختياري — طلبك مسجّل بالفعل.</p>
        <Link
          href={`/account/join?token=${encodeURIComponent(params.token)}`}
          className="mt-3 inline-flex h-11 items-center rounded bg-primary px-4 text-sm font-semibold text-primary-fg"
        >
          إنشاء حساب
        </Link>
      </div>
      </div>
    </LavechiShell>
  );
}
