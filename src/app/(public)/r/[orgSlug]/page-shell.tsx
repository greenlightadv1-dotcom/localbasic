import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import { Phone, MapPin, Clock } from 'lucide-react';
import { clientEnv } from '@/lib/env';
import {
  getWebsite, getBranches, getMenu, formatMoney, WEEKDAYS_AR,
  type Website, type PublicBranch, type MenuCategory,
} from '@/modules/restaurant/website/service';
import { getOnlineMenu, getStorefront } from '@/modules/restaurant/online/service';
import { resolveTableCode } from '@/modules/restaurant/public/table-entry';
import { brandThemeVars } from '@/lib/theme/brand-theme';
import { PoweredBy } from '@/components/brand/logo';
import {
  CategoryRail, CategorySection, FoodCard, FoodGrid, StoreHeader,
} from '@/components/menu/food-ui';
import { Storefront } from '../../order/[orgSlug]/[branchSlug]/storefront';

/**
 * A store's public menu, for both /r/<org>[/<branch>] and the store's own
 * domain (and /menu there).
 *
 * This used to be a section-by-section website assembled from a site editor's
 * layout. It is now the ordering menu itself, themed from the store's brand:
 * the same food-app UI a table QR or the online link shows, with the store's
 * name, logo and description on top.
 *
 *   - `?table=<code>` redirects into that table's QR menu;
 *   - one branch → straight to its menu; several → pick a branch first;
 *   - a branch that takes online orders gets the full storefront, one that
 *     does not gets the same menu read-only.
 *
 * `linkBase` is where this site's own links point: `/r/<org>` on the
 * LocalBasic address, empty on a custom domain.
 */
export async function buildMetadata(
  orgSlug: string,
  branchSlug?: string,
): Promise<Metadata> {
  const site = await getWebsite(orgSlug);
  // An unpublished restaurant gets no title that would confirm it exists.
  if (!site) return { title: 'الصفحة غير موجودة', robots: { index: false, follow: false } };

  const canonicalPath = branchSlug ? `/r/${orgSlug}/${branchSlug}` : `/r/${orgSlug}`;
  const url = `${clientEnv.NEXT_PUBLIC_APP_URL}${canonicalPath}`;
  const description =
    site.tagline ?? site.about?.slice(0, 160) ?? `منيو وطلبات ${site.organizationName}`;

  return {
    title: site.organizationName,
    description,
    // A published restaurant is meant to be found.
    robots: { index: true, follow: true },
    alternates: { canonical: url },
    openGraph: {
      type: 'website',
      title: site.organizationName,
      description,
      url,
      siteName: site.organizationName,
      locale: 'ar_EG',
      ...(site.heroUrl ? { images: [{ url: site.heroUrl }] } : {}),
    },
  };
}

export async function RestaurantSite({
  orgSlug,
  branchSlug,
  table,
  linkBase,
}: {
  orgSlug: string;
  branchSlug?: string;
  /** The raw `?table=` value, if any. */
  table?: string | string[] | undefined;
  linkBase?: string;
}) {
  const tableCode = await resolveTableCode(table);
  if (tableCode) redirect(`/p/${tableCode}`);

  const site = await getWebsite(orgSlug);
  if (!site) notFound();

  const base = linkBase ?? `/r/${orgSlug}`;
  const branches = await getBranches(orgSlug);
  if (branches.length === 0) notFound();

  const branch = branchSlug ? branches.find((b) => b.slug === branchSlug) : branches.length === 1 ? branches[0] : undefined;
  if (branchSlug && !branch) notFound();

  const vars = brandThemeVars(site.primaryColor, site.secondaryColor) as React.CSSProperties;
  const description = site.tagline ?? site.about ?? null;

  // Several branches and none chosen yet: pick one.
  if (!branch) {
    return (
      <Shell vars={vars} whiteLabel={site.whiteLabel}>
        <StoreHeader name={site.organizationName} logoUrl={site.logoUrl} description={description} />
        <section className="px-4 pb-8 pt-2">
          <h2 className="mb-3 text-lg font-extrabold text-fg">اختر الفرع</h2>
          <ul className="grid gap-3 sm:grid-cols-2">
            {branches.map((b) => (
              <li key={b.slug}>
                <Link
                  href={`${base}/${b.slug}`}
                  className="flex min-h-20 flex-col justify-center gap-0.5 rounded-lg border border-line bg-elevated p-4 shadow-[0_6px_18px_rgb(var(--lb-primary)/0.07)] transition-colors hover:border-primary"
                >
                  <span className="text-base font-extrabold text-fg">{b.name}</span>
                  {b.address ? <span className="text-sm text-muted">{b.address}</span> : null}
                </Link>
              </li>
            ))}
          </ul>
        </section>
        <Footer site={site} />
      </Shell>
    );
  }

  const canOrder = b_canOrder(branch);
  const [menu, info, readOnly] = await Promise.all([
    canOrder ? getOnlineMenu({ orgSlug, branchSlug: branch.slug }).catch(() => null) : null,
    canOrder ? getStorefront({ orgSlug, branchSlug: branch.slug }).catch(() => null) : null,
    canOrder ? null : getMenu(orgSlug, branch.slug),
  ]);

  const ordering = canOrder && menu && info && menu.items.length > 0;

  return (
    <Shell vars={vars} whiteLabel={site.whiteLabel}>
      <StoreHeader
        name={site.organizationName}
        logoUrl={site.logoUrl}
        description={description}
        chips={[branch.name]}
      />
      {ordering ? (
        <Storefront
          orgSlug={orgSlug}
          branchSlug={branch.slug}
          items={menu.items}
          modifierGroups={menu.modifierGroups}
          currency={info.currency}
          pickupEnabled={info.pickupEnabled}
          deliveryEnabled={info.deliveryEnabled}
        />
      ) : (
        <ReadOnlyMenu categories={readOnly ?? []} currency={site.currency} />
      )}
      <Footer site={site} branch={branch} />
    </Shell>
  );
}

