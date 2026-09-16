import Link from 'next/link';
import type { Metadata } from 'next';
import { Card, CardBody } from '@/components/ui/card';
import { getFavorites } from '@/modules/restaurant/account/service';
import { formatMoney } from '@/modules/restaurant/website/shared';
import { AccountShell, requireCustomer } from '../shell';
import { FavoriteButton } from '../forms';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'المفضلة',
  robots: { index: false, follow: false },
};

/**
 * Saved products.
 *
 * A favourite is a reference, so the name, price and availability here are
 * read from the live menu. A product the restaurant has withdrawn drops out of
 * the list entirely rather than rendering as a stale card — the customer's
 * saved row survives, but nothing about a deactivated product is shown.
 */
export default async function FavoritesPage({ params }: { params: { orgSlug: string } }) {
  const { site } = await requireCustomer(params.orgSlug);
  const favorites = await getFavorites(params.orgSlug);

  return (
    <AccountShell site={site} orgSlug={params.orgSlug} active="/favorites" title="المفضلة">
      {favorites.length === 0 ? (
        <Card>
          <CardBody className="space-y-2 p-8 text-center">
            <p className="font-semibold text-fg">لا توجد أصناف مفضلة</p>
            <p className="text-sm text-muted">
              اضغط «أضف للمفضلة» بجوار أي صنف في المنيو ليظهر هنا.
            </p>
            <Link
              href={`/r/${params.orgSlug}`}
              className="inline-flex h-11 items-center rounded bg-primary px-4 text-sm font-semibold text-primary-fg"
            >
              تصفّح المنيو
            </Link>
          </CardBody>
        </Card>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {favorites.map((product) => (
            <li
              key={product.productId}
              className="flex gap-3 rounded border border-line bg-elevated p-3"
            >
              {product.imageUrl && (
                // eslint-disable-next-line @next/next/no-img-element -- tenant
                // images are arbitrary remote URLs; next/image would need every
                // host allowlisted.
                <img
                  src={product.imageUrl}
                  alt=""
                  className="h-16 w-16 shrink-0 rounded object-cover"
                  loading="lazy"
                />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold text-fg">{product.name}</p>
                {product.description && (
                  <p className="line-clamp-2 text-xs text-muted">{product.description}</p>
                )}
                <p className="mt-1 text-sm text-fg">
                  {product.priceCents === null || !product.available
                    ? 'غير متاح حاليًا'
                    : formatMoney(product.priceCents, product.currency)}
                </p>
                <FavoriteButton
                  orgSlug={params.orgSlug}
                  productId={product.productId}
                  isFavorite
                  from="account"
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </AccountShell>
  );
}
