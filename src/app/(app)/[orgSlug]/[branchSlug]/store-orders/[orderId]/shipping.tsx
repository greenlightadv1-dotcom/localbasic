import type { TenantContext } from '@/modules/core/tenancy/context';
import { can } from '@/modules/core/tenancy/context';
import {
  listProviders, listShipments, SHIPMENT_STATUS_LABELS, type ShipmentStatus,
} from '@/modules/retail/shipping/service';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Money } from '@/components/patterns/money';
import { CreateShipment, PayShipment, ShipmentStatusButtons } from './shipping-forms';

const TONE: Record<ShipmentStatus, 'neutral' | 'info' | 'success' | 'danger' | 'warn'> = {
  pending: 'warn',
  dispatched: 'info',
  delivered: 'success',
  failed: 'danger',
  cancelled: 'neutral',
};

/**
 * Shipping for one order.
 *
 * Every attempt is listed, including the failed ones — a parcel's history is
 * what a customer asks about when something goes wrong, and overwriting it
 * with the retry would lose exactly that.
 */
export async function OrderShipping({
  ctx,
  orderId,
  orgSlug,
  branchSlug,
}: {
  ctx: TenantContext;
  orderId: string;
  orgSlug: string;
  branchSlug: string;
}) {
  const [shipments, providers] = await Promise.all([
    listShipments(ctx, orderId),
    listProviders(ctx),
  ]);

  const canManage = can(ctx, 'retail.order.manage');
  const canPay = canManage && can(ctx, 'treasury.create');
  const inFlight = shipments.some((s) => s.status === 'pending' || s.status === 'dispatched');

  return (
    <Card>
      <CardHeader>
        <CardTitle>الشحن</CardTitle>
      </CardHeader>
      <CardBody className="space-y-4">
        {shipments.length === 0 ? (
          <p className="text-sm text-muted">لم تُرسل شحنة بعد.</p>
        ) : (
          <ul className="space-y-3" data-testid="shipment-list">
            {shipments.map((s) => (
              <li key={s.id} className="rounded border border-line p-3">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <Badge tone={TONE[s.status]}>{SHIPMENT_STATUS_LABELS[s.status]}</Badge>
                  <span className="text-sm text-muted">{s.providerName ?? s.providerKey}</span>
                  <span className="ms-auto">
                    <Money cents={s.costCents} currency={s.currency} />
                  </span>
                </div>

                <p className="text-sm text-fg">{s.recipientName}</p>
                <p className="text-xs text-muted">{s.city} — {s.addressLine}</p>

                {s.trackingCode ? (
                  <p className="mt-1 text-xs text-muted" dir="ltr">
                    {s.trackingUrl ? (
                      <a
                        href={s.trackingUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="text-primary hover:underline"
                      >
                        {s.trackingCode}
                      </a>
                    ) : (
                      s.trackingCode
                    )}
                  </p>
                ) : (
                  <p className="mt-1 text-xs text-muted">لا يوجد رقم تتبّع.</p>
                )}

                {s.failureReason ? (
                  <p className="mt-1 text-xs text-danger">{s.failureReason}</p>
                ) : null}

                {canManage ? (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <ShipmentStatusButtons
                      orgSlug={orgSlug}
                      branchSlug={branchSlug}
                      id={s.id}
                      status={s.status}
                    />
                    {canPay && s.costCents > 0 && s.paidCents < s.costCents ? (
                      <PayShipment orgSlug={orgSlug} branchSlug={branchSlug} id={s.id} />
                    ) : null}
                    {s.paidCents >= s.costCents && s.costCents > 0 ? (
                      <span className="text-xs text-success">تمت تسوية التكلفة</span>
                    ) : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {canManage && !inFlight ? (
          <div className="border-t border-line pt-3">
            <CreateShipment
              orgSlug={orgSlug}
              branchSlug={branchSlug}
              orderId={orderId}
              providers={providers.map((p) => ({
                id: p.id,
                name: p.name,
                defaultCostCents: p.defaultCostCents,
              }))}
              retry={shipments.length > 0}
            />
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
