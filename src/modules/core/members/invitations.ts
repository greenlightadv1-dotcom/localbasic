import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { AppError, toAppError } from '@/lib/errors';
import { requirePermission, type TenantContext } from '@/modules/core/tenancy/context';
import { clientEnv } from '@/lib/env';

/**
 * Inviting a colleague.
 *
 * The token is returned ONCE by `invitation_create` — only its SHA-256 lives
 * in the table, so this is the only moment it is readable and nothing later
 * can print it. The link is handed to the inviter and enqueued for delivery;
 * neither path stores it.
 *
 * Accepting is the invitee's own action under their own session: the token
 * proves which invitation they hold, their session proves who they are, and
 * the database refuses the pair when the email does not match.
 */

export type Invitation = {
  id: string;
  email: string;
  expiresAt: string;
  createdAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
};

function rows<T>(data: unknown): T[] {
  return (Array.isArray(data) ? data : data == null ? [] : [data]) as T[];
}

function statusOf(row: {
  accepted_at: string | null;
  revoked_at: string | null;
  expires_at: string;
}): Invitation['status'] {
  if (row.accepted_at) return 'accepted';
  if (row.revoked_at) return 'revoked';
  if (new Date(row.expires_at).getTime() < Date.now()) return 'expired';
  return 'pending';
}

export async function listInvitations(ctx: TenantContext): Promise<Invitation[]> {
  requirePermission(ctx, 'member.read');
  const supabase = createSupabaseServerClient();

  // The token hash is deliberately not selected. Nothing outside the database
  // has any use for it, and a projection that carries it is one leak away from
  // being useful to an attacker.
  const { data, error } = await supabase
    .from('invitations')
    .select('id, email, expires_at, created_at, accepted_at, revoked_at')
    .eq('organization_id', ctx.organizationId)
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) throw toAppError(error, 'listInvitations');

  return (data ?? []).map((i) => ({
    id: i.id,
    email: i.email,
    expiresAt: i.expires_at,
    createdAt: i.created_at,
    acceptedAt: i.accepted_at,
    revokedAt: i.revoked_at,
    status: statusOf(i),
  }));
}

/** The link an invitee follows. Built from the configured app URL, not a header. */
export function acceptUrl(token: string): string {
  return `${clientEnv.NEXT_PUBLIC_APP_URL.replace(/\/$/, '')}/join/${encodeURIComponent(token)}`;
}

export async function createInvitation(
  ctx: TenantContext,
  input: { email: string; roleIds: string[]; branchIds: string[]; allBranches: boolean },
): Promise<{ id: string; url: string; expiresAt: string }> {
  requirePermission(ctx, 'member.manage');
  const supabase = createSupabaseServerClient();

  const { data, error } = await supabase.rpc('invitation_create', {
    p_org: ctx.organizationId,
    p_email: input.email.trim(),
    p_role_ids: input.roleIds,
    p_branch_ids: input.allBranches ? [] : input.branchIds,
    p_all_branches: input.allBranches,
    p_days: 7,
  });
  if (error) throw new AppError('validation', error.message);

  const row = rows<{ out_id: string; out_token: string; out_expires_at: string }>(data)[0];
  if (!row?.out_token) throw new AppError('validation', 'تعذّر إنشاء الدعوة');

  const url = acceptUrl(row.out_token);

  // Only the application can build this link: it holds the token for the one
  // moment it exists, and knows the site's address. Enqueuing goes through a
  // definer function because `notifications` has no insert policy — the outbox
  // is not somewhere a tenant session may post arbitrary mail — and it is
  // idempotent on the invitation id, so a retry cannot send twice.
  const { error: queueError } = await supabase.rpc('invitation_enqueue_email', {
    p_org: ctx.organizationId,
    p_invitation: row.out_id,
    p_accept_url: url,
  });
  // A mail provider or queue problem must not fail the invitation the manager
  // just created: the link is on screen and can be handed over directly.
  if (queueError) console.error('[localbasic] invitation enqueue', queueError.message);

  return { id: row.out_id, url, expiresAt: row.out_expires_at };
}

export async function revokeInvitation(ctx: TenantContext, id: string): Promise<void> {
  requirePermission(ctx, 'member.manage');
  const supabase = createSupabaseServerClient();

  const { error } = await supabase.rpc('invitation_revoke', {
    p_org: ctx.organizationId,
    p_id: id,
  });
  if (error) throw new AppError('validation', error.message);
}

export type InvitationPreview = {
  organizationName: string;
  email: string;
  expired: boolean;
  alreadyUsed: boolean;
};

/** What a visitor following the link is told, before they sign in. */
export async function previewInvitation(token: string): Promise<InvitationPreview | null> {
  const supabase = createSupabaseServerClient();

  const { data, error } = await supabase.rpc('invitation_preview', { p_token: token });
  if (error) return null;

  const row = rows<{
    out_organization_name: string; out_email: string;
    out_expired: boolean; out_already_used: boolean;
  }>(data)[0];
  if (!row?.out_organization_name) return null;

  return {
    organizationName: row.out_organization_name,
    email: row.out_email,
    expired: Boolean(row.out_expired),
    alreadyUsed: Boolean(row.out_already_used),
  };
}

/** Accept, as the signed-in user. Returns where to send them next. */
export async function acceptInvitation(
  token: string,
): Promise<{ organizationSlug: string }> {
  const supabase = createSupabaseServerClient();

  const { data, error } = await supabase.rpc('invitation_accept', { p_token: token });
  if (error) throw new AppError('validation', error.message);

  const row = rows<{ out_organization_id: string; out_organization_slug: string }>(data)[0];
  if (!row?.out_organization_slug) throw new AppError('validation', 'تعذّر قبول الدعوة');

  return { organizationSlug: row.out_organization_slug };
}
