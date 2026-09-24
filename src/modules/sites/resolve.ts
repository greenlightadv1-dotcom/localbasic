import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { toAppError } from '@/lib/errors';
import type { TenantContext } from '@/modules/core/tenancy/context';
import { isDataBoundSection, type SectionType } from './schemas';
import { parseSectionContent } from './sections/content';
import type { SiteSection } from './types';
import type {
  ResolvedBranch,
  ResolvedBundle,
  ResolvedHoursDay,
  ResolvedMenuCategory,
  ResolvedMenuProduct,
  ResolvedSectionData,
  ResolvedSectionMap,
} from './resolved';

/**
 * The data-resolution layer.
 *
 * DATABASE ACCESS ≠ PRESENTATION RENDERING. Everything that touches Supabase
 * for a data-bound section lives here; ./resolved holds the value types, which
 * import nothing; renderer.tsx consumes those types and can therefore reach no
 * database at all. `server-only` at the top makes an accidental client import
 * a build failure rather than a bundle full of query builders.
 *
 * THE ISOLATION RULE
 *
 * The organization comes from the TenantContext and from nowhere else. Every
 * query below filters on `ctx.organizationId`, which resolveTenantContext()
 * derived from the URL and the caller's actual membership — and RLS filters
 * again underneath, so a forgotten `.eq()` is a bug rather than a breach.
 *
 * NOTHING in section content is ever used to choose an organization, a branch
 * or an owner. The only id a section may carry is `categoryIds`, and those are
 * re-queried inside `ctx.organizationId`: an id naming another tenant's
 * category matches no row and narrows the result to nothing rather than
 * reaching across. There is no parameter through which a payload can redirect
 * a resolution.
 *
 * WHAT THIS IS NOT
 *
 * Not a second source of truth. These are the same tables the restaurant
 * module and the legacy restaurant website read — restaurant_categories,
 * restaurant_products, restaurant_variants, branding_settings, settings,
 * branches. It is a second READ PATH over one source, chosen deliberately:
 * restaurant_website_menu() is branch-scoped and gated on the legacy
 * `restaurant.website_enabled` toggle, and a Site Engine site is
 * organization-scoped and is not part of that system.
 */

/**
 * Everything this module actually reads off a caller's context.
 *
 * A full TenantContext still satisfies this — it is a strict subset — so
 * every tenant call site is unaffected. It exists so a caller that is NOT a
 * tenant member, such as a Platform Admin operating a customer's site, can
 * resolve data-bound sections too: they build one of these from the
 * organization row they already resolved (id, name, currency), never from a
 * TenantContext they have no membership to construct.
 */
export type SiteResolveContext = Pick<TenantContext, 'organizationId' | 'organizationName' | 'currency'>;

/** A section that needs resolving, paired with its parsed configuration. */
type Job = { section: SiteSection; type: SectionType };

/**
 * The organization's menu.
 *
 * NOT a branch's. restaurant_branch_availability is deliberately not consulted:
 * a site is organization-scoped, no branch is selected, and choosing one would
 * invent a relationship the schema does not have. Because the availability
 * table is sparse — a missing row means available — this is the union of what
 * every branch can serve, which is what "the menu" means on a brand site.
 * Whether a given location has run out today is branch operations, and the
 * ordering surfaces still answer it.
 */
