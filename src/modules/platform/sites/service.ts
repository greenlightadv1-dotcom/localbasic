import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requirePlatformAdmin } from '@/modules/platform/admin/context';
import { AppError, toAppError, notFound } from '@/lib/errors';
import { updateAppearanceSchema } from '@/modules/sites/schemas';
import { siteSettingsSchema, type SiteSettingsConfig } from '@/modules/sites/templates/types';
import { parseSnapshot, type SiteSnapshot } from '@/modules/sites/publishing';

/**
 * Site Engine, operated by Platform Admin.
 *
 * Every function here calls a SECURITY DEFINER `platform_site_*` function
 * (0061) that re-checks `app.require_platform_admin()` itself.
 * requirePlatformAdmin() here is for the UI's benefit — a clean, typed error
 * instead of a raw SQL one — and is never the only thing standing between a
 * caller and the data, the same relationship billing/service.ts has with its
 * own `platform_*` functions.
 *
 * The customer code and site id travel as plain arguments, resolved server
 * side by the SQL function they are passed to — never trusted as a claim of
 * which organization a write may reach. A site id that does not belong to
 * the named customer resolves to nothing, the same "not found" a made-up id
 * gets, so a probing caller cannot tell the two apart.
 *
 * This writes and reads the SAME site_settings row, the SAME
 * updateAppearanceSchema, and the SAME site_revisions ledger the tenant
 * editor (src/modules/sites/service.ts) does — nothing here is a second
 * theme system or a second publishing pipeline. What is different is only the
 * authorization entry point, because a Platform Admin session has no
 * TenantContext to check a tenant permission against.
 */

function rpcError(error: { code?: string }, context: string): never {
  // 22023 is what every platform_site_* function raises for "site not found
  // for this customer" — the same code the tenant service checks for its own
  // RPCs, and the same reason: a made-up id and a real id from another
  // organization must read as the identical, uninformative "not found".
  if (error.code === '22023') throw notFound();
  throw toAppError(error, context);
}

export type PlatformSiteSummary = {
  id: string;
  name: string;
  slug: string;
  status: string;
  createdAt: string;
  updatedAt: string;
};

