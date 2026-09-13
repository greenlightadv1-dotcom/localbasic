'use server';

import { redirect } from 'next/navigation';
import { defineUserAction } from '@/lib/action';
import { RATE_LIMITS } from '@/lib/rate-limit';
import {
  provisionWorkspace,
  provisionWorkspaceSchema,
} from '@/modules/core/tenancy/service';

/**
 * Provisioning is rate limited hard: creating workspaces is cheap for an
 * attacker and expensive for the platform.
 */
const provision = defineUserAction({
  schema: provisionWorkspaceSchema,
  rateLimit: RATE_LIMITS.provisionWorkspace,
  handler: async ({ input }) => provisionWorkspace(input),
});

export type OnboardingState = { error?: string; fieldErrors?: Record<string, string[]> } | undefined;

export async function provisionWorkspaceAction(
  _prev: OnboardingState,
  formData: FormData,
): Promise<OnboardingState> {
  const result = await provision({
    organizationName: formData.get('organizationName'),
    slug: formData.get('slug'),
    moduleKey: formData.get('moduleKey'),
    branchName: formData.get('branchName') || undefined,
    country: formData.get('country') || 'EG',
    currency: formData.get('currency') || 'EGP',
    timezone: formData.get('timezone') || 'Africa/Cairo',
  });

  if (!result.ok) {
    return { error: result.error, fieldErrors: result.fieldErrors };
  }

  redirect(`/${result.data.organizationSlug}`);
}