async function resolveMenu(
  ctx: SiteResolveContext,
  categoryIds: string[],
  limit: number | null,
): Promise<ResolvedMenuCategory[]> {
  const supabase = createSupabaseServerClient();

  const [{ data: categories, error: catError }, { data: products, error: prodError }] =
    await Promise.all([
      supabase
        .from('restaurant_categories')
        .select('id, name, sort_order')
        .eq('organization_id', ctx.organizationId)
        .eq('is_active', true)
        .order('sort_order', { ascending: true })
        .order('id', { ascending: true }),
      supabase
        .from('restaurant_products')
        .select('id, name, description, image_url, category_id, sort_order')
        .eq('organization_id', ctx.organizationId)
        .eq('is_active', true)
        .is('deleted_at', null)
        .order('sort_order', { ascending: true })
        .order('id', { ascending: true }),
    ]);

  if (catError) throw toAppError(catError, 'resolveMenu categories');
  if (prodError) throw toAppError(prodError, 'resolveMenu products');

  // The configured narrowing, intersected with what this organization actually
  // has. An id from another tenant is not in `categories` — it was never
  // selected — so it can only ever remove rows from this result, never add any.
  const wanted = categoryIds.length ? new Set(categoryIds) : null;
  const visibleCategories = (categories ?? []).filter((c) => !wanted || wanted.has(c.id as string));
  const visibleIds = new Set(visibleCategories.map((c) => c.id as string));

  const scoped = (products ?? []).filter((p) => {
    const categoryId = p.category_id as string | null;
    // Uncategorised products belong to the organization's menu, but only when
    // the section is not narrowed to specific categories.
    if (categoryId === null) return wanted === null;
    return visibleIds.has(categoryId);
  });

  if (scoped.length === 0) return [];

  const capped = limit === null ? scoped : scoped.slice(0, limit);

  const { data: variants, error: varError } = await supabase
    .from('restaurant_variants')
    .select('id, product_id, name, price_cents, sort_order')
    // Scoped by organization as well as by product: the product filter already
    // implies it, and stating it means a variant cannot arrive from elsewhere
    // even if a product id were ever wrong.
    .eq('organization_id', ctx.organizationId)
    .eq('is_active', true)
    .is('deleted_at', null)
    .in('product_id', capped.map((p) => p.id as string))
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true });

  if (varError) throw toAppError(varError, 'resolveMenu variants');

  const byProduct = new Map<string, ResolvedMenuProduct>();
  for (const p of capped) {
    byProduct.set(p.id as string, {
      id: p.id as string,
      name: p.name as string,
      description: (p.description as string | null) ?? null,
      imageUrl: (p.image_url as string | null) ?? null,
      fromPriceCents: 0,
      variants: [],
    });
  }

  for (const v of variants ?? []) {
    const product = byProduct.get(v.product_id as string);
    if (!product) continue;
    const priceCents = Number(v.price_cents);
    product.variants.push({
      id: v.id as string,
      name: v.name as string,
      priceCents,
    });
    product.fromPriceCents =
      product.variants.length === 1 ? priceCents : Math.min(product.fromPriceCents, priceCents);
  }

  const out: ResolvedMenuCategory[] = [];
  const bucket = new Map<string, ResolvedMenuCategory>();

  for (const c of visibleCategories) {
    const entry: ResolvedMenuCategory = {
      id: c.id as string,
      name: c.name as string,
      products: [],
    };
    bucket.set(c.id as string, entry);
    out.push(entry);
  }

  let uncategorised: ResolvedMenuCategory | null = null;
  for (const p of capped) {
    const product = byProduct.get(p.id as string);
    // A product with no sellable variant has no price to show, so it is not a
    // menu item yet.
    if (!product || product.variants.length === 0) continue;

    const categoryId = p.category_id as string | null;
    if (categoryId === null) {
      uncategorised ??= { id: null, name: 'أصناف أخرى', products: [] };
      uncategorised.products.push(product);
    } else {
      bucket.get(categoryId)?.products.push(product);
    }
  }

  if (uncategorised) out.push(uncategorised);
  // An empty category is a category nobody has filled in; it would render as a
  // heading over nothing.
  return out.filter((c) => c.products.length > 0);
}

/**
 * Organization-level business information.
 *
 * No address, deliberately — see ResolvedBusinessInfo. The name, currency and
 * locale already ride the TenantContext, so the only query is the branding row.
 */
async function resolveBusinessInfo(ctx: SiteResolveContext): Promise<ResolvedSectionData> {
  const supabase = createSupabaseServerClient();

  const { data, error } = await supabase
    .from('branding_settings')
    .select('display_name, logo_url, phone, whatsapp, email')
    .eq('organization_id', ctx.organizationId)
    .maybeSingle();

  if (error) throw toAppError(error, 'resolveBusinessInfo');

  return {
    type: 'business_info',
    // The branding override when set, the organization's own name otherwise —
    // the same precedence restaurant_website() applies.
    name: (data?.display_name as string | null)?.trim() || ctx.organizationName,
    phone: (data?.phone as string | null) ?? null,
    whatsapp: (data?.whatsapp as string | null) ?? null,
    email: (data?.email as string | null) ?? null,
    logoUrl: (data?.logo_url as string | null) ?? null,
  };
}

