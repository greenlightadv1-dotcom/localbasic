import type { Metadata } from 'next';
import { Card, CardBody } from '@/components/ui/card';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { getAddresses } from '@/modules/restaurant/account/service';
import { AccountShell, requireCustomer } from '../shell';
import { AddAddress, DeleteAddressButton, EditAddress } from '../forms';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'عناويني',
  robots: { index: false, follow: false },
};

/**
 * Saved delivery addresses.
 *
 * Scoped to this restaurant by design — see migration 0040 for why a global
 * address book was rejected. In short: an address a customer saved at one
 * restaurant should not be readable at another's checkout, and keeping the
 * rows behind the customer row makes that structural rather than careful.
 */
export default async function AddressesPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string };
  searchParams: { saved?: string; deleted?: string };
}) {
  const { site } = await requireCustomer(params.orgSlug);
  const addresses = await getAddresses(params.orgSlug);

  return (
    <AccountShell site={site} orgSlug={params.orgSlug} active="/addresses" title="عناويني">
      {searchParams.saved && <Alert tone="success">تم حفظ العنوان.</Alert>}
      {searchParams.deleted && <Alert tone="success">تم حذف العنوان.</Alert>}

      {addresses.length === 0 ? (
        <Card>
          <CardBody className="space-y-3 p-8 text-center">
            <p className="font-semibold text-fg">لا توجد عناوين محفوظة</p>
            <p className="text-sm text-muted">
              احفظ عنوانك مرة واحدة لتختاره مباشرة عند طلب التوصيل.
            </p>
          </CardBody>
        </Card>
      ) : (
        <ul className="space-y-3">
          {addresses.map((address) => (
            <li key={address.id} className="rounded border border-line bg-elevated p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-fg">{address.label}</span>
                {address.isDefault && <Badge tone="info">الافتراضي</Badge>}
                <span className="ms-auto flex gap-1">
                  <EditAddress orgSlug={params.orgSlug} address={address} />
                  <DeleteAddressButton orgSlug={params.orgSlug} id={address.id} />
                </span>
              </div>
              <p className="mt-1 text-sm text-muted">
                {[address.city, address.area].filter(Boolean).join(' — ')}
              </p>
              <p className="text-sm text-muted">{address.address}</p>
              {address.landmark && (
                <p className="text-xs text-muted">علامة مميزة: {address.landmark}</p>
              )}
            </li>
          ))}
        </ul>
      )}

      <Card>
        <CardBody className="p-5">
          <AddAddress orgSlug={params.orgSlug} />
        </CardBody>
      </Card>
    </AccountShell>
  );
}
