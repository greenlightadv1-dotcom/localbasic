/**
 * The resolved render model.
 *
 * This file is the boundary between data access and presentation. It has NO
 * imports — not the Supabase client, not the tenant context, not a query
 * builder — and that is the point: the renderer imports these types and
 * therefore cannot reach a database through them.
 *
 * The resolver (./resolve, which is `server-only`) produces these values from
 * the authoritative tables; SiteRenderer consumes them and knows nothing about
 * where they came from.
 *
 * WHAT THESE TYPES DELIBERATELY DO NOT CARRY
 *
 * No organization id, no branch id, no tenant identifier of any kind. The
 * renderer has no use for one, and a value it cannot see is a value it cannot
 * leak into markup. The authoritative context stays on the server.
 */

export type ResolvedMenuVariant = {
  /** The real restaurant_variants row id, so a rendered price stays traceable. */
  id: string;
  name: string;
  priceCents: number;
};

export type ResolvedMenuProduct = {
  /** The real restaurant_products row id. */
  id: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  /** Cheapest variant, for the "from" price on a card. */
  fromPriceCents: number;
  variants: ResolvedMenuVariant[];
};

export type ResolvedMenuCategory = {
  /** Null for products with no category. */
  id: string | null;
  name: string;
  products: ResolvedMenuProduct[];
};

/**
 * THE ORGANIZATION'S MENU.
 *
 * Not a branch's. A Site Engine site is organization-scoped — `sites` has an
 * organization_id and no branch_id — so no branch is selected and
 * restaurant_branch_availability is deliberately not consulted. Rendering must
 * not describe this as a particular location's menu.
 */
export type ResolvedMenu = {
  type: 'menu';
  categories: ResolvedMenuCategory[];
  /** The organization's currency code, for formatting. */
  currency: string;
};

/**
 * Organization-level business information.
 *
 * There is no `address`, and its absence is the design rather than an
 * omission: the only addresses in this schema belong to branches, and picking
 * one for an organization-scoped site would be inventing a relationship the
 * schema does not have. Branch addresses are rendered by the branches section
 * and nowhere else.
 */
export type ResolvedBusinessInfo = {
  type: 'business_info';
  name: string;
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
  logoUrl: string | null;
};

/** One day of the authoritative seven-day week, in its stored shape. */
export type ResolvedHoursDay = {
  /** 0 = Monday, matching the stored array's own order. */
  index: number;
  closed: boolean;
  /** HH:MM, or null when closed. The source holds one pair per day. */
  opens: string | null;
  closes: string | null;
};

/**
 * The weekly schedule, exactly as stored.
 *
 * Seven entries or none. There is no "currently open" flag: the repository has
 * no canonical calculation for it, and inventing one here would be a second
 * opinion about when a business is open.
 */
export type ResolvedHours = {
  type: 'hours';
  days: ResolvedHoursDay[];
};

export type ResolvedBranch = {
  id: string;
  name: string;
  slug: string;
  /** The branch's own address. The only place an address comes from. */
  address: string | null;
  phone: string | null;
};

export type ResolvedBranches = {
  type: 'branches';
  branches: ResolvedBranch[];
};

export type ResolvedSectionData =
  | ResolvedMenu
  | ResolvedBusinessInfo
  | ResolvedHours
  | ResolvedBranches;

/**
 * Resolved data, keyed by the section id it belongs to.
 *
 * Keyed by section rather than by type so two menu sections on one page — one
 * narrowed to a category, one not — each get their own result.
 *
 * A missing key is a legitimate state, not an error: a page rendered without
 * the resolver having run shows each data-bound section's unavailable notice
 * rather than throwing.
 */
export type ResolvedSectionMap = Record<string, ResolvedSectionData>;
