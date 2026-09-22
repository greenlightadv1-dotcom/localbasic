import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { Database, Json } from '@/types/database';
import { AppError, conflict, notFound, toAppError } from '@/lib/errors';
import { can, requirePermission, type TenantContext } from '@/modules/core/tenancy/context';
import {
  SECTION_TYPES,
  type CreatePageInput,
  type CreateSectionInput,
  type CreateSiteInput,
  type RenamePageInput,
  type ReorderPagesInput,
  type ReorderSectionsInput,
  type SectionType,
  type SiteStatus,
  type UpdateSectionInput,
  type UpdateSiteInput,
} from './schemas';
import { parseSectionContentForWrite } from './sections/content';
import {
  parseSnapshot,
  type SiteRevision,
  type SiteRevisionDetail,
} from './publishing';
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

// ===========================================================================
// PAGE OPERATIONS (Phase 1b)
//
// The same three rules as the section write layer: the organization comes from
// the TenantContext, ownership is re-established through the parent chain
// before the write, and only named fields are sent.
//
// Three of the four go through an RPC rather than a PostgREST write, and not
// for convenience:
//
//   * creating a page has to read the site's highest sort_order and insert in
//     the same statement, or two pages created at once land on the same slot;
//   * reordering is a multi-row write that must be all or nothing;
//   * deleting a page may have to promote a replacement homepage, and between
//     the delete and the promotion the site has none — a state only one
//     transaction can contain.
//
// Renaming is a single-row update of a single column, so it stays a plain
// PostgREST write.
//
// Every RPC is SECURITY INVOKER: RLS still decides. The one SECURITY DEFINER
// function in 0058 is the deferred constraint trigger, which asserts the
// homepage invariant and authorizes nothing.
// ===========================================================================

/** A site that exists in this organization, or null when it is out of reach. */
async function resolveSiteScope(ctx: TenantContext, siteId: string): Promise<boolean> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from('sites')
    .select('id')
    .eq('id', siteId)
    .eq('organization_id', ctx.organizationId)
    .maybeSingle();

  if (error) throw toAppError(error, 'resolveSiteScope');
  return Boolean(data);
}

/**
 * Adds a page to a site.
 *
 * Never the homepage: site_page_create() writes that flag as false and takes
 * no parameter for it. Its position is the end of the site's current order,
 * computed inside the insert.
 */
export async function createPage(
  ctx: TenantContext,
  siteId: string,
  input: CreatePageInput,
): Promise<{ pageId: string }> {
  requirePermission(ctx, 'site.manage');

  if (!(await resolveSiteScope(ctx, siteId))) throw notFound();

  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('site_page_create', {
    p_site: siteId,
    p_title: input.title,
    p_slug: input.slug,
  });

  if (error) {
    // 23505 = unique_violation, which on this table means the site already has
    // a page on that slug. Slugs are unique per site, so another site holding
    // it is not a conflict and cannot produce this.
    if ((error as { code?: string }).code === '23505') {
      throw conflict('يوجد صفحة بهذا المعرّف في هذا الموقع. اختر معرّفًا آخر.');
    }
    throw toAppError(error, 'createPage');
  }

  const pageId = data as unknown as string | null;
  if (!pageId) throw new AppError('internal');
  return { pageId };
}

/**
 * Changes a page's title.
 *
 * `site_id` is not in the payload and could not be honoured if it were: 0058's
 * identity trigger refuses to move a page between sites, so re-parenting is
 * impossible through this path and through any other.
 */
export async function renamePage(
  ctx: TenantContext,
  pageId: string,
  input: RenamePageInput,
): Promise<void> {
  requirePermission(ctx, 'site.manage');

  const scope = await resolvePageScope(ctx, pageId);
  if (!scope) throw notFound();

  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from('site_pages')
    .update({ title: input.title })
    .eq('id', pageId)
    // Repeated even though the scope check just passed, so the statement
    // itself cannot reach a page of another site.
    .eq('site_id', scope.siteId)
    .select('id')
    .maybeSingle();

  if (error) throw toAppError(error, 'renamePage');
  if (!data) throw notFound();
}

/**
 * Sets the order of a site's pages.
 *
 * The array must be an exact permutation of the site's pages. A short list, a
 * duplicate, or an id belonging to another site is refused rather than
 * partially applied — and a refusal leaves the previous order exactly as it
 * was, because the whole thing is one statement in one transaction.
 *
 * Which page is the homepage is not affected. Position in the menu and "the
 * page this site opens on" are separate facts.
 */
