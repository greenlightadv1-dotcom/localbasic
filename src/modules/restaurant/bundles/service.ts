import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { toAppError } from '@/lib/errors';
import type { TenantContext } from '@/modules/core/tenancy/context';
import type { BundleInput } from './schemas';

export type Bundle = {
  id: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  priceCents: number;
  isActive: boolean;
  sortOrder: number;
};

/** Staff-facing list: active and deactivated alike, for the manage screen. */
export async function listBundles(ctx: TenantContext): Promise<Bundle[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from('restaurant_bundles')
    .select('id, name, description, image_url, price_cents, is_active, sort_order')
    .eq('organization_id', ctx.organizationId)
    .order('sort_order')
    .order('name');

  if (error) throw toAppError(error, 'listBundles');

  return (data ?? []).map((b) => ({
    id: b.id,
    name: b.name,
    description: b.description,
    imageUrl: b.image_url,
    priceCents: b.price_cents,
    isActive: b.is_active,
    sortOrder: b.sort_order,
  }));
}

export async function createBundle(ctx: TenantContext, input: BundleInput): Promise<string> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from('restaurant_bundles')
    .insert({
      organization_id: ctx.organizationId,
      name: input.name,
      description: input.description || null,
      image_url: input.imageUrl || null,
      price_cents: input.priceCents,
      created_by: ctx.userId,
    })
    .select('id')
    .single();

  if (error) throw toAppError(error, 'createBundle');
  return data.id;
}

export async function setBundleActive(
  ctx: TenantContext,
  bundleId: string,
  isActive: boolean,
): Promise<void> {
  const supabase = createSupabaseServerClient();
  const { error } = await supabase
    .from('restaurant_bundles')
    .update({ is_active: isActive })
    .eq('organization_id', ctx.organizationId)
    .eq('id', bundleId);
  if (error) throw toAppError(error, 'setBundleActive');
}
