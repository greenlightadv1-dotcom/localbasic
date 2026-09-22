import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { toAppError } from '@/lib/errors';
import { requirePermission, type TenantContext } from '@/modules/core/tenancy/context';
import { IMPORT_LIMITS } from './parse';
import {
  IMPORT_FIELDS,
  REQUIRED_FIELDS,
  validateRow,
  type ImportField,
  type ImportRowValues,
  type RowIssue,
} from './fields';

/**
 * The menu importer.
 *
 * THIS WRITES THE CATALOG, NOT THE SITE ENGINE. Rows land in
 * restaurant_products, restaurant_variants and restaurant_categories — the
 * same tables the POS, the kitchen display and the ordering flow read. Nothing
 * here touches site_sections: a site's menu section holds configuration and
 * resolves these tables live, so importing a menu updates what every surface
 * shows without any content being copied anywhere.
 *
 * MATCHING, AND WHY V1 CREATES RATHER THAN UPDATES.
 *
 * restaurant_products has no sku and no external_id column. There is therefore
 * no reliable identifier to update BY. Matching on name alone is exactly what
 * the brief rules out — two branches of a menu legitimately contain "عصير
 * برتقال" at different prices, and merging them on a string would silently
 * rewrite a price.
 *
 * So a row whose name already exists in this organization is reported as a
 * DUPLICATE and skipped, visibly, with a count. Nothing is merged and nothing
 * is overwritten. Update mode waits for an identifier worth updating by, which
 * is a schema decision rather than an import one.
 */

export type RowOutcome = 'create' | 'skip-duplicate' | 'skip-duplicate-in-file' | 'error';

export type PreviewRow = {
  /** 1-based, counting the header as row 1, so it matches what the admin sees. */
  rowNumber: number;
  outcome: RowOutcome;
  values: ImportRowValues | null;
  issues: RowIssue[];
  /** Set when the category named by this row does not exist yet. */
  newCategory: string | null;
};

export type ImportPreview = {
  rows: PreviewRow[];
  counts: { create: number; skipped: number; errors: number };
  /** Categories this import would create, if the admin allows it. */
  newCategories: string[];
  /** Fields the admin has not mapped that are required. */
  missingRequired: ImportField[];
};

export type Mapping = Partial<Record<ImportField, number>>;

/** Pulls one row's mapped cells out of the raw grid. */
function cellsFor(row: string[], mapping: Mapping): Record<ImportField, string> {
  const out = {} as Record<ImportField, string>;
  for (const field of IMPORT_FIELDS) {
    const index = mapping[field];
    out[field] = index === undefined ? '' : (row[index] ?? '');
  }
  return out;
}

/**
 * Works out what an import WOULD do. Writes nothing.
 *
 * Every read is scoped to ctx.organizationId, and the preview is computed
 * against this organization's existing catalog — so the duplicate counts an
 * admin sees are duplicates in THEIR menu, not in anyone else's.
 */
export async function previewImport(
  ctx: TenantContext,
  table: { headers: string[]; rows: string[][] },
  mapping: Mapping,
): Promise<ImportPreview> {
  // Reading the catalog to compare against is a menu read; writing needs
  // manage, checked separately in commitImport.
  requirePermission(ctx, 'restaurant.menu.read');

  const missingRequired = REQUIRED_FIELDS.filter((f) => mapping[f] === undefined);
  if (missingRequired.length) {
    return {
      rows: [],
      counts: { create: 0, skipped: 0, errors: 0 },
      newCategories: [],
      missingRequired,
    };
  }

  const supabase = createSupabaseServerClient();

  const [{ data: existing, error: productError }, { data: categories, error: categoryError }] =
    await Promise.all([
      supabase
        .from('restaurant_products')
        .select('id, name')
        .eq('organization_id', ctx.organizationId)
        .is('deleted_at', null),
      supabase
        .from('restaurant_categories')
        .select('id, name')
        .eq('organization_id', ctx.organizationId),
    ]);

  if (productError) throw toAppError(productError, 'previewImport products');
  if (categoryError) throw toAppError(categoryError, 'previewImport categories');

  const existingNames = new Set(
    (existing ?? []).map((p) => String(p.name).trim().toLowerCase()),
  );
  const existingCategories = new Set(
    (categories ?? []).map((c) => String(c.name).trim().toLowerCase()),
  );

  const seenInFile = new Set<string>();
  const newCategories = new Set<string>();
  const rows: PreviewRow[] = [];
  let create = 0;
  let skipped = 0;
  let errors = 0;

  table.rows.slice(0, IMPORT_LIMITS.maxRows).forEach((raw, index) => {
    const rowNumber = index + 2;
    const result = validateRow(cellsFor(raw, mapping));

    if (!result.ok) {
      errors += 1;
      rows.push({ rowNumber, outcome: 'error', values: null, issues: result.issues, newCategory: null });
      return;
    }

    const key = result.values.name.trim().toLowerCase();

    if (existingNames.has(key)) {
      skipped += 1;
      rows.push({
        rowNumber,
        outcome: 'skip-duplicate',
        values: result.values,
        issues: [{ field: 'name', message: 'يوجد صنف بهذا الاسم بالفعل. لن يُعدّل.' }],
        newCategory: null,
      });
      return;
    }

    // The same name twice in one sheet is the admin's own duplicate, and only
    // the first occurrence can be created.
    if (seenInFile.has(key)) {
      skipped += 1;
      rows.push({
        rowNumber,
        outcome: 'skip-duplicate-in-file',
        values: result.values,
        issues: [{ field: 'name', message: 'مكرر داخل الملف.' }],
        newCategory: null,
      });
      return;
    }
    seenInFile.add(key);

    let newCategory: string | null = null;
    if (result.values.category) {
      const categoryKey = result.values.category.trim().toLowerCase();
      if (!existingCategories.has(categoryKey)) {
        newCategory = result.values.category;
        newCategories.add(result.values.category);
      }
    }

    create += 1;
    rows.push({ rowNumber, outcome: 'create', values: result.values, issues: [], newCategory });
  });

  return {
    rows,
    counts: { create, skipped, errors },
    newCategories: [...newCategories],
    missingRequired: [],
  };
}

