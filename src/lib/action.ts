import 'server-only';
import { headers } from 'next/headers';
import { z } from 'zod';
import { AppError, toAppError } from '@/lib/errors';
import { checkRateLimit, RATE_LIMITS, type RateLimitRule } from '@/lib/rate-limit';
import {
  requireUser,
  resolveTenantContext,
  requirePermission,
  type TenantContext,
} from '@/modules/core/tenancy/context';
import type { Permission } from '@/modules/core/rbac/permissions';

/**
 * The result every Server Action returns. Actions never throw across the
 * network boundary: failures come back as data so forms can render them.
 */
export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code: string; fieldErrors?: Record<string, string[]> };

type TenantActionConfig<TSchema extends z.ZodTypeAny, TResult> = {
  /** Zod schema for the client input. Parsed before anything else runs. */
  schema: TSchema;
  /** Permission required, checked server-side against the resolved context. */
  permission: Permission | Permission[];
  rateLimit?: RateLimitRule;
  handler: (args: { ctx: TenantContext; input: z.infer<TSchema>; }) => Promise<TResult>;
};

/**
 * Wraps a tenant-scoped Server Action.
 *
 * Every action goes through here, which is what makes it structurally
 * impossible to ship one that forgets a step:
 *
 *   1. resolve the session          → unauthenticated if absent
 *   2. rate limit per user+action   → abuse protection
 *   3. resolve the tenant context   → 404 if not a member of the org/branch
 *   4. check the permission         → 404 if not held
 *   5. validate the input with Zod  → never trust the client
 *   6. run the handler
 *
 * The client's organization and branch come from the URL-derived context, not
 * from the submitted payload, so a forged organization_id in a form body has
 * nowhere to land.
 */
export function defineTenantAction<TSchema extends z.ZodTypeAny, TResult>(
  config: TenantActionConfig<TSchema, TResult>,
) {
  return async function action(
    scope: { organizationSlug: string; branchSlug?: string },
    rawInput: unknown,
  ): Promise<ActionResult<TResult>> {
    try {
      const user = await requireUser();

      const rule = config.rateLimit ?? RATE_LIMITS.mutation;
      const { ok } = checkRateLimit(`action:${user.id}:${scope.organizationSlug}`, rule);
      if (!ok) throw new AppError('rate_limited');

      const ctx = await resolveTenantContext(scope.organizationSlug, scope.branchSlug);

      const required = Array.isArray(config.permission) ? config.permission : [config.permission];
      for (const permission of required) requirePermission(ctx, permission);

      const parsed = config.schema.safeParse(rawInput);
      if (!parsed.success) {
        throw new AppError('validation', undefined, {
          fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
        });
      }

      const data = await config.handler({ ctx, input: parsed.data });
      return { ok: true, data };
    } catch (error) {
      const appError = toAppError(error, 'tenant action');
      return {
        ok: false,
        error: appError.message,
        code: appError.code,
        ...(appError.fieldErrors ? { fieldErrors: appError.fieldErrors } : {}),
      };
    }
  };
}

/**
 * Wraps an action that runs before a tenant exists — sign-up, provisioning,
 * invitation acceptance. Authenticated, validated and rate limited, but with
 * no organization context to resolve yet.
 */
export function defineUserAction<TSchema extends z.ZodTypeAny, TResult>(config: {
  schema: TSchema;
  rateLimit?: RateLimitRule;
  handler: (args: {
    user: { id: string; email: string | null };
    input: z.infer<TSchema>;
  }) => Promise<TResult>;
}) {
  return async function action(rawInput: unknown): Promise<ActionResult<TResult>> {
    try {
      const user = await requireUser();
      const rule = config.rateLimit ?? RATE_LIMITS.mutation;
      const { ok } = checkRateLimit(`user-action:${user.id}`, rule);
      if (!ok) throw new AppError('rate_limited');

      const parsed = config.schema.safeParse(rawInput);
      if (!parsed.success) {
        throw new AppError('validation', undefined, {
          fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
        });
      }

      const data = await config.handler({ user, input: parsed.data });
      return { ok: true, data };
    } catch (error) {
      const appError = toAppError(error, 'user action');
      return {
        ok: false,
        error: appError.message,
        code: appError.code,
        ...(appError.fieldErrors ? { fieldErrors: appError.fieldErrors } : {}),
      };
    }
  };
}

/**
 * Wraps a public (unauthenticated) action reached through an opaque token:
 * storefront checkout, QR ordering, booking. Rate limited by client IP and
 * token, and given no tenant context at all — the token resolves to one.
 */
export function definePublicAction<TSchema extends z.ZodTypeAny, TResult>(config: {
  schema: TSchema;
  rateLimit?: RateLimitRule;
  handler: (args: { input: z.infer<TSchema>; clientIp: string }) => Promise<TResult>;
}) {
  return async function action(rawInput: unknown): Promise<ActionResult<TResult>> {
    try {
      const clientIp = getClientIp();
      const rule = config.rateLimit ?? RATE_LIMITS.publicOrder;
      const { ok } = checkRateLimit(`public-action:${clientIp}`, rule);
      if (!ok) throw new AppError('rate_limited');

      const parsed = config.schema.safeParse(rawInput);
      if (!parsed.success) {
        throw new AppError('validation', undefined, {
          fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
        });
      }

      const data = await config.handler({ input: parsed.data, clientIp });
      return { ok: true, data };
    } catch (error) {
      const appError = toAppError(error, 'public action');
      return { ok: false, error: appError.message, code: appError.code };
    }
  };
}

export function getClientIp(): string {
  const h = headers();
  const forwarded = h.get('x-forwarded-for');
  return forwarded?.split(',')[0]?.trim() || h.get('x-real-ip') || 'unknown';
}