/** An organization's sites — the picker behind /admin/customers/[code]/sites. */
export async function platformListSites(customerCode: string): Promise<PlatformSiteSummary[]> {
  await requirePlatformAdmin();
  const supabase = createSupabaseServerClient();

  const { data, error } = await supabase.rpc('platform_site_list', {
    p_customer_code: customerCode,
  });
  if (error) throw toAppError(error, 'platformListSites');

  type Row = {
    id: string; name: string; slug: string; status: string;
    created_at: string; updated_at: string;
  };
  return ((data ?? []) as Row[]).map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export type PlatformSiteDetail = {
  organization: { id: string; name: string; code: string; currency: string };
  site: {
    id: string;
    name: string;
    slug: string;
    status: string;
    createdAt: string;
    updatedAt: string;
  };
  /** Parsed with the same tolerant schema the tenant editor reads with. */
  settings: SiteSettingsConfig;
  /** The current DRAFT, in the exact shape a publish would freeze. */
  snapshot: SiteSnapshot;
  live: {
    version: number;
    publishedAt: string;
    note: string | null;
    /** What was actually frozen at that publish — for draftDiffersFrom(). */
    snapshot: SiteSnapshot;
  } | null;
};

type DetailRow = {
  organization_id: string;
  organization_name: string;
  organization_code: string;
  organization_currency: string;
  site_name: string;
  site_slug: string;
  site_status: string;
  site_created_at: string;
  site_updated_at: string;
  settings: unknown;
  snapshot: unknown;
  live_version: number | null;
  live_published_at: string | null;
  live_note: string | null;
  live_snapshot: unknown;
};

/**
 * One site's detail: enough to orient in the read-only editor pane, to drive
 * the Theme Customizer's live preview, and to know what is currently live.
 *
 * Null covers both "no such site" and "not this customer's" — the same
 * answer on purpose, matching getSiteDetail() (tenant): an id cannot be
 * probed for which organization it belongs to.
 */
export async function platformGetSiteDetail(
  customerCode: string,
  siteId: string,
): Promise<PlatformSiteDetail | null> {
  await requirePlatformAdmin();
  const supabase = createSupabaseServerClient();

  const { data, error } = await supabase.rpc('platform_site_detail', {
    p_customer_code: customerCode,
    p_site: siteId,
  });
  if (error) throw toAppError(error, 'platformGetSiteDetail');

  const row = (Array.isArray(data) ? data[0] : data) as DetailRow | undefined;
  if (!row) return null;

  return {
    organization: {
      id: row.organization_id,
      name: row.organization_name,
      code: row.organization_code,
      currency: row.organization_currency,
    },
    site: {
      id: siteId,
      name: row.site_name,
      slug: row.site_slug,
      status: row.site_status,
      createdAt: row.site_created_at,
      updatedAt: row.site_updated_at,
    },
    settings: siteSettingsSchema.parse(row.settings ?? {}),
    snapshot: parseSnapshot(row.snapshot),
    live:
      row.live_version != null && row.live_published_at != null
        ? {
            version: row.live_version,
            publishedAt: row.live_published_at,
            note: row.live_note,
            snapshot: parseSnapshot(row.live_snapshot),
          }
        : null,
  };
}

export type PlatformSiteRevision = {
  id: string;
  version: number;
  isLive: boolean;
  publishedAt: string;
  publishedByName: string | null;
  note: string | null;
};

export async function platformListRevisions(
  customerCode: string,
  siteId: string,
): Promise<PlatformSiteRevision[]> {
  await requirePlatformAdmin();
  const supabase = createSupabaseServerClient();

  const { data, error } = await supabase.rpc('platform_site_revisions_list', {
    p_customer_code: customerCode,
    p_site: siteId,
  });
  if (error) throw toAppError(error, 'platformListRevisions');

  type Row = {
    id: string; version: number; is_live: boolean; published_at: string;
    published_by_name: string | null; note: string | null;
  };
  return ((data ?? []) as Row[]).map((r) => ({
    id: r.id,
    version: r.version,
    isLive: r.is_live,
    publishedAt: r.published_at,
    publishedByName: r.published_by_name,
    note: r.note,
  }));
}

/**
 * Update the theme (draft only).
 *
 * Validates against the exact same `updateAppearanceSchema` the tenant
 * appearance editor validates against, then reads the current settings
 * through `platformGetSiteDetail`'s own RPC and merges over it the same way
 * `updateAppearance()` (tenant) does, so `templateId` — set once at
 * provisioning — survives, and every field the renderer reads is still
 * something `siteSettingsSchema` accepts. This never touches
 * `site_revisions` or `sites.status`: the change is not live until a publish
 * call says so.
 */
export async function platformUpdateTheme(
  customerCode: string,
  siteId: string,
  input: unknown,
): Promise<void> {
  await requirePlatformAdmin();

  const parsed = updateAppearanceSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError('validation', undefined, {
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    });
  }

  const supabase = createSupabaseServerClient();

  const { data: currentRow, error: readError } = await supabase.rpc('platform_site_detail', {
    p_customer_code: customerCode,
    p_site: siteId,
  });
  if (readError) throw toAppError(readError, 'platformUpdateTheme read');
  const row = (Array.isArray(currentRow) ? currentRow[0] : currentRow) as
    | { settings: unknown }
    | undefined;
  if (!row) throw notFound();

  const existing = siteSettingsSchema.parse(row.settings ?? {});
  const settings = siteSettingsSchema.parse({
    ...existing,
    locale: parsed.data.locale,
    direction: parsed.data.direction,
    theme: {
      primary: parsed.data.primary,
      background: parsed.data.background,
      foreground: parsed.data.foreground,
      border: parsed.data.border,
    },
  });

  const { error } = await supabase.rpc('platform_site_theme_update', {
    p_customer_code: customerCode,
    p_site: siteId,
    p_settings: settings,
  });
  if (error) rpcError(error as { code?: string }, 'platformUpdateTheme');
}

export async function platformPublishSite(
  customerCode: string,
  siteId: string,
  note?: string,
): Promise<{ version: number; revisionId: string }> {
  await requirePlatformAdmin();
  const supabase = createSupabaseServerClient();

  const { data, error } = await supabase.rpc('platform_site_publish', {
    p_customer_code: customerCode,
    p_site: siteId,
    p_note: note ?? null,
  });
  if (error) rpcError(error as { code?: string }, 'platformPublishSite');

  const row = (Array.isArray(data) ? data[0] : data) as {
    out_version: number;
    out_revision: string;
  };
  return { version: row.out_version, revisionId: row.out_revision };
}

export async function platformRollbackSite(
  customerCode: string,
  siteId: string,
  revisionId: string,
): Promise<{ version: number }> {
  await requirePlatformAdmin();
  const supabase = createSupabaseServerClient();

  const { data, error } = await supabase.rpc('platform_site_rollback', {
    p_customer_code: customerCode,
    p_site: siteId,
    p_revision: revisionId,
  });
  if (error) rpcError(error as { code?: string }, 'platformRollbackSite');

  return { version: data as unknown as number };
}

export async function platformUnpublishSite(customerCode: string, siteId: string): Promise<void> {
  await requirePlatformAdmin();
  const supabase = createSupabaseServerClient();

  const { error } = await supabase.rpc('platform_site_unpublish', {
    p_customer_code: customerCode,
    p_site: siteId,
  });
  if (error) rpcError(error as { code?: string }, 'platformUnpublishSite');
}