function b_canOrder(branch: PublicBranch) {
  return branch.orderingEnabled && (branch.pickupEnabled || branch.deliveryEnabled);
}

function Shell({
  vars, whiteLabel, children,
}: { vars: React.CSSProperties; whiteLabel: boolean; children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-bg text-fg" style={vars}>
      <div className="mx-auto max-w-2xl">
        {children}
        {!whiteLabel ? (
          <div className="px-4 pb-24 pt-2 text-center">
            <PoweredBy />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The menu without ordering: a branch that is not taking orders online. */
function ReadOnlyMenu({ categories, currency }: { categories: MenuCategory[]; currency: string }) {
  if (categories.length === 0) {
    return <p className="px-4 py-16 text-center text-sm text-muted">المنيو غير متاح حاليًا.</p>;
  }
  return (
    <div className="pb-8">
      <p className="mx-4 mb-1 rounded-[14px] bg-primary-soft px-4 py-2.5 text-sm font-semibold text-primary">
        الطلب أونلاين غير متاح الآن في هذا الفرع. تفضّل بزيارتنا.
      </p>
      <CategoryRail
        categories={categories.map((c) => ({
          id: c.id ?? '__uncategorised__',
          name: c.name,
          imageUrl: c.products.find((p) => p.imageUrl)?.imageUrl ?? null,
        }))}
      />
      {categories.map((c) => (
        <CategorySection key={c.id ?? '__uncategorised__'} id={c.id ?? '__uncategorised__'} name={c.name}>
          <FoodGrid>
            {c.products.map((p) => (
              <FoodCard
                key={p.productId}
                name={p.name}
                description={p.description}
                priceLabel={`${p.variants.length > 1 ? 'من ' : ''}${formatMoney(p.fromPriceCents, currency)}`}
                imageUrl={p.imageUrl}
                canOrder={false}
              />
            ))}
          </FoodGrid>
        </CategorySection>
      ))}
    </div>
  );
}

function Footer({ site, branch }: { site: Website; branch?: PublicBranch }) {
  const phone = branch?.phone ?? site.phone;
  const hours = site.openingHours;
  if (!phone && !branch?.address && !hours) return null;
  return (
    <footer className="mx-4 mt-8 space-y-2 rounded-lg border border-line bg-surface p-4 text-sm">
      {branch?.address ? (
        <p className="flex gap-2 text-fg"><MapPin className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />{branch.address}</p>
      ) : null}
      {phone ? (
        <p className="flex gap-2">
          <Phone className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          <a href={`tel:${phone}`} dir="ltr" className="lb-numeric font-semibold text-fg">{phone}</a>
        </p>
      ) : null}
      {hours ? (
        <div className="flex gap-2">
          <Clock className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          <ul className="grid flex-1 gap-0.5 text-muted">
            {hours.map((d, i) => (
              <li key={i} className="flex justify-between gap-3">
                <span>{WEEKDAYS_AR[i]}</span>
                <span className="lb-numeric">{d.closed ? 'مغلق' : `${d.opens ?? ''} – ${d.closes ?? ''}`}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </footer>
  );
}
