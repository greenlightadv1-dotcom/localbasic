import 'server-only';
import QRCode from 'qrcode';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { AppError, conflict, notFound, toAppError } from '@/lib/errors';
import { generatePublicToken } from '@/lib/tokens';
import { appOrigin } from '@/lib/auth/redirects';
import type { TenantContext } from '@/modules/core/tenancy/context';
import type { TableStatus } from './schemas';

export type FloorTable = {
  id: string;
  name: string;
  seats: number;
  status: TableStatus;
  sectionId: string | null;
  sectionName: string | null;
  token: string | null;
  publicUrl: string | null;
  isActive: boolean;
  openOrderCount: number;
  openTotalCents: number;
  /** The most recent open order on this table, if any — so staff can tap the
   *  table and land straight on its order rather than searching the queue. */
  openOrderId: string | null;
};

/**
 * The address a table's QR code points at.
 *
 * Through appOrigin(), not NEXT_PUBLIC_APP_URL directly. The variable is
 * inlined at build time and falls back to localhost when it was absent for
 * that build, and a QR code is the one link that gets PRINTED and glued to a
 * table — a wrong one is recalled by hand, table by table. appOrigin() returns
 * the identical string whenever the variable is set properly, and otherwise
 * falls back to the deployment's own production URL rather than to a machine
 * no customer can reach.
 */
export function publicUrlForToken(token: string): string {
  return `${appOrigin()}/p/${token}`;
}

/**
 * The floor plan for this branch: every table, its state, its QR, and whatever
 * is currently open on it. One query set feeds the admin floor view, the
 * waiter view and the cashier's table picker.
 */
export async function listFloor(ctx: TenantContext): Promise<FloorTable[]> {
  const supabase = createSupabaseServerClient();

  const [{ data: tables, error }, { data: sections }] = await Promise.all([
    supabase
      .from('restaurant_tables')
      .select('id, name, seats, status, section_id, public_link_id, is_active')
      .eq('organization_id', ctx.organizationId)
      .eq('branch_id', ctx.branchId)
      .is('deleted_at', null)
      .order('name'),
    supabase
      .from('restaurant_sections')
      .select('id, name')
      .eq('branch_id', ctx.branchId)
      .order('sort_order'),
  ]);

  if (error) throw toAppError(error, 'listFloor');
  if (!tables?.length) return [];

  const linkIds = tables.map((t) => t.public_link_id).filter(Boolean) as string[];
  const [{ data: links }, { data: openOrders }] = await Promise.all([
    linkIds.length
      ? supabase.from('public_links').select('id, token').in('id', linkIds).eq('is_active', true)
      : Promise.resolve({ data: [] as { id: string; token: string }[] }),
    supabase
      .from('restaurant_orders')
      .select('id, table_id, total_cents')
      .eq('branch_id', ctx.branchId)
      .in('status', ['new', 'confirmed', 'preparing', 'ready', 'served']),
  ]);

  const tokenByLink = new Map((links ?? []).map((l) => [l.id, l.token]));
  const sectionName = new Map((sections ?? []).map((s) => [s.id, s.name]));

  return tables.map((table) => {
    const open = (openOrders ?? []).filter((o) => o.table_id === table.id);
    const token = table.public_link_id ? (tokenByLink.get(table.public_link_id) ?? null) : null;
    return {
      id: table.id,
      name: table.name,
      seats: table.seats,
      status: table.status as TableStatus,
      sectionId: table.section_id,
      sectionName: table.section_id ? (sectionName.get(table.section_id) ?? null) : null,
      token,
      publicUrl: token ? publicUrlForToken(token) : null,
      isActive: table.is_active,
      openOrderCount: open.length,
      openTotalCents: open.reduce((sum, o) => sum + o.total_cents, 0),
      openOrderId: open[0]?.id ?? null,
    };
  });
}

export async function listSections(ctx: TenantContext) {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from('restaurant_sections')
    .select('id, name, sort_order, is_active')
    .eq('branch_id', ctx.branchId)
    .order('sort_order');
  if (error) throw toAppError(error, 'listSections');
  return data ?? [];
}

export async function createSection(ctx: TenantContext, input: { name: string; sortOrder: number }) {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from('restaurant_sections')
    .insert({
      organization_id: ctx.organizationId,
      branch_id: ctx.branchId,
      name: input.name,
      sort_order: input.sortOrder,
      created_by: ctx.userId,
    })
    .select('id')
    .single();
  if (error) throw toAppError(error, 'createSection');
  return data;
}

/**
 * Creates a table and issues its QR in one step.
 *
 * A table without a QR is not much use in a restaurant that takes QR orders,
 * so the link is minted here rather than left as a second thing to remember.
 */
export async function createTable(
  ctx: TenantContext,
  input: { name: string; sectionId?: string | null; seats: number },
) {
  const supabase = createSupabaseServerClient();

  const { data: table, error } = await supabase
    .from('restaurant_tables')
    .insert({
      organization_id: ctx.organizationId,
      branch_id: ctx.branchId,
      section_id: input.sectionId ?? null,
      name: input.name,
      seats: input.seats,
      created_by: ctx.userId,
    })
    .select('id')
    .single();

  if (error?.code === '23505') throw conflict('يوجد طاولة بنفس الاسم في هذا الفرع.');
  if (error) throw toAppError(error, 'createTable');

  await issueTableQr(ctx, table.id);
  return { id: table.id };
}

