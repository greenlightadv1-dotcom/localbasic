'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { definePlatformAction } from '@/lib/action';
import { updateAppearanceSchema } from '@/modules/sites/schemas';
import {
  platformPublishSite,
  platformRollbackSite,
  platformUnpublishSite,
  platformUpdateTheme,
} from '@/modules/platform/sites/service';

/**
 * Platform Admin's Site Engine writes.
 *
 * Every one goes through definePlatformAction, which resolves the Platform
 * Admin identity and rate-limits before the schema is even parsed — an
 * authorization written once, here, matching how defineTenantAction does it
 * for the org-side editor's own actions.ts.
 *
 * The customer code and site id travel as form fields because they name
 * WHICH row to act on, not who may act on it: the service re-resolves both
 * against `platform_site_*` (0061), so a code or id naming another customer
 * resolves to "not found" rather than to their data.
 */

export type FormState = { error?: string; fieldErrors?: Record<string, string[]> } | undefined;

function sitePath(code: string, siteId: string) {
  return `/admin/customers/${encodeURIComponent(code)}/sites/${siteId}`;
}

const noInput = z.object({}).strict();

export async function platformUpdateThemeAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const code = String(formData.get('code') ?? '');
  const siteId = String(formData.get('siteId') ?? '');

  const run = definePlatformAction({
    schema: updateAppearanceSchema,
    handler: async ({ input }) => platformUpdateTheme(code, siteId, input),
  });

  const result = await run({
    direction: formData.get('direction'),
    locale: formData.get('locale'),
    primary: formData.get('primary'),
    background: formData.get('background'),
    foreground: formData.get('foreground'),
    border: formData.get('border'),
  });
  if (!result.ok) return { error: result.error, fieldErrors: result.fieldErrors };

  revalidatePath(sitePath(code, siteId));
  redirect(`${sitePath(code, siteId)}/theme?saved=1`);
}

export async function platformPublishSiteAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const code = String(formData.get('code') ?? '');
  const siteId = String(formData.get('siteId') ?? '');
  const note = String(formData.get('note') ?? '').trim();

  const run = definePlatformAction({
    schema: noInput,
    handler: async () => platformPublishSite(code, siteId, note || undefined),
  });

  const result = await run({});
  if (!result.ok) return { error: result.error, fieldErrors: result.fieldErrors };

  revalidatePath(sitePath(code, siteId));
  redirect(`${sitePath(code, siteId)}?published=${result.data.version}`);
}

export async function platformRollbackSiteAction(formData: FormData): Promise<void> {
  const code = String(formData.get('code') ?? '');
  const siteId = String(formData.get('siteId') ?? '');
  const revisionId = String(formData.get('revisionId') ?? '');

  const run = definePlatformAction({
    schema: noInput,
    handler: async () => platformRollbackSite(code, siteId, revisionId),
  });

  const result = await run({});
  revalidatePath(sitePath(code, siteId));
  redirect(
    result.ok
      ? `${sitePath(code, siteId)}?restored=${result.data.version}`
      : `${sitePath(code, siteId)}?error=${encodeURIComponent(result.error)}`,
  );
}

export async function platformUnpublishSiteAction(formData: FormData): Promise<void> {
  const code = String(formData.get('code') ?? '');
  const siteId = String(formData.get('siteId') ?? '');

  const run = definePlatformAction({
    schema: noInput,
    handler: async () => platformUnpublishSite(code, siteId),
  });

  const result = await run({});
  revalidatePath(sitePath(code, siteId));
  redirect(
    result.ok
      ? `${sitePath(code, siteId)}?unpublished=1`
      : `${sitePath(code, siteId)}?error=${encodeURIComponent(result.error)}`,
  );
}