/**
 * The organization's weekly opening hours.
 *
 * Read from the same settings key and the same scope the legacy website reads:
 * organization-level, `branch_id is null`. The stored value is trigger-checked
 * to be exactly seven days of `{closed, opens?, closes?}`, and it is passed
 * through in that shape — no day is dropped, reordered or collapsed.
 *
 * The source has one open/close pair per day; there are no split shifts to
 * preserve. There is no "currently open" flag because the repository has no
 * canonical calculation for one.
 */
async function resolveHours(ctx: SiteResolveContext): Promise<ResolvedSectionData> {
  const supabase = createSupabaseServerClient();

  const { data, error } = await supabase
    .from('settings')
    .select('value')
    .eq('organization_id', ctx.organizationId)
    .is('branch_id', null)
    .eq('key', 'restaurant.opening_hours')
    .maybeSingle();

  if (error) throw toAppError(error, 'resolveHours');

  const raw = data?.value;
  if (!Array.isArray(raw)) return { type: 'hours', days: [] };

  const days: ResolvedHoursDay[] = [];
  raw.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return;
    const day = entry as { closed?: unknown; opens?: unknown; closes?: unknown };
    const closed = day.closed === true;
    days.push({
      index,
      closed,
      opens: !closed && typeof day.opens === 'string' ? day.opens : null,
      closes: !closed && typeof day.closes === 'string' ? day.closes : null,
    });
  });

  // Seven or nothing: a partial week is a malformed value, and half a schedule
  // is worse than none. The trigger on `settings` makes this unreachable
  // through the product.
  return { type: 'hours', days: days.length === 7 ? days : [] };
}

/**
 * The organization's active branches.
 *
 * The same predicate restaurant_website_branches() uses — active, not deleted,
 * ordered by creation — so both systems list the same branches in the same
 * order. Each branch's address is its own; nothing here promotes one to stand
 * for the organization.
 */
async function resolveBranches(ctx: SiteResolveContext): Promise<ResolvedSectionData> {
  const supabase = createSupabaseServerClient();

  const { data, error } = await supabase
    .from('branches')
    .select('id, name, slug, address, phone, created_at')
    .eq('organization_id', ctx.organizationId)
    .eq('is_active', true)
    .is('deleted_at', null)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true });

  if (error) throw toAppError(error, 'resolveBranches');

  const branches: ResolvedBranch[] = (data ?? []).map((b) => ({
    id: b.id as string,
    name: b.name as string,
    slug: String(b.slug),
    address: (b.address as string | null) ?? null,
    phone: (b.phone as string | null) ?? null,
  }));

  return { type: 'branches', branches };
}

/**
 * The organization's flagged "best sellers".
 *
 * Same tables and the same active/not-deleted filters resolveMenu() uses,
 * narrowed to is_best_seller = true and flattened — a curated highlight
 * list, not a second menu grouped by category.
 */
async function resolveBestSellers(
  ctx: SiteResolveContext,
  limit: number | null,
): Promise<ResolvedSectionData> {
  const supabase = createSupabaseServerClient();

  const { data: products, error: prodError } = await supabase
    .from('restaurant_products')
    .select('id, name, description, image_url, sort_order')
    .eq('organization_id', ctx.organizationId)
    .eq('is_active', true)
    .eq('is_best_seller', true)
    .is('deleted_at', null)
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true })
    .limit(limit ?? 50);

  if (prodError) throw toAppError(prodError, 'resolveBestSellers products');
  const rows = products ?? [];
  if (rows.length === 0) return { type: 'best_sellers', products: [], currency: ctx.currency };

  const { data: variants, error: varError } = await supabase
    .from('restaurant_variants')
    .select('id, product_id, name, price_cents, sort_order')
    .eq('organization_id', ctx.organizationId)
    .eq('is_active', true)
    .is('deleted_at', null)
    .in('product_id', rows.map((p) => p.id as string))
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true });

  if (varError) throw toAppError(varError, 'resolveBestSellers variants');

  const byProduct = new Map<string, ResolvedMenuProduct>();
  for (const p of rows) {
    byProduct.set(p.id as string, {
      id: p.id as string,
      name: p.name as string,
      description: (p.description as string | null) ?? null,
      imageUrl: (p.image_url as string | null) ?? null,
      fromPriceCents: 0,
      variants: [],
    });
  }
  for (const v of variants ?? []) {
    const product = byProduct.get(v.product_id as string);
    if (!product) continue;
    const priceCents = Number(v.price_cents);
    product.variants.push({ id: v.id as string, name: v.name as string, priceCents });
    product.fromPriceCents =
      product.variants.length === 1 ? priceCents : Math.min(product.fromPriceCents, priceCents);
  }

  // A flagged product with no sellable variant is not a menu item yet, the
  // same rule resolveMenu() applies.
  const out = rows
    .map((p) => byProduct.get(p.id as string)!)
    .filter((p) => p.variants.length > 0);

  return { type: 'best_sellers', products: out, currency: ctx.currency };
}