/** Creates a numeric range of tables, e.g. 1 through 20. */
export async function createTableRange(
  ctx: TenantContext,
  input: { from: number; to: number; seats: number; sectionId?: string | null },
) {
  if (input.to < input.from) throw new AppError('validation', 'نطاق الأرقام غير صحيح.');
  if (input.to - input.from >= 100) {
    throw new AppError('validation', 'أقصى عدد للإنشاء دفعة واحدة هو 100 طاولة.');
  }

  const created: string[] = [];
  for (let n = input.from; n <= input.to; n += 1) {
    try {
      const { id } = await createTable(ctx, {
        name: String(n),
        seats: input.seats,
        sectionId: input.sectionId ?? null,
      });
      created.push(id);
    } catch (error) {
      // A table number that already exists is skipped rather than aborting the
      // whole range — the operator asked for 1-20 and should get the missing ones.
      if (error instanceof AppError && error.code === 'conflict') continue;
      throw error;
    }
  }
  return { created: created.length };
}

/**
 * Mints (or rotates) a table's QR token.
 *
 * The token is generated in the application with a CSPRNG and handed to the
 * database function, which retires the previous link and records the new one
 * with an audit entry. Rotating invalidates whatever was printed before, which
 * is the point: it is how a leaked or mis-stuck code is retired.
 */
export async function issueTableQr(ctx: TenantContext, tableId: string) {
  const supabase = createSupabaseServerClient();
  const token = generatePublicToken();

  const { data, error } = await supabase
    .rpc('restaurant_issue_table_link', {
      p_org: ctx.organizationId,
      p_table: tableId,
      p_token: token,
    })
    .single();

  if (error?.code === '42501') throw new AppError('forbidden');
  if (error) throw toAppError(error, 'issueTableQr');

  const row = data as unknown as { out_link_id: string; out_token: string } | null;
  if (!row) throw new AppError('internal');
  return { linkId: row.out_link_id, token: row.out_token, url: publicUrlForToken(row.out_token) };
}

export async function setTableStatus(ctx: TenantContext, tableId: string, status: TableStatus) {
  const supabase = createSupabaseServerClient();
  const { error } = await supabase
    .from('restaurant_tables')
    .update({ status })
    .eq('organization_id', ctx.organizationId)
    .eq('branch_id', ctx.branchId)
    .eq('id', tableId);

  // 23514 is the table state machine refusing the move.
  if (error?.code === '23514') {
    throw new AppError('conflict', 'لا يمكن الانتقال إلى هذه الحالة من الحالة الحالية.');
  }
  if (error) throw toAppError(error, 'setTableStatus');
}

/**
 * Enable or disable a table without deleting it — the floor plan stays
 * intact, but a broken or removed table drops off the picker until it is
 * re-enabled. Refused while the table has an open order: disabling it out
 * from under a live tab would strand that order with no table to point at.
 */
export async function setTableActive(ctx: TenantContext, tableId: string, isActive: boolean) {
  const supabase = createSupabaseServerClient();

  if (!isActive) {
    const { count } = await supabase
      .from('restaurant_orders')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', ctx.organizationId)
      .eq('table_id', tableId)
      .in('status', ['new', 'confirmed', 'preparing', 'ready', 'served']);
    if (count && count > 0) {
      throw new AppError('conflict', 'لا يمكن تعطيل طاولة عليها طلب مفتوح.');
    }
  }

  const { error } = await supabase
    .from('restaurant_tables')
    .update({ is_active: isActive })
    .eq('organization_id', ctx.organizationId)
    .eq('branch_id', ctx.branchId)
    .eq('id', tableId)
    .is('deleted_at', null);

  if (error) throw toAppError(error, 'setTableActive');
}

/**
 * Soft-delete: sets deleted_at rather than removing the row, so every past
 * order that pointed at this table keeps a table_id that still resolves.
 * listFloor() and every table picker already filter on `deleted_at is null`
 * (see above), so a deleted table simply stops appearing anywhere live.
 */
export async function deleteTable(ctx: TenantContext, tableId: string) {
  const supabase = createSupabaseServerClient();

  const { count } = await supabase
    .from('restaurant_orders')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', ctx.organizationId)
    .eq('table_id', tableId)
    .in('status', ['new', 'confirmed', 'preparing', 'ready', 'served']);
  if (count && count > 0) {
    throw new AppError('conflict', 'لا يمكن حذف طاولة عليها طلب مفتوح.');
  }

  const { error } = await supabase
    .from('restaurant_tables')
    .update({ is_active: false, deleted_at: new Date().toISOString() })
    .eq('organization_id', ctx.organizationId)
    .eq('branch_id', ctx.branchId)
    .eq('id', tableId)
    .is('deleted_at', null);

  if (error) throw toAppError(error, 'deleteTable');
}

/** QR as an SVG string, ready to render inline or print. */
export async function renderQrSvg(url: string): Promise<string> {
  return QRCode.toString(url, {
    type: 'svg',
    margin: 1,
    // High correction so a printed card survives a coffee ring.
    errorCorrectionLevel: 'H',
    width: 320,
  });
}

export async function getTableForPrint(ctx: TenantContext, tableId: string) {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from('restaurant_tables')
    .select('id, name, seats, public_link_id')
    .eq('organization_id', ctx.organizationId)
    .eq('branch_id', ctx.branchId)
    .eq('id', tableId)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw toAppError(error, 'getTableForPrint');
  if (!data) throw notFound();

  if (!data.public_link_id) return { table: data, token: null, url: null, svg: null };

  const { data: link } = await supabase
    .from('public_links')
    .select('token')
    .eq('id', data.public_link_id)
    .eq('is_active', true)
    .maybeSingle();

  if (!link) return { table: data, token: null, url: null, svg: null };

  const url = publicUrlForToken(link.token);
  return { table: data, token: link.token, url, svg: await renderQrSvg(url) };
}
