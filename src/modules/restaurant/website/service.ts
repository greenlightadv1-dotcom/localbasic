import 'server-only';
import { z } from 'zod';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { OpeningDay } from './shared';

export * from './shared';

/**
 * The public restaurant website.
 *
 * A read surface over data that already exists. Every call goes through a
 * SECURITY DEFINER function that resolves the restaurant from its public slug
 * and proves it is active, restaurant-enabled and published — so an
 * unpublished restaurant is absent from every entry point rather than from
 * each one separately.
 *
 * Nothing here accepts an organization id, a branch id, or a price.
 */

export const slugParam = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'slug');

export type Website = {
  organizationName: string;
  tagline: string | null;
  about: string | null;
  logoUrl: string | null;
  heroUrl: string | null;
  primaryColor: string;
  secondaryColor: string;
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
  currency: string;
  locale: string;
  whiteLabel: boolean;
  openingHours: OpeningDay[] | null;
};

export type PublicBranch = {
  slug: string;
  name: string;
  address: string | null;
  phone: string | null;
  orderingEnabled: boolean;
  pickupEnabled: boolean;
  deliveryEnabled: boolean;
  deliveryFeeCents: number;
};

export type MenuProduct = {
  productId: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  /** Cheapest variant, for the "from" price on a card. */
  fromPriceCents: number;
  variants: { id: string; name: string; priceCents: number }[];
};

export type MenuCategory = {
  id: string | null;
  name: string;
  products: MenuProduct[];
};

export async function getWebsite(orgSlug: string): Promise<Website | null> {
  const parsed = slugParam.safeParse(orgSlug);
  if (!parsed.success) return null;

  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('restaurant_website', {
    p_org_slug: parsed.data,
  });
  if (error) return null;

  type Row = {
    organization_name: string; tagline: string | null; about: string | null;
    logo_url: string | null; hero_url: string | null;
    primary_color: string; secondary_color: string;
    phone: string | null; whatsapp: string | null; email: string | null;
    currency: string; locale: string; white_label: boolean;
    opening_hours: OpeningDay[] | null;
  };
  const row = (Array.isArray(data) ? data[0] : data) as Row | undefined;
  if (!row) return null;

  return {
    organizationName: row.organization_name,
    tagline: row.tagline,
    about: row.about,
    logoUrl: row.logo_url,
    heroUrl: row.hero_url,
    primaryColor: row.primary_color,
    secondaryColor: row.secondary_color,
    phone: row.phone,
    whatsapp: row.whatsapp,
    email: row.email,
    currency: row.currency,
    locale: row.locale,
    whiteLabel: row.white_label,
    openingHours: Array.isArray(row.opening_hours) ? row.opening_hours : null,
  };
}

export async function getBranches(orgSlug: string): Promise<PublicBranch[]> {
  const parsed = slugParam.safeParse(orgSlug);
  if (!parsed.success) return [];

  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('restaurant_website_branches', {
    p_org_slug: parsed.data,
  });
  if (error) return [];

  type Row = {
    branch_slug: string; branch_name: string; address: string | null; phone: string | null;
    ordering_enabled: boolean; pickup_enabled: boolean; delivery_enabled: boolean;
    delivery_fee_cents: number;
  };

  return ((data ?? []) as Row[]).map((b) => ({
    slug: b.branch_slug,
    name: b.branch_name,
    address: b.address,
    phone: b.phone,
    orderingEnabled: b.ordering_enabled,
    pickupEnabled: b.pickup_enabled,
    deliveryEnabled: b.delivery_enabled,
    deliveryFeeCents: Number(b.delivery_fee_cents),
  }));
}

/**
 * The published menu for one branch, grouped for rendering.
 *
 * The database returns one row per variant; products with several sizes are
 * folded back together here so a card shows one dish, not three.
 */
export async function getMenu(orgSlug: string, branchSlug: string): Promise<MenuCategory[]> {
  const org = slugParam.safeParse(orgSlug);
  const branch = slugParam.safeParse(branchSlug);
  if (!org.success || !branch.success) return [];

  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('restaurant_website_menu', {
    p_org_slug: org.data,
    p_branch_slug: branch.data,
  });
  if (error) return [];

  type Row = {
    category_id: string | null; category_name: string | null;
    product_id: string; product_name: string; product_description: string | null;
    image_url: string | null;
    variant_id: string; variant_name: string; price_cents: number;
  };

  const categories = new Map<string, MenuCategory>();
  const products = new Map<string, MenuProduct>();

  for (const r of (data ?? []) as Row[]) {
    const catKey = r.category_id ?? '__uncategorised__';
    let cat = categories.get(catKey);
    if (!cat) {
      cat = { id: r.category_id, name: r.category_name ?? 'أصناف أخرى', products: [] };
      categories.set(catKey, cat);
    }

    let product = products.get(r.product_id);
    if (!product) {
      product = {
        productId: r.product_id,
        name: r.product_name,
        description: r.product_description,
        imageUrl: r.image_url,
        fromPriceCents: r.price_cents,
        variants: [],
      };
      products.set(r.product_id, product);
      cat.products.push(product);
    }

    product.variants.push({
      id: r.variant_id,
      name: r.variant_name,
      priceCents: r.price_cents,
    });
    product.fromPriceCents = Math.min(product.fromPriceCents, r.price_cents);
  }

  return [...categories.values()];
}

/**
 * The organization's flagged "best sellers" — a flat list, not grouped by
 * category. Organization-wide, unlike getMenu(): restaurant_website_best_sellers()
 * has no branch parameter at all, because a "best seller" flag is not a
 * branch-availability question.
 */
export async function getBestSellers(orgSlug: string): Promise<MenuCategory[]> {
  const org = slugParam.safeParse(orgSlug);
  if (!org.success) return [];

  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('restaurant_website_best_sellers', {
    p_org_slug: org.data,
  });
  if (error) return [];

  type Row = {
    product_id: string; product_name: string; product_description: string | null;
    image_url: string | null;
    variant_id: string; variant_name: string; price_cents: number;
  };

  const products = new Map<string, MenuProduct>();
  for (const r of (data ?? []) as Row[]) {
    let product = products.get(r.product_id);
    if (!product) {
      product = {
        productId: r.product_id,
        name: r.product_name,
        description: r.product_description,
        imageUrl: r.image_url,
        fromPriceCents: r.price_cents,
        variants: [],
      };
      products.set(r.product_id, product);
    }
    product.variants.push({ id: r.variant_id, name: r.variant_name, priceCents: r.price_cents });
    product.fromPriceCents = Math.min(product.fromPriceCents, r.price_cents);
  }

  // One flat "category" so this shares MenuCategory's shape with getMenu();
  // callers that want a flat product list read .products off the one entry.
  return [{ id: null, name: 'الأكثر مبيعًا', products: [...products.values()] }];
}

export type Bundle = {
  id: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  priceCents: number;
};

/** The organization's bundles/packages — display copy and one all-in price each. */
export async function getBundles(orgSlug: string): Promise<Bundle[]> {
  const org = slugParam.safeParse(orgSlug);
  if (!org.success) return [];

  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('restaurant_website_bundles', {
    p_org_slug: org.data,
  });
  if (error) return [];

  type Row = {
    bundle_id: string; name: string; description: string | null;
    image_url: string | null; price_cents: number;
  };

  return ((data ?? []) as Row[]).map((b) => ({
    id: b.bundle_id,
    name: b.name,
    description: b.description,
    imageUrl: b.image_url,
    priceCents: b.price_cents,
  }));
}