export async function reorderPages(
  ctx: TenantContext,
  siteId: string,
  input: ReorderPagesInput,
): Promise<void> {
  requirePermission(ctx, 'site.manage');

  if (!(await resolveSiteScope(ctx, siteId))) throw notFound();

  const supabase = createSupabaseServerClient();
  const { error } = await supabase.rpc('site_pages_reorder', {
    p_site: siteId,
    p_ids: input.pageIds,
  });

  if (error) {
    if ((error as { code?: string }).code === '22023') {
      throw new AppError('validation', 'ترتيب الصفحات غير صالح. أعد تحميل الصفحة وحاول مرة أخرى.');
    }
    throw toAppError(error, 'reorderPages');
  }
}

/**
 * Removes a page, and everything on it.
 *
 * Its sections go with it through the existing ON DELETE CASCADE, so nothing
 * here deletes them and nothing can leave one orphaned. The site's settings
 * row hangs off the SITE and is untouched.
 *
 * Deleting the homepage promotes a deterministic replacement — the next page
 * in (sort_order, id), or the previous one when the homepage is last — in the
 * same transaction. Deleting the only page is refused: a site with no pages
 * has nothing to render and nothing to promote, and creating a page to satisfy
 * the invariant would be inventing content nobody asked for.
 *
 * Returns the id of the page that became the homepage, or null when the
 * deleted page was not the homepage.
 */
export async function deletePage(
  ctx: TenantContext,
  pageId: string,
): Promise<{ promotedPageId: string | null }> {
  requirePermission(ctx, 'site.manage');

  const scope = await resolvePageScope(ctx, pageId);
  if (!scope) throw notFound();

  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('site_page_delete', { p_page: pageId });

  if (error) {
    const code = (error as { code?: string }).code;
    // 23514 = check_violation, which this function raises for "a site must
    // keep at least one page". That is a rule the caller ran into, not a fault.
    if (code === '23514') {
      throw new AppError('validation', 'لا يمكن حذف الصفحة الوحيدة في الموقع.');
    }
    if (code === '22023') throw notFound();
    throw toAppError(error, 'deletePage');
  }

  return { promotedPageId: (data as unknown as string | null) ?? null };
}

/**
 * Adds an empty section to the end of a page.
 *
 * Empty rather than pre-filled: every section schema treats `{}` as a freshly
 * created block that renders its placeholder, so there is nothing to invent
 * here and nothing for the operator to delete before they start typing.
 *
 * The type is the only thing the caller chooses. The page, its site and its
 * organization all come from the resolved scope, and `sort_order` is computed
 * here rather than accepted.
 *
 * The position read and the insert are two statements, so two sections created
 * at the same instant can land on the same `sort_order`. That is benign:
 * site_sections has no unique constraint on it, every read orders by
 * (sort_order, id), and reorderSections() renumbers the page. A single
 * statement would need an RPC, and a migration for a collision that costs
 * nothing is not a trade worth making.
 */
