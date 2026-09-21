import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { AppError, conflict, notFound, toAppError } from '@/lib/errors';
import { can, requirePermission, type TenantContext } from '@/modules/core/tenancy/context';
import { SECTION_TYPES, type CreateSiteInput, type SectionType } from './schemas';
import type { Site, SiteDetail, SitePage, SiteSection, SiteSettings } from './types';

/**
 * The Site Engine's data access.
 *
 * Every query runs as the signed-in member through the ordinary server client,
 * so RLS and `site.read` / `site.manage` are what decide. The organization
 * filter below is a scope filter, not the authorization: without it a member of
 * two organizations would see both organizations' sites on one screen, which is
 * wrong but not unsafe. What makes it safe is the policy, and the policy is
 * what a forgotten filter cannot bypass.
 *
 * The context comes from the URL via resolveTenantContext(), never from a
 * submitted payload, so a forged organization id in a form body changes
 * nothing.
 */

type SiteRow = {
  id: string;
  organization_id: string;
  created_by: string | null;
  name: string;
  slug: string;
  template_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
};

function toSite(row: SiteRow): Site {
  return {
    id: row.id,
    organizationId: row.organization_id,
    createdBy: row.created_by,
    name: row.name,
    slug: row.slug,
    templateId: row.template_id,
    // The column is constrained to these two values; the cast documents that
    // rather than re-validating what the database already guarantees.
    status: row.status as Site['status'],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SITE_COLUMNS =
  'id, organization_id, created_by, name, slug, template_id, status, created_at, updated_at';

/** Every site in this organization, newest first. */
export async function listSites(ctx: TenantContext): Promise<Site[]> {
  // Checked here as well as in the policy so a caller without the permission
  // gets a 404 rather than a convincing empty list.
  requirePermission(ctx, 'site.read');
  const supabase = createSupabaseServerClient();

  const { data, error } = await supabase
    .from('sites')
    .select(SITE_COLUMNS)
    .eq('organization_id', ctx.organizationId)
    .order('created_at', { ascending: false });

  if (error) throw toAppError(error, 'listSites');
  return (data ?? []).map((row) => toSite(row as SiteRow));
}

/**
 * One site with its pages, sections and settings.
 *
 * Returns null rather than throwing when the site is out of reach: RLS filters
 * it out, which is indistinguishable from "does not exist" — and deliberately
 * so, since saying "it exists, but not for you" would confirm the id belongs
 * to some organization.
 *
 * The organization filter is explicit as well, so a site id from another
 * organization cannot resolve even if its policy were ever loosened.
 */
export async function getSiteDetail(
  ctx: TenantContext,
  siteId: string,
): Promise<SiteDetail | null> {
  if (!can(ctx, 'site.read')) return null;
  const supabase = createSupabaseServerClient();

  const { data: siteRow, error: siteError } = await supabase
    .from('sites')
    .select(SITE_COLUMNS)
    .eq('id', siteId)
    .eq('organization_id', ctx.organizationId)
    .maybeSingle();

  if (siteError) throw toAppError(siteError, 'getSiteDetail site');
  if (!siteRow) return null;

  const site = toSite(siteRow as SiteRow);

  const { data: pageRows, error: pageError } = await supabase
    .from('site_pages')
    .select('id, site_id, title, slug, is_homepage, sort_order')
    .eq('site_id', siteId)
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true });

  if (pageError) throw toAppError(pageError, 'getSiteDetail pages');

  const pages: SitePage[] = (pageRows ?? []).map((p) => ({
    id: p.id as string,
    siteId: p.site_id as string,
    title: p.title as string,
    slug: p.slug as string,
    isHomepage: p.is_homepage as boolean,
    sortOrder: p.sort_order as number,
  }));

  let sections: SiteSection[] = [];
  if (pages.length) {
    const { data: sectionRows, error: sectionError } = await supabase
      .from('site_sections')
      .select('id, page_id, section_type, content, sort_order, is_visible')
      .in('page_id', pages.map((p) => p.id))
      .order('sort_order', { ascending: true })
      .order('id', { ascending: true });

    if (sectionError) throw toAppError(sectionError, 'getSiteDetail sections');

    sections = (sectionRows ?? [])
      // A row whose type the renderer does not know is dropped rather than
      // rendered as a blank. The database constraint makes this unreachable
      // today; it stops being unreachable the moment the constraint gains a
      // type this build has no case for.
      .filter((s) => SECTION_TYPES.includes(s.section_type as SectionType))
      .map((s) => ({
        id: s.id as string,
        pageId: s.page_id as string,
        sectionType: s.section_type as SectionType,
        content: (s.content ?? {}) as Record<string, unknown>,
        sortOrder: s.sort_order as number,
        isVisible: s.is_visible as boolean,
      }));
  }

  const { data: settingsRow, error: settingsError } = await supabase
    .from('site_settings')
    .select('site_id, settings')
    .eq('site_id', siteId)
    .maybeSingle();

  if (settingsError) throw toAppError(settingsError, 'getSiteDetail settings');

  const settings: SiteSettings | null = settingsRow
    ? {
        siteId: settingsRow.site_id as string,
        settings: (settingsRow.settings ?? {}) as Record<string, unknown>,
      }
    : null;

  return { site, pages, sections, settings };
}

/**
 * Creates a site, its homepage and its settings.
 *
 * One RPC, one transaction. Doing this as three inserts from here would leave
 * a site with no homepage whenever the second call failed, and nothing would
 * ever repair it. site_provision() runs as the caller, so RLS still applies to
 * every row it writes, and it re-checks site.manage itself.
 *
 * The organization comes from the context, never from the form.
 */
export async function createSite(
  ctx: TenantContext,
  input: CreateSiteInput,
): Promise<{ siteId: string }> {
  requirePermission(ctx, 'site.manage');
  const supabase = createSupabaseServerClient();

  const { data, error } = await supabase.rpc('site_provision', {
    p_org: ctx.organizationId,
    p_name: input.name,
    p_slug: input.slug,
    p_template_id: null,
  });

  if (error) {
    // 23505 = unique_violation, which here means this ORGANIZATION already has
    // a site on that slug. Slugs are unique per organization, so another
    // organization holding it is not a conflict and cannot produce this.
    if ((error as { code?: string }).code === '23505') {
      throw conflict('يوجد موقع بهذا المعرّف في هذه المؤسسة. اختر معرّفًا آخر.');
    }
    throw toAppError(error, 'createSite');
  }

  const siteId = data as unknown as string | null;
  if (!siteId) throw new AppError('internal');

  return { siteId };
}

/** The site detail, or a 404 for a caller who cannot reach it. */
export async function requireSiteDetail(
  ctx: TenantContext,
  siteId: string,
): Promise<SiteDetail> {
  const detail = await getSiteDetail(ctx, siteId);
  if (!detail) throw notFound();
  return detail;
}
