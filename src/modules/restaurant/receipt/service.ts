import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { AppError, toAppError, toDataUnavailable } from '@/lib/errors';
import { requirePermission, type TenantContext } from '@/modules/core/tenancy/context';
import type { ReceiptSettingsInput } from './schema';

/** What the owner's form edits, plus the branch's own details used as fallbacks. */
export type ReceiptSettings = ReceiptSettingsInput & {
  branchName: string;
  branchDefaultAddress: string | null;
  branchDefaultPhone: string | null;
};

/** What the printed receipt needs, already resolved against the fallbacks. */
export type ReceiptHeader = {
  legalName: string | null;
  commercialRegistration: string | null;
  taxId: string | null;
  headerNote: string | null;
  footerNote: string | null;
  branchName: string | null;
  address: string | null;
  phone: string | null;
};

type Row = {
  out_legal_name: string | null; out_commercial_registration: string | null; out_tax_id: string | null;
  out_header_note: string | null; out_footer_note: string | null;
  out_branch_display_name: string | null; out_branch_address: string | null; out_branch_phone: string | null;
  out_branch_name: string; out_branch_default_address: string | null; out_branch_default_phone: string | null;
};

export async function getReceiptSettings(ctx: TenantContext): Promise<ReceiptSettings> {
  requirePermission(ctx, 'settings.manage');
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .rpc('restaurant_receipt_settings_get', { p_org: ctx.organizationId, p_branch: ctx.branchId })
    .single();
  if (error) throw toDataUnavailable(error, 'getReceiptSettings');
  const r = data as unknown as Row;
  return {
    legalName: r.out_legal_name ?? '',
    commercialRegistration: r.out_commercial_registration ?? '',
    taxId: r.out_tax_id ?? '',
    headerNote: r.out_header_note ?? '',
    footerNote: r.out_footer_note ?? '',
    branchDisplayName: r.out_branch_display_name ?? '',
    branchAddress: r.out_branch_address ?? '',
    branchPhone: r.out_branch_phone ?? '',
    branchName: r.out_branch_name,
    branchDefaultAddress: r.out_branch_default_address,
    branchDefaultPhone: r.out_branch_default_phone,
  };
}

/** Saves the organization's details and THIS branch's details (the branch comes from the URL). */
export async function saveReceiptSettings(ctx: TenantContext, input: ReceiptSettingsInput): Promise<void> {
  requirePermission(ctx, 'settings.manage');
  const supabase = createSupabaseServerClient();
  const { error } = await supabase.rpc('restaurant_receipt_settings_save', {
    p_org: ctx.organizationId,
    p_branch: ctx.branchId,
    p_legal_name: input.legalName,
    p_commercial_registration: input.commercialRegistration,
    p_tax_id: input.taxId,
    p_header_note: input.headerNote,
    p_footer_note: input.footerNote,
    p_branch_display_name: input.branchDisplayName,
    p_branch_address: input.branchAddress,
    p_branch_phone: input.branchPhone,
  });
  // The function's own Arabic validation messages are safe to show.
  if (error?.code === '22023' && /[؀-ۿ]/.test(error.message)) {
    throw new AppError('validation', error.message);
  }
  if (error) throw toAppError(error, 'saveReceiptSettings');
}

/**
 * For printing. Needs only invoice.read at this branch (cashiers), checked by
 * the database. Never fails the print: if the details cannot be read (for
 * example, before migration 0101 is applied) the receipt prints without them.
 */
export async function getReceiptHeader(ctx: TenantContext): Promise<ReceiptHeader | null> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .rpc('restaurant_receipt_header', { p_org: ctx.organizationId, p_branch: ctx.branchId })
    .maybeSingle();
  if (error || !data) {
    if (error) console.error('[localbasic] getReceiptHeader', error);
    return null;
  }
  const r = data as unknown as Row;
  return {
    legalName: r.out_legal_name,
    commercialRegistration: r.out_commercial_registration,
    taxId: r.out_tax_id,
    headerNote: r.out_header_note,
    footerNote: r.out_footer_note,
    branchName: r.out_branch_display_name ?? r.out_branch_name,
    address: r.out_branch_address ?? r.out_branch_default_address,
    phone: r.out_branch_phone ?? r.out_branch_default_phone,
  };
}