export async function createSection(
  ctx: TenantContext,
  pageId: string,
  input: CreateSectionInput,
): Promise<{ sectionId: string }> {
  requirePermission(ctx, 'site.manage');

  const scope = await resolvePageScope(ctx, pageId);
  if (!scope) throw notFound();

  const supabase = createSupabaseServerClient();

  const { data: last, error: lastError } = await supabase
    .from('site_sections')
    .select('sort_order')
    .eq('page_id', pageId)
    .order('sort_order', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (lastError) throw toAppError(lastError, 'createSection position');

  const sortOrder = Math.min(((last?.sort_order as number | undefined) ?? -1) + 1, 9999);

  const { data, error } = await supabase
    .from('site_sections')
    .insert({
      page_id: pageId,
      section_type: input.sectionType,
      content: {},
      sort_order: sortOrder,
      is_visible: true,
    })
    .select('id')
    .maybeSingle();

  if (error) throw toAppError(error, 'createSection');
  if (!data) throw new AppError('internal');

  return { sectionId: data.id as string };
}

// ===========================================================================
// PUBLISHING (Phase 5)
//
// Each of these delegates to a SECURITY DEFINER function in 0060. That is not
// a way around authorization: site_revisions grants INSERT to nobody, which is
// what makes it append-only, so its only writer must run as the owner. Each
// function resolves the organization FROM THE SITE ROW and re-checks
// `site.manage` on it before writing anything.
//
// The requirePermission() calls below are the same belt-and-braces the rest of
// this module uses: they turn a refusal into a readable error instead of a
// bare policy violation, and they never replace the database's own check.
// ===========================================================================

/** Every revision of a site, newest first. Requires `site.read`. */
export async function listRevisions(
  ctx: TenantContext,
  siteId: string,
): Promise<SiteRevision[]> {
  if (!can(ctx, 'site.read')) return [];
  const supabase = createSupabaseServerClient();

  const { data, error } = await supabase
    .from('site_revisions')
    .select('id, site_id, version, is_live, published_at, published_by, note')
    .eq('site_id', siteId)
    // Scoped as well as filtered: RLS already restricts to organizations the
    // caller can read, and this makes a foreign site id resolve to nothing.
    .eq('organization_id', ctx.organizationId)
    .order('version', { ascending: false });

  if (error) throw toAppError(error, 'listRevisions');

  return (data ?? []).map((r) => ({
    id: r.id as string,
    siteId: r.site_id as string,
    version: r.version as number,
    isLive: r.is_live as boolean,
    publishedAt: r.published_at as string,
    publishedBy: (r.published_by as string | null) ?? null,
    note: (r.note as string | null) ?? null,
  }));
}

/**
 * The revision currently serving, with its snapshot parsed.
 *
 * Null when the site has never been published or has been taken down. This is
 * the read a public route will make: it returns what is LIVE, never the draft,
 * so an unfinished edit cannot reach a visitor.
 */
export async function getLiveRevision(
  ctx: TenantContext,
  siteId: string,
): Promise<SiteRevisionDetail | null> {
  if (!can(ctx, 'site.read')) return null;
  const supabase = createSupabaseServerClient();

  const { data, error } = await supabase
    .from('site_revisions')
    .select('id, site_id, version, is_live, published_at, published_by, note, snapshot')
    .eq('site_id', siteId)
    .eq('organization_id', ctx.organizationId)
    .eq('is_live', true)
    .maybeSingle();

  if (error) throw toAppError(error, 'getLiveRevision');
  if (!data) return null;

  return {
    id: data.id as string,
    siteId: data.site_id as string,
    version: data.version as number,
    isLive: true,
    publishedAt: data.published_at as string,
    publishedBy: (data.published_by as string | null) ?? null,
    note: (data.note as string | null) ?? null,
    // Parsed rather than cast: a snapshot is jsonb, and a row written by an
    // older build must degrade rather than throw.
    snapshot: parseSnapshot(data.snapshot),
  };
}

/** Freezes the current draft as a new revision and makes it live. */
export async function publishSite(
  ctx: TenantContext,
  siteId: string,
  note?: string | null,
): Promise<{ version: number; revisionId: string }> {
  requirePermission(ctx, 'site.manage');
  const supabase = createSupabaseServerClient();

  const { data, error } = await supabase.rpc('site_publish', {
    p_site: siteId,
    p_note: note ?? null,
  });

  if (error) {
    // 22023 is the function's own refusal — no site, or a snapshot the shape
    // check rejected, which today means a site with no pages.
    if ((error as { code?: string }).code === '22023') {
      throw new AppError('validation', 'تعذّر النشر. تأكد أن الموقع يحتوي على صفحة واحدة على الأقل.');
    }
    throw toAppError(error, 'publishSite');
  }

  const row = (Array.isArray(data) ? data[0] : data) as
    | { out_version: number; out_revision: string }
    | undefined;
  if (!row) throw new AppError('internal');

  return { version: row.out_version, revisionId: row.out_revision };
}

/**
 * Makes a previous revision live again.
 *
 * Nothing is copied and nothing is rewritten: the snapshot published that day
 * is the snapshot that goes back up. A revision id belonging to another site
 * is not found — the same answer a made-up id gets.
 */
export async function rollbackSite(
  ctx: TenantContext,
  siteId: string,
  revisionId: string,
): Promise<{ version: number }> {
  requirePermission(ctx, 'site.manage');
  const supabase = createSupabaseServerClient();

  const { data, error } = await supabase.rpc('site_rollback', {
    p_site: siteId,
    p_revision: revisionId,
  });

  if (error) {
    if ((error as { code?: string }).code === '22023') {
      throw notFound();
    }
    throw toAppError(error, 'rollbackSite');
  }

  return { version: data as unknown as number };
}

/** Takes the site down. History is kept; only `is_live` is cleared. */
export async function unpublishSite(ctx: TenantContext, siteId: string): Promise<void> {
  requirePermission(ctx, 'site.manage');
  const supabase = createSupabaseServerClient();

  const { error } = await supabase.rpc('site_unpublish', { p_site: siteId });
  if (error) throw toAppError(error, 'unpublishSite');
}
