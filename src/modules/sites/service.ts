import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { Database, Json } from '@/types/database';
import { AppError, conflict, notFound, toAppError } from '@/lib/errors';
import { can, requirePermission, type TenantContext } from '@/modules/core/tenancy/context';
import {
  SECTION_TYPES,
  type CreateSiteInput,
  type ReorderSectionsInput,
  type SectionType,
  type SiteStatus,
  type UpdateSectionInput,
  type UpdateSiteInput,
} from './schemas';
import { parseSectionContentForWrite } from './sections/content';
import { resolveTemplate, DEFAULT_TEMPLATE_ID } from './templates';
import { siteSettingsSchema } from './templates/types';
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

  await seedTemplate(siteId);
  return { siteId };
}

/**
 * Fills a freshly provisioned site with its template's sections and theme.
 *
 * Deliberately NOT in site_provision(): a template is a product decision that
 * changes with the front end, and baking its copy into a migration would mean
 * a database change every time a heading is reworded. The SQL function creates
 * the structural minimum — site, homepage, settings row — and this fills it.
 *
 * Best effort by design. A site with a homepage and no sections is a usable,
 * repairable state; failing the whole creation because seed copy did not land
 * would throw away a site the caller already owns. The failure is logged, and
 * the renderer treats an empty page as empty rather than broken.
 */
async function seedTemplate(siteId: string): Promise<void> {
  const supabase = createSupabaseServerClient();
  const template = resolveTemplate(DEFAULT_TEMPLATE_ID);

  const { data: page } = await supabase
    .from('site_pages')
    .select('id')
    .eq('site_id', siteId)
    .eq('is_homepage', true)
    .maybeSingle();

  if (!page) return;

  const rows = template.sections.map((section, index) => ({
    page_id: page.id as string,
    section_type: section.type,
    // Template content is a JSON literal authored in this repository, not user
    // input, so it is structurally Json already. The generated Insert type
    // wants that nominal type rather than Record<string, unknown>, and the
    // cast says so rather than widening the template's own type.
    content: section.content as Database['public']['Tables']['site_sections']['Insert']['content'],
    sort_order: index,
    is_visible: true,
  }));

  const { error: sectionError } = await supabase.from('site_sections').insert(rows);
  if (sectionError) {
    console.error('[localbasic] site template sections', sectionError);
    return;
  }

  // The settings row already exists — site_provision created it — so this
  // records which template was applied and the theme it came with.
  const settings = siteSettingsSchema.parse({
    templateId: template.id,
    theme: template.theme,
  });

  const { error: settingsError } = await supabase
    .from('site_settings')
    .update({ settings })
    .eq('site_id', siteId);

  if (settingsError) console.error('[localbasic] site template settings', settingsError);
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

// ===========================================================================
// WRITE LAYER (Phase 1a)
//
// Three rules hold for every function below.
//
//   1. The organization comes from the TenantContext, which resolveTenantContext()
//      derived from the URL and the caller's actual membership. No write path
//      accepts an organization id, so there is nothing for a forged one to
//      land in.
//   2. Ownership is re-established through the whole parent chain —
//      section → page → site → organization — before the write, not assumed
//      from the id the caller sent. RLS would refuse a foreign row anyway; this
//      turns that refusal into a 404 instead of a silent zero-row update, which
//      a caller cannot tell from success.
//   3. Only the named fields are sent. `id`, `organization_id` and `created_by`
//      never appear in an update payload, and 0056's trigger refuses them at
//      the database if a later caller ever adds one.
// ===========================================================================

/**
 * The site a page belongs to, or null when it is out of reach.
 *
 * Null covers "no such page" and "not your page" alike: distinguishing them
 * would confirm that some other organization owns that id.
 */
async function resolvePageScope(
  ctx: TenantContext,
  pageId: string,
): Promise<{ siteId: string } | null> {
  const supabase = createSupabaseServerClient();

  const { data: page, error: pageError } = await supabase
    .from('site_pages')
    .select('id, site_id')
    .eq('id', pageId)
    .maybeSingle();

  if (pageError) throw toAppError(pageError, 'resolvePageScope page');
  if (!page) return null;

  // The organization filter is what makes this a scope check rather than a
  // existence check: RLS already hid another organization's site, and this
  // would catch it a second time if a policy were ever loosened.
  const { data: site, error: siteError } = await supabase
    .from('sites')
    .select('id')
    .eq('id', page.site_id as string)
    .eq('organization_id', ctx.organizationId)
    .maybeSingle();

  if (siteError) throw toAppError(siteError, 'resolvePageScope site');
  if (!site) return null;

  return { siteId: page.site_id as string };
}

/**
 * The page and site a section belongs to, and its stored type.
 *
 * The type is returned because the caller must not supply it: it decides which
 * schema the new content is judged against, and letting a client pick that
 * would let it pick its own validation.
 */
async function resolveSectionScope(
  ctx: TenantContext,
  sectionId: string,
): Promise<{ pageId: string; siteId: string; sectionType: SectionType } | null> {
  const supabase = createSupabaseServerClient();

  const { data: section, error } = await supabase
    .from('site_sections')
    .select('id, page_id, section_type')
    .eq('id', sectionId)
    .maybeSingle();

  if (error) throw toAppError(error, 'resolveSectionScope section');
  if (!section) return null;

  const page = await resolvePageScope(ctx, section.page_id as string);
  if (!page) return null;

  const sectionType = section.section_type as string;
  // A stored type this build has no schema for. Unreachable while the check
  // constraint and SECTION_TYPES agree; refusing rather than guessing is what
  // makes it stay unreachable if they ever stop agreeing.
  if (!SECTION_TYPES.includes(sectionType as SectionType)) return null;

  return {
    pageId: section.page_id as string,
    siteId: page.siteId,
    sectionType: sectionType as SectionType,
  };
}

/**
 * Renames a site, or moves it between draft and published.
 *
 * `status` is stored but means nothing yet — there is no public route and no
 * published snapshot, so publishing is a later phase. It is writable here
 * because the column already exists and an editor needs somewhere to put the
 * flag; nothing reads it to decide visibility.
 */
export async function updateSite(
  ctx: TenantContext,
  siteId: string,
  input: UpdateSiteInput,
): Promise<void> {
  requirePermission(ctx, 'site.manage');
  const supabase = createSupabaseServerClient();

  // Built field by field rather than spread from the input, so a property the
  // caller added to the payload cannot reach the column list.
  const patch: { name?: string; status?: SiteStatus } = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.status !== undefined) patch.status = input.status;

  const { data, error } = await supabase
    .from('sites')
    .update(patch)
    .eq('id', siteId)
    .eq('organization_id', ctx.organizationId)
    .select('id')
    .maybeSingle();

  if (error) throw toAppError(error, 'updateSite');
  // Zero rows means RLS or the organization filter refused it. Indistinguishable
  // from "no such site", and reported as such.
  if (!data) throw notFound();
}