export type ImportResult = {
  created: number;
  skipped: number;
  errors: number;
  categoriesCreated: number;
};

/**
 * Writes the rows a preview said would be created. Nothing else.
 *
 * Rows that errored or duplicated are not written and not retried — the
 * preview already showed the admin exactly which ones those were.
 *
 * PARTIAL FAILURE. Products and their variants are inserted in two statements
 * per batch, and PostgREST has no transaction across calls, so a failure after
 * the products insert would leave products with no variant — priced at nothing
 * and invisible to the menu resolver, which drops a product with no variant.
 * That is the safe direction to fail in, and the count returned is the number
 * of products that actually came back from the database rather than the number
 * attempted. An all-or-nothing import would need an RPC; it is noted as
 * deferred rather than pretended to.
 */
export async function commitImport(
  ctx: TenantContext,
  preview: ImportPreview,
  options: { createCategories: boolean },
): Promise<ImportResult> {
  requirePermission(ctx, 'restaurant.menu.manage');

  const supabase = createSupabaseServerClient();
  const toCreate = preview.rows.filter((r) => r.outcome === 'create' && r.values);

  if (toCreate.length === 0) {
    return { created: 0, skipped: preview.counts.skipped, errors: preview.counts.errors, categoriesCreated: 0 };
  }

  // Categories, by name, within this organization only.
  const { data: categories, error: categoryError } = await supabase
    .from('restaurant_categories')
    .select('id, name')
    .eq('organization_id', ctx.organizationId);
  if (categoryError) throw toAppError(categoryError, 'commitImport categories');

  const byName = new Map<string, string>();
  for (const c of categories ?? []) byName.set(String(c.name).trim().toLowerCase(), c.id as string);

  let categoriesCreated = 0;
  if (options.createCategories && preview.newCategories.length) {
    const wanted = preview.newCategories.filter((n) => !byName.has(n.trim().toLowerCase()));
    if (wanted.length) {
      const { data: made, error } = await supabase
        .from('restaurant_categories')
        .insert(
          wanted.map((name, i) => ({
            organization_id: ctx.organizationId,
            name,
            sort_order: (categories?.length ?? 0) + i,
            created_by: ctx.userId,
          })),
        )
        .select('id, name');
      if (error) throw toAppError(error, 'commitImport create categories');
      for (const c of made ?? []) byName.set(String(c.name).trim().toLowerCase(), c.id as string);
      categoriesCreated = made?.length ?? 0;
    }
  }

  const { data: products, error: productError } = await supabase
    .from('restaurant_products')
    .insert(
      toCreate.map((row) => {
        const v = row.values!;
        return {
          organization_id: ctx.organizationId,
          category_id: v.category ? (byName.get(v.category.trim().toLowerCase()) ?? null) : null,
          name: v.name,
          description: v.description,
          image_url: v.imageUrl,
          sort_order: v.sortOrder ?? 0,
          prep_minutes: v.prepMinutes ?? 0,
          created_by: ctx.userId,
        };
      }),
    )
    .select('id, name');

  if (productError) throw toAppError(productError, 'commitImport products');

  // Each product gets the one default variant that carries its price, which is
  // the shape createMenuProduct() already uses for a single-price item.
  const priceByName = new Map<string, number>();
  for (const row of toCreate) priceByName.set(row.values!.name, row.values!.priceCents);

  const variants = (products ?? []).map((p) => ({
    organization_id: ctx.organizationId,
    product_id: p.id as string,
    name: 'default',
    price_cents: priceByName.get(String(p.name)) ?? 0,
    sort_order: 0,
  }));

  if (variants.length) {
    const { error: variantError } = await supabase.from('restaurant_variants').insert(variants);
    if (variantError) throw toAppError(variantError, 'commitImport variants');
  }

  return {
    // What the database actually returned, not what was attempted.
    created: products?.length ?? 0,
    skipped: preview.counts.skipped,
    errors: preview.counts.errors,
    categoriesCreated,
  };
}
