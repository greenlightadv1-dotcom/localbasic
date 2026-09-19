import 'server-only';
import { z } from 'zod';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requirePlatformAdmin } from '@/modules/platform/admin/context';
import { AppError } from '@/lib/errors';
import { parseSiteDefinition, SITE_DEFINITION_VERSION, type SiteDefinition } from './definition';
import { plainText } from './sections';
import { resolveTheme } from './theme';
import { getBusinessProfile, suggestedSiteType } from './business';
import { websiteAIService } from './ai/service';
import type { WebsiteBrief } from './ai/provider';

/**
 * The Website Builder service.
 *
 * Every function begins with requirePlatformAdmin(), and every one of them is
 * backed by a policy that asks the same question again in the database. The
 * gate here is for a clean 404; RLS is the boundary. Tenant RBAC is never
 * consulted — a tenant owner has no route into any of this, by design.
 *
 * Nothing the browser sends is trusted to identify anything. An organization
 * arrives as an id and is resolved server-side; authorship is not accepted at
 * all, because the database sets created_by from auth.uid() whatever the
 * insert carried.
 */

export const SITE_TYPES = ['restaurant', 'clinic', 'workshop', 'retail', 'custom'] as const;
export type SiteType = (typeof SITE_TYPES)[number];

export const WEBSITE_STATUSES = ['draft', 'published', 'archived'] as const;
export type WebsiteStatus = (typeof WEBSITE_STATUSES)[number];

export type WebsiteListRow = {
  id: string;
  name: string;
  slug: string;
  siteType: SiteType;
  status: WebsiteStatus;
  organizationId: string;
  organizationName: string;
  updatedAt: string;
  publishedAt: string | null;
};

export type WebsiteDetail = WebsiteListRow & {
  draftDefinition: SiteDefinition | null;
  /** Present only once published; never the draft. */
  publishedDefinition: SiteDefinition | null;
  /** Set when the stored draft no longer parses — see getWebsite. */
  draftError: string | null;
  brief: WebsiteBrief;
  createdBy: string | null;
  createdAt: string;
};

const briefSchema = z
  .object({
    notes: plainText(4000).default(''),
    audience: plainText(200).optional(),
    tone: plainText(120).optional(),
    requestedPages: z.array(plainText(60)).max(20).optional(),
    requestedSections: z.array(plainText(40)).max(20).optional(),
    seoKeywords: z.array(plainText(40)).max(20).optional(),
    restrictions: plainText(1000).optional(),
  })
  .strict();

export const createWebsiteInput = z.object({
  organizationId: z.string().uuid('اختر عميلًا'),
  name: plainText(120).refine((v) => v.length >= 2, 'اسم الموقع مطلوب'),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/, 'حروف إنجليزية وأرقام وشرطات فقط'),
  siteType: z.enum(SITE_TYPES),
  locale: z.enum(['ar', 'en']).default('ar'),
  brief: briefSchema,
});

export async function listWebsites(): Promise<WebsiteListRow[]> {
  await requirePlatformAdmin();
  const supabase = createSupabaseServerClient();

  const { data, error } = await supabase
    .from('platform_websites')
    .select('id, name, slug, site_type, status, organization_id, updated_at, published_at')
    .is('deleted_at', null)
    .order('updated_at', { ascending: false });
  if (error) throw error;

  const rows = data ?? [];
  if (rows.length === 0) return [];

  // The organization name is read separately rather than embedded: platform
  // read on organizations is a policy, not a foreign-key relationship the
  // generated types carry, and a join here would not type.
  const { data: orgs } = await supabase
    .from('organizations')
    .select('id, name')
    .in('id', [...new Set(rows.map((r) => r.organization_id))]);
  const names = new Map((orgs ?? []).map((o) => [o.id, o.name]));

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    siteType: r.site_type as SiteType,
    status: r.status as WebsiteStatus,
    organizationId: r.organization_id,
    organizationName: names.get(r.organization_id) ?? '—',
    updatedAt: r.updated_at,
    publishedAt: r.published_at,
  }));
}

/**
 * One website, with its definitions parsed.
 *
 * A stored definition is parsed rather than cast. The database guarantees it
 * is structurally sound and free of markup, but not that it satisfies every
 * rule this version of the schema has — a definition written before a schema
 * change is exactly the case that would otherwise reach a renderer as a
 * confident lie. A draft that no longer parses comes back as `draftError` so
 * the editor can say so instead of rendering nothing.
 */
export async function getWebsite(id: string): Promise<WebsiteDetail | null> {
  await requirePlatformAdmin();
  const supabase = createSupabaseServerClient();

  const { data, error } = await supabase
    .from('platform_websites')
    .select(
      'id, name, slug, site_type, status, organization_id, updated_at, published_at, created_at, created_by, draft_definition, published_definition, brief',
    )
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle();
  if (error || !data) return null;

  const { data: org } = await supabase
    .from('organizations')
    .select('name')
    .eq('id', data.organization_id)
    .maybeSingle();

  const draft = parseSiteDefinition(data.draft_definition);
  const published = data.published_definition
    ? parseSiteDefinition(data.published_definition)
    : null;

  return {
    id: data.id,
    name: data.name,
    slug: data.slug,
    siteType: data.site_type as SiteType,
    status: data.status as WebsiteStatus,
    organizationId: data.organization_id,
    organizationName: org?.name ?? '—',
    updatedAt: data.updated_at,
    publishedAt: data.published_at,
    createdAt: data.created_at,
    createdBy: data.created_by,
    draftDefinition: draft.ok ? draft.definition : null,
    draftError: draft.ok ? null : draft.error,
    publishedDefinition: published?.ok ? published.definition : null,
    brief: (briefSchema.safeParse(data.brief).data ?? { notes: '' }) as WebsiteBrief,
  };
}