/**
 * The organization's bundles/packages.
 *
 * Display-only: restaurant_bundles carries copy and one all-in price, not a
 * relationship to sellable products. Ordering a bundle as a single POS line
 * is a separate, larger feature this does not attempt.
 */
async function resolveBundles(
  ctx: SiteResolveContext,
  limit: number | null,
): Promise<ResolvedSectionData> {
  const supabase = createSupabaseServerClient();

  const { data, error } = await supabase
    .from('restaurant_bundles')
    .select('id, name, description, image_url, price_cents, sort_order')
    .eq('organization_id', ctx.organizationId)
    .eq('is_active', true)
    .is('deleted_at', null)
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true })
    .limit(limit ?? 50);

  if (error) throw toAppError(error, 'resolveBundles');

  const bundles: ResolvedBundle[] = (data ?? []).map((b) => ({
    id: b.id as string,
    name: b.name as string,
    description: (b.description as string | null) ?? null,
    imageUrl: (b.image_url as string | null) ?? null,
    priceCents: Number(b.price_cents),
  }));

  return { type: 'bundles', bundles, currency: ctx.currency };
}

/**
 * Resolves every data-bound section on a page.
 *
 * Takes the sections of ONE page — the ones selectPage() already narrowed — so
 * nothing is fetched for a page the caller is not rendering.
 *
 * Returns an empty map when the page has no data-bound section, which is the
 * common case and costs no query at all.
 */
export async function resolveSectionData(
  ctx: SiteResolveContext,
  sections: SiteSection[],
): Promise<ResolvedSectionMap> {
  const jobs: Job[] = sections
    .filter((s) => s.isVisible && isDataBoundSection(s.sectionType))
    .map((s) => ({ section: s, type: s.sectionType }));

  if (jobs.length === 0) return {};

  const map: ResolvedSectionMap = {};

  // Sequential rather than parallel: a page has a handful of these at most,
  // and one connection doing four small queries in order is kinder to a
  // pooled serverless database than four racing to open their own.
  for (const job of jobs) {
    switch (job.type) {
      case 'menu': {
        // Parsed with the tolerant read schema: a configuration row written by
        // an older build must still render rather than take the page down.
        const config = parseSectionContent('menu', job.section.content);
        const categories = await resolveMenu(ctx, config.categoryIds, config.limit);
        map[job.section.id] = {
          type: 'menu',
          categories,
          currency: ctx.currency,
        };
        break;
      }
      case 'business_info':
        map[job.section.id] = await resolveBusinessInfo(ctx);
        break;
      case 'hours':
        map[job.section.id] = await resolveHours(ctx);
        break;
      case 'branches':
        map[job.section.id] = await resolveBranches(ctx);
        break;
      case 'best_sellers': {
        const config = parseSectionContent('best_sellers', job.section.content);
        map[job.section.id] = await resolveBestSellers(ctx, config.limit);
        break;
      }
      case 'bundles': {
        const config = parseSectionContent('bundles', job.section.content);
        map[job.section.id] = await resolveBundles(ctx, config.limit);
        break;
      }
      default:
        // isDataBoundSection() filtered the rest out. A new data-bound type
        // added to that list without a case here lands nothing in the map, and
        // the renderer shows its unavailable notice rather than guessing.
        break;
    }
  }

  return map;
}

/**
 * The organization's menu categories, for the editor's category picker.
 *
 * Names and ids only. The menu section stores the ids it was narrowed to and
 * never the categories themselves, so this feeds a <select> and nothing more.
 * Organization-scoped like every other read here.
 */
export async function listMenuCategories(
  ctx: SiteResolveContext,
): Promise<{ id: string; name: string }[]> {
  const supabase = createSupabaseServerClient();

  const { data, error } = await supabase
    .from('restaurant_categories')
    .select('id, name')
    .eq('organization_id', ctx.organizationId)
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true });

  if (error) throw toAppError(error, 'listMenuCategories');
  return (data ?? []).map((c) => ({ id: c.id as string, name: c.name as string }));
}