/**
 * Edits one section's content or visibility.
 *
 * Content is validated against the schema for the section's STORED type, and
 * strictly: an unknown field, an over-long string or an unsafe link target is
 * refused rather than coerced. Reading the same row is forgiving by design —
 * see parseSectionContent — and the asymmetry is deliberate.
 */
export async function updateSection(
  ctx: TenantContext,
  sectionId: string,
  input: UpdateSectionInput,
): Promise<void> {
  requirePermission(ctx, 'site.manage');

  const scope = await resolveSectionScope(ctx, sectionId);
  if (!scope) throw notFound();

  const patch: { content?: Json; is_visible?: boolean } = {};

  if (input.content !== undefined) {
    const parsed = parseSectionContentForWrite(scope.sectionType, input.content);
    patch.content = parsed as Json;
  }
  if (input.isVisible !== undefined) patch.is_visible = input.isVisible;

  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from('site_sections')
    .update(patch)
    .eq('id', sectionId)
    // Repeated even though the scope check just passed: the statement itself
    // must be unable to touch a row on another page.
    .eq('page_id', scope.pageId)
    .select('id')
    .maybeSingle();

  if (error) throw toAppError(error, 'updateSection');
  if (!data) throw notFound();
}

/**
 * Sets the order of a page's sections.
 *
 * Delegates to site_sections_reorder(), which does the whole thing in one
 * statement inside one transaction. Doing it as N updates from here would let
 * a failure halfway through leave two sections at the same position and none
 * at the first, with nothing to repair it.
 *
 * The array must be an exact permutation of the page's sections. A short list,
 * a duplicate, or an id belonging to another page is refused by the function
 * rather than partially applied.
 */
export async function reorderSections(
  ctx: TenantContext,
  pageId: string,
  input: ReorderSectionsInput,
): Promise<void> {
  requirePermission(ctx, 'site.manage');

  const scope = await resolvePageScope(ctx, pageId);
  if (!scope) throw notFound();

  const supabase = createSupabaseServerClient();
  const { error } = await supabase.rpc('site_sections_reorder', {
    p_page: pageId,
    p_ids: input.sectionIds,
  });

  if (error) {
    // 22023 is the function's own refusal — a list that is not a permutation
    // of this page's sections. That is the caller's mistake, not a fault.
    if ((error as { code?: string }).code === '22023') {
      throw new AppError('validation', 'ترتيب الأقسام غير صالح. أعد تحميل الصفحة وحاول مرة أخرى.');
    }
    throw toAppError(error, 'reorderSections');
  }
}

/**
 * Removes one section from a page.
 *
 * Safe to implement, unlike deleting a site: nothing references a section, a
 * page with no sections renders as an empty page rather than breaking, and no
 * section is structurally required — site_provision() creates none at all, and
 * the template's six are seeded content rather than a schema.
 *
 * Sections carry no operational data. A `contact` section holds the phone
 * number somebody typed into it, not the organization's; deleting it cannot
 * reach branches, menus, orders or branding.
 */
export async function deleteSection(ctx: TenantContext, sectionId: string): Promise<void> {
  requirePermission(ctx, 'site.manage');

  const scope = await resolveSectionScope(ctx, sectionId);
  if (!scope) throw notFound();

  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from('site_sections')
    .delete()
    .eq('id', sectionId)
    .eq('page_id', scope.pageId)
    .select('id')
    .maybeSingle();

  if (error) throw toAppError(error, 'deleteSection');
  if (!data) throw notFound();
}

// deleteSite() is NOT implemented in this phase, and its absence is a decision
// rather than an omission.
//
// `sites` has no deleted_at column, so the only deletion available is a hard
// one. That cascades to every page, section and settings row, and there is no
// published snapshot or version history to restore from — Phase 4 is where
// those arrive. Every comparable entity in this schema soft-deletes:
// organizations, branches, restaurant_products and platform_websites all carry
// deleted_at, and platform_websites is the closest analogue of all.
//
// Adding deleted_at is a schema change with consequences beyond one function —
// every read path, the slug uniqueness index and the RLS policies would all
// have to learn about it — so it is a design decision to take deliberately,
// not a side effect of wanting a delete button. Until then the RLS delete
// policy stands unused, which costs nothing.
