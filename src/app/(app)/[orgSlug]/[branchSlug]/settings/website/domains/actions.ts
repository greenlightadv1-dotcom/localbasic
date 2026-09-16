'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { resolveTenantContext } from '@/modules/core/tenancy/context';
import {
  addDomain, removeDomain, setDomainStatus, setPrimaryDomain, verifyDomain,
} from '@/modules/restaurant/website/domains';
import { AppError } from '@/lib/errors';

export type DomainState = { error?: string } | undefined;

/**
 * Domain mutations.
 *
 * Each resolves the tenant from the URL — never from the form — and the
 * service re-checks `settings.manage` before the database checks it again.
 */
async function ctxFrom(formData: FormData) {
  return resolveTenantContext(
    String(formData.get('orgSlug') ?? ''),
    String(formData.get('branchSlug') ?? ''),
  );
}

function domainsPath(formData: FormData, suffix = '') {
  const org = String(formData.get('orgSlug') ?? '');
  const branch = String(formData.get('branchSlug') ?? '');
  return `/${org}/${branch}/settings/website/domains${suffix}`;
}

/**
 * Add a domain.
 *
 * The challenge value comes back once and travels in the URL so the page can
 * show it. It is never stored anywhere on our side beyond its hash, and it
 * disappears the moment the operator navigates away — which is why the page
 * tells them to copy it now.
 */
export async function addDomainAction(
  _prev: DomainState,
  formData: FormData,
): Promise<DomainState> {
  const ctx = await ctxFrom(formData);
  let added: Awaited<ReturnType<typeof addDomain>>;
  try {
    added = await addDomain(ctx, String(formData.get('hostname') ?? ''));
  } catch (error) {
    return { error: error instanceof AppError ? error.message : 'تعذّر إضافة النطاق.' };
  }

  revalidatePath(domainsPath(formData));
  redirect(
    domainsPath(
      formData,
      `?added=${encodeURIComponent(added.hostname)}&token=${encodeURIComponent(added.token)}`,
    ),
  );
}

/**
 * Verify a domain.
 *
 * The form carries the domain id and nothing else about the check: the
 * hostname to look up and the TXT values to compare are both obtained
 * server-side. A forged field cannot aim the lookup or supply an answer —
 * see `verifyDomain` and migration 0044.
 */
export async function verifyDomainAction(formData: FormData) {
  const ctx = await ctxFrom(formData);
  const id = String(formData.get('id') ?? '');

  let result: Awaited<ReturnType<typeof verifyDomain>> | null = null;
  try {
    result = await verifyDomain(ctx, id);
  } catch {
    // A domain that is not this restaurant's does not verify, and there is
    // nothing to report that would not also confirm it exists.
  }

  revalidatePath(domainsPath(formData));
  redirect(domainsPath(formData, result?.verified ? '?verified=1' : '?unverified=1'));
}

export async function setStatusAction(formData: FormData) {
  const ctx = await ctxFrom(formData);
  const status = formData.get('status') === 'active' ? 'active' : 'disabled';
  try {
    await setDomainStatus(ctx, String(formData.get('id') ?? ''), status);
  } catch (error) {
    const message = error instanceof AppError ? error.message : 'تعذّر تغيير الحالة.';
    redirect(domainsPath(formData, `?error=${encodeURIComponent(message)}`));
  }
  revalidatePath(domainsPath(formData));
  redirect(domainsPath(formData, status === 'active' ? '?activated=1' : '?disabled=1'));
}

export async function setPrimaryAction(formData: FormData) {
  const ctx = await ctxFrom(formData);
  try {
    await setPrimaryDomain(ctx, String(formData.get('id') ?? ''));
  } catch {
    /* nothing actionable to report */
  }
  revalidatePath(domainsPath(formData));
  redirect(domainsPath(formData, '?saved=1'));
}

export async function removeDomainAction(formData: FormData) {
  const ctx = await ctxFrom(formData);
  try {
    await removeDomain(ctx, String(formData.get('id') ?? ''));
  } catch {
    /* see above */
  }
  revalidatePath(domainsPath(formData));
  redirect(domainsPath(formData, '?removed=1'));
}