/**
 * Create a website and its first draft.
 *
 * The organization is resolved and verified server-side from its id. A forged
 * or stale id produces "that customer is not available" and nothing is
 * written — the foreign key would catch a fabricated one, but not one naming a
 * customer that has since been deleted, which is the case worth checking.
 */
export async function createWebsite(input: unknown): Promise<string> {
  await requirePlatformAdmin();

  const parsed = createWebsiteInput.safeParse(input);
  if (!parsed.success) {
    throw new AppError('validation', parsed.error.issues[0]?.message ?? 'بيانات غير صالحة');
  }
  const { organizationId, name, slug, siteType, locale, brief } = parsed.data;

  const business = await getBusinessProfile(organizationId);
  if (!business) throw new AppError('validation', 'هذا العميل غير متاح');

  // The opening draft comes through the same AI boundary a generated one will,
  // so the very first document a website ever holds has already been validated
  // by the schema rather than trusted because we built it.
  const generated = await websiteAIService().generate({
    siteType,
    locale,
    business,
    brief,
    theme: undefined,
  });
  if (!generated.ok) throw new AppError('validation', generated.error);

  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from('platform_websites')
    .insert({
      organization_id: organizationId,
      name,
      slug,
      site_type: siteType,
      draft_definition: generated.definition,
      brief,
      // Sent for completeness only. The database overwrites both from
      // auth.uid(), so a forged value here changes nothing.
      created_by: null,
      updated_by: null,
    })
    .select('id')
    .single();

  if (error) {
    if (error.code === '23505') throw new AppError('conflict', 'هذا المعرّف مستخدم بالفعل');
    throw new AppError('validation', error.message);
  }
  return data.id;
}

/** Replace the working draft. Never touches what is published. */
export async function saveDraft(id: string, definition: unknown): Promise<void> {
  await requirePlatformAdmin();

  const parsed = parseSiteDefinition(definition);
  if (!parsed.ok) throw new AppError('validation', parsed.error);

  const supabase = createSupabaseServerClient();
  const { error } = await supabase
    .from('platform_websites')
    .update({ draft_definition: parsed.definition })
    .eq('id', id)
    .is('deleted_at', null);
  if (error) throw new AppError('validation', error.message);
}

export async function saveBrief(id: string, brief: unknown): Promise<void> {
  await requirePlatformAdmin();

  const parsed = briefSchema.safeParse(brief);
  if (!parsed.success) {
    throw new AppError('validation', parsed.error.issues[0]?.message ?? 'بيانات غير صالحة');
  }

  const supabase = createSupabaseServerClient();
  const { error } = await supabase
    .from('platform_websites')
    .update({ brief: parsed.data })
    .eq('id', id)
    .is('deleted_at', null);
  if (error) throw new AppError('validation', error.message);
}

/**
 * Promote the draft to published.
 *
 * The snapshot, the live copy, the status and the timestamp move together
 * inside platform_website_publish(), so there is no moment where a site counts
 * as published with nothing behind it. The draft is validated here first to
 * give the operator a readable message, and again in the database because that
 * is the guarantee.
 */
export async function publishWebsite(
  id: string,
  note?: string,
): Promise<{ version: number; pageCount: number }> {
  await requirePlatformAdmin();

  const website = await getWebsite(id);
  if (!website) throw new AppError('not_found', 'الموقع غير موجود');
  if (website.draftError) throw new AppError('validation', `المسودة مرفوضة: ${website.draftError}`);

  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('platform_website_publish', {
    p_website_id: id,
    p_note: note ?? null,
  });
  if (error) throw new AppError('validation', error.message);

  const row = (Array.isArray(data) ? data : data == null ? [] : [data])[0] as
    | { out_version: number; out_page_count: number }
    | undefined;
  if (!row) throw new AppError('validation', 'تعذّر النشر');
  return { version: row.out_version, pageCount: row.out_page_count };
}

/**
 * Retire a website.
 *
 * Archived, never deleted: published_definition and every version stay, so a
 * site that was live on a given day remains answerable. The published copy is
 * deliberately left in place — status is what decides whether it is served.
 */
export async function archiveWebsite(id: string): Promise<void> {
  await requirePlatformAdmin();

  const supabase = createSupabaseServerClient();
  const { error } = await supabase
    .from('platform_websites')
    .update({ status: 'archived' })
    .eq('id', id)
    .is('deleted_at', null);
  if (error) throw new AppError('validation', error.message);
}

export type WebsiteVersionRow = {
  version: number;
  publishedAt: string;
  note: string | null;
};

/** Published history, newest first. The foundation rollback will build on. */
export async function listVersions(id: string): Promise<WebsiteVersionRow[]> {
  await requirePlatformAdmin();

  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from('platform_website_versions')
    .select('version, published_at, note')
    .eq('website_id', id)
    .order('version', { ascending: false });
  if (error) throw error;

  return (data ?? []).map((v) => ({
    version: v.version,
    publishedAt: v.published_at,
    note: v.note,
  }));
}

/** Customers a website can be built for, for the create form's first step. */
export async function listCandidateOrganizations(): Promise<
  { id: string; name: string; slug: string; suggestedType: string }[]
> {
  await requirePlatformAdmin();

  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from('organizations')
    .select('id, name, slug, primary_module, status')
    .is('deleted_at', null)
    .eq('status', 'active')
    .order('name');
  if (error) throw error;

  return (data ?? []).map((o) => ({
    id: o.id,
    name: o.name,
    slug: o.slug,
    suggestedType: suggestedSiteType(o.primary_module),
  }));
}

export { SITE_DEFINITION_VERSION, resolveTheme };
