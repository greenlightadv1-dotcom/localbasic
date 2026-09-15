import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requirePlatformAdmin } from '@/modules/platform/admin/context';
import { AppError } from '@/lib/errors';
import {
  LEAD_STATUSES, createLeadInput, updateLeadInput, type LeadStatus,
} from './schemas';

export * from './schemas';

export type Lead = {
  id: string;
  name: string;
  phone: string;
  businessName: string | null;
  requestedService: string | null;
  source: string;
  status: LeadStatus;
  notes: string | null;
  organizationId: string | null;
  createdAt: string;
  updatedAt: string;
};

export async function listLeads(opts: { search?: string; status?: string } = {}): Promise<Lead[]> {
  await requirePlatformAdmin();
  const supabase = createSupabaseServerClient();

  let query = supabase
    .from('platform_leads')
    .select('id, name, phone, business_name, requested_service, source, status, notes, organization_id, created_at, updated_at')
    .order('created_at', { ascending: false })
    .limit(200);

  const term = opts.search?.trim();
  if (term) query = query.or(`name.ilike.%${term}%,phone.ilike.%${term}%,business_name.ilike.%${term}%`);
  if (opts.status && LEAD_STATUSES.includes(opts.status as LeadStatus)) {
    query = query.eq('status', opts.status);
  }

  const { data, error } = await query;
  if (error) throw error;

  return (data ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    phone: r.phone,
    businessName: r.business_name,
    requestedService: r.requested_service,
    source: r.source,
    status: r.status as LeadStatus,
    notes: r.notes,
    organizationId: r.organization_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export async function getLead(id: string): Promise<Lead | null> {
  const rows = await listLeads();
  return rows.find((l) => l.id === id) ?? null;
}

export async function createLead(input: unknown): Promise<string> {
  await requirePlatformAdmin();
  const parsed = createLeadInput.safeParse(input);
  if (!parsed.success) {
    throw new AppError('validation', parsed.error.issues[0]?.message ?? 'بيانات غير صالحة');
  }

  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from('platform_leads')
    .insert({
      name: parsed.data.name,
      phone: parsed.data.phone,
      business_name: parsed.data.businessName || null,
      requested_service: parsed.data.requestedService || null,
      source: parsed.data.source,
      notes: parsed.data.notes || null,
    })
    .select('id')
    .single();
  if (error) throw new AppError('validation', error.message);

  await writeLeadAudit('platform.lead_created', data.id, {
    name: parsed.data.name,
    source: parsed.data.source,
  });
  return data.id;
}

export async function updateLead(input: unknown): Promise<void> {
  await requirePlatformAdmin();
  const parsed = updateLeadInput.safeParse(input);
  if (!parsed.success) throw new AppError('validation', 'بيانات غير صالحة');

  const supabase = createSupabaseServerClient();
  const before = await getLead(parsed.data.id);
  if (!before) throw new AppError('not_found');

  const { error } = await supabase
    .from('platform_leads')
    .update({ status: parsed.data.status, notes: parsed.data.notes || null })
    .eq('id', parsed.data.id);
  if (error) throw new AppError('validation', error.message);

  // Only a status change is worth an audit line; editing a note is not a
  // pipeline event.
  if (before.status !== parsed.data.status) {
    await writeLeadAudit('platform.lead_status_changed', parsed.data.id, {
      from: before.status,
      to: parsed.data.status,
    });
  }
}

/**
 * Platform events have no organization, so they go through
 * write_platform_audit(), which allows a null organization_id only for actions
 * prefixed `platform.` — see migration 0035.
 */
async function writeLeadAudit(
  action: string,
  leadId: string,
  detail: Record<string, unknown>,
): Promise<void> {
  const supabase = createSupabaseServerClient();
  const { data } = await supabase
    .from('platform_leads')
    .select('organization_id')
    .eq('id', leadId)
    .maybeSingle();

  await supabase.rpc('write_platform_audit', {
    p_action: action,
    p_entity_type: 'lead',
    p_entity_id: leadId,
    p_after: detail,
    p_org: data?.organization_id ?? undefined,
  });
}
