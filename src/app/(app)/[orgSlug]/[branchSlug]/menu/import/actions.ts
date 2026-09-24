'use server';

import { z } from 'zod';
import { defineTenantAction } from '@/lib/action';
import { RATE_LIMITS } from '@/lib/rate-limit';
import {
  IMPORT_LIMITS,
  ImportParseError,
  parseCsv,
  parseXlsx,
  type SheetTable,
} from '@/modules/restaurant/import/parse';
import { suggestMapping } from '@/modules/restaurant/import/fields';
import { fetchSheetCsv, parseSheetUrl, SheetSourceError } from '@/modules/restaurant/import/sheets';
import {
  commitImport,
  previewImport,
  type ImportPreview,
  type ImportResult,
  type Mapping,
} from '@/modules/restaurant/import/service';

/**
 * The three steps of a menu import.
 *
 * Each is a Server Action behind defineTenantAction, so the organization comes
 * from the URL scope and the permission is checked before anything runs.
 * Parsing needs `restaurant.menu.read`; only the final commit needs
 * `restaurant.menu.manage`, so a member who may look at the menu can try an
 * import and see what it would do without being able to perform it.
 *
 * THE PARSED TABLE TRAVELS BETWEEN STEPS as JSON in the form body. It is
 * therefore client-controlled, and is treated as such: the preview and the
 * commit re-validate every row from scratch and every write is scoped to the
 * context's organization. Tampering with it can only produce rows the same
 * admin could have uploaded in a file, which is why it is not worth a server
 * -side job table in V1 — and why the row cap below is modest.
 */

/** Kept well under the Server Action body limit, since the table is re-sent. */
const CARRY_ROW_LIMIT = 500;

const tableSchema = z.object({
  headers: z.array(z.string().max(IMPORT_LIMITS.maxCellLength)).max(IMPORT_LIMITS.maxColumns),
  rows: z
    .array(z.array(z.string().max(IMPORT_LIMITS.maxCellLength)).max(IMPORT_LIMITS.maxColumns))
    .max(CARRY_ROW_LIMIT),
  sheetName: z.string().max(200).optional(),
});

const mappingSchema = z.record(z.number().int().min(0).max(IMPORT_LIMITS.maxColumns));

export type ParseState =
  | { ok: true; table: SheetTable; mapping: Mapping; source: string }
  | { ok: false; error: string }
  | undefined;

export type PreviewState =
  | { ok: true; preview: ImportPreview }
  | { ok: false; error: string }
  | undefined;

export type CommitState =
  | { ok: true; result: ImportResult }
  | { ok: false; error: string }
  | undefined;

function scopeOf(formData: FormData) {
  return {
    organizationSlug: String(formData.get('orgSlug') ?? ''),
    branchSlug: String(formData.get('branchSlug') ?? ''),
  };
}

function trim(table: SheetTable): SheetTable {
  return { ...table, rows: table.rows.slice(0, CARRY_ROW_LIMIT) };
}

/** Step 1 — read the file or the sheet, and guess the column mapping. */
export async function parseSourceAction(
  _prev: ParseState,
  formData: FormData,
): Promise<ParseState> {
  const scope = scopeOf(formData);

  // Authorization first: nothing is read, fetched or parsed for a caller who
  // may not look at this organization's menu.
  const gate = defineTenantAction({
    schema: z.object({}).strict(),
    permission: 'restaurant.menu.read',
    rateLimit: RATE_LIMITS.mutation,
    handler: async () => true,
  });
  const allowed = await gate(scope, {});
  if (!allowed.ok) return { ok: false, error: allowed.error };

  const kind = String(formData.get('kind') ?? 'file');

  try {
    if (kind === 'sheet') {
      const source = parseSheetUrl(String(formData.get('sheetUrl') ?? ''));
      const csv = await fetchSheetCsv(source);
      const table = trim(parseCsv(csv));
      return {
        ok: true,
        table,
        mapping: suggestMapping(table.headers),
        source: source.exportUrl,
      };
    }

    const file = formData.get('file');
    if (!(file instanceof File) || file.size === 0) {
      return { ok: false, error: 'اختر ملفًا أولًا.' };
    }
    if (file.size > IMPORT_LIMITS.maxBytes) {
      return { ok: false, error: 'حجم الملف أكبر من ٥ ميجابايت.' };
    }

    const name = file.name.toLowerCase();
    const buffer = Buffer.from(await file.arrayBuffer());

    // The extension picks the reader; the reader then proves the format. An
    // .xlsx that is not a zip fails in readZipEntries rather than here.
    let table: SheetTable;
    if (name.endsWith('.xlsx')) {
      table = parseXlsx(buffer);
    } else if (name.endsWith('.csv')) {
      table = parseCsv(buffer.toString('utf8'));
    } else {
      return { ok: false, error: 'يُقبل ملف .xlsx أو .csv فقط.' };
    }

    const trimmed = trim(table);
    return {
      ok: true,
      table: trimmed,
      mapping: suggestMapping(trimmed.headers),
      source: file.name,
    };
  } catch (error) {
    if (error instanceof SheetSourceError) return { ok: false, error: error.message };
    if (error instanceof ImportParseError) {
      return { ok: false, error: 'تعذّر قراءة الملف. تأكد أنه جدول صالح وضمن الحدود المسموحة.' };
    }
    return { ok: false, error: 'تعذّر قراءة الملف.' };
  }
}

/** Step 2 — say what the import would do. Writes nothing. */
export async function previewAction(
  _prev: PreviewState,
  formData: FormData,
): Promise<PreviewState> {
  const scope = scopeOf(formData);

  const parsed = tableSchema.safeParse(JSON.parse(String(formData.get('table') ?? '{}')));
  const mapping = mappingSchema.safeParse(JSON.parse(String(formData.get('mapping') ?? '{}')));
  if (!parsed.success || !mapping.success) {
    return { ok: false, error: 'بيانات الجدول غير صالحة. أعد رفع الملف.' };
  }

  const run = defineTenantAction({
    schema: z.object({}).strict(),
    permission: 'restaurant.menu.read',
    handler: async ({ ctx }) =>
      previewImport(ctx, parsed.data, mapping.data as Mapping),
  });

  const result = await run(scope, {});
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, preview: result.data };
}

/**
 * Step 3 — write.
 *
 * The preview is recomputed server-side from the same table rather than being
 * accepted from the browser, so what is written is what the server decided,
 * not what a form field claimed.
 */
export async function commitAction(
  _prev: CommitState,
  formData: FormData,
): Promise<CommitState> {
  const scope = scopeOf(formData);

  const parsed = tableSchema.safeParse(JSON.parse(String(formData.get('table') ?? '{}')));
  const mapping = mappingSchema.safeParse(JSON.parse(String(formData.get('mapping') ?? '{}')));
  if (!parsed.success || !mapping.success) {
    return { ok: false, error: 'بيانات الجدول غير صالحة. أعد رفع الملف.' };
  }
  const createCategories = formData.get('createCategories') === 'on';

  const run = defineTenantAction({
    schema: z.object({}).strict(),
    permission: 'restaurant.menu.manage',
    rateLimit: RATE_LIMITS.provisionWorkspace,
    handler: async ({ ctx }) => {
      const preview = await previewImport(ctx, parsed.data, mapping.data as Mapping);
      return commitImport(ctx, preview, { createCategories });
    },
  });

  const result = await run(scope, {});
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, result: result.data };
}
