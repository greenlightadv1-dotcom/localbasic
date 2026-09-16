'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { resolveTenantContext } from '@/modules/core/tenancy/context';
import {
  addSection, moveSection, publishWebsite, removeSection, saveTheme,
  unpublishWebsite, updateSection,
} from '@/modules/restaurant/website/builder';
import { AppError } from '@/lib/errors';

export type BuilderState = { error?: string } | undefined;

/**
 * Builder mutations.
 *
 * Each one resolves the tenant from the URL — never from the form — and the
 * service re-checks `settings.manage` before touching a row. The form
 * contributes content only; it names no organization and no permission.
 *
 * `revalidatePath` discards a Server Action's return value, so success travels
 * in the URL and failures return before any revalidation happens.
 */
async function ctxFrom(formData: FormData) {
  return resolveTenantContext(
    String(formData.get('orgSlug') ?? ''),
    String(formData.get('branchSlug') ?? ''),
  );
}

function builderPath(formData: FormData, suffix = '') {
  const org = String(formData.get('orgSlug') ?? '');
  const branch = String(formData.get('branchSlug') ?? '');
  return `/${org}/${branch}/settings/website/builder${suffix}`;
}

export async function addSectionAction(formData: FormData) {
  const ctx = await ctxFrom(formData);
  try {
    await addSection(ctx, String(formData.get('type') ?? ''));
  } catch (error) {
    const message = error instanceof AppError ? error.message : 'تعذّر إضافة القسم.';
    redirect(builderPath(formData, `?error=${encodeURIComponent(message)}`));
  }
  revalidatePath(builderPath(formData));
  redirect(builderPath(formData, '?saved=1'));
}

export async function moveSectionAction(formData: FormData) {
  const ctx = await ctxFrom(formData);
  const direction = formData.get('direction') === 'up' ? 'up' : 'down';
  try {
    await moveSection(ctx, String(formData.get('id') ?? ''), direction);
  } catch {
    // A section that is not this restaurant's simply does not move. There is
    // nothing to report that would not also confirm it exists.
  }
  revalidatePath(builderPath(formData));
  redirect(builderPath(formData));
}

export async function removeSectionAction(formData: FormData) {
  const ctx = await ctxFrom(formData);
  try {
    await removeSection(ctx, String(formData.get('id') ?? ''));
  } catch {
    /* see above */
  }
  revalidatePath(builderPath(formData));
  redirect(builderPath(formData, '?saved=1'));
}

export async function saveSectionAction(
  _prev: BuilderState,
  formData: FormData,
): Promise<BuilderState> {
  const ctx = await ctxFrom(formData);
  const type = String(formData.get('type') ?? '');

  // Only the fields this section type actually has. Anything else in the body
  // is ignored here and would be refused by the schema anyway.
  const text = (name: string) => {
    const v = formData.get(name);
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
  };
  const flag = (name: string) => formData.get(name) === 'on';

  const config: Record<string, unknown> = {};
  switch (type) {
    case 'hero':
      Object.assign(config, {
        title: text('title'), subtitle: text('subtitle'), imageUrl: text('imageUrl'),
        buttonLabel: text('buttonLabel'), showOrderButton: flag('showOrderButton'),
      });
      break;
    case 'about':
      Object.assign(config, {
        title: text('title'), body: text('body'), imageUrl: text('imageUrl'),
      });
      break;
    case 'menu':
      Object.assign(config, {
        title: text('title'), subtitle: text('subtitle'), showPrices: flag('showPrices'),
      });
      break;
    case 'gallery':
      Object.assign(config, {
        title: text('title'),
        images: formData
          .getAll('images')
          .map((v) => String(v).trim())
          .filter((v) => v !== ''),
      });
      break;
    case 'contact':
      Object.assign(config, {
        title: text('title'), subtitle: text('subtitle'),
        showPhone: flag('showPhone'), showWhatsapp: flag('showWhatsapp'),
        showEmail: flag('showEmail'),
      });
      break;
    case 'hours':
      Object.assign(config, { title: text('title') });
      break;
    case 'branches':
      Object.assign(config, { title: text('title'), showAddresses: flag('showAddresses') });
      break;
    case 'cta':
      Object.assign(config, {
        title: text('title'), subtitle: text('subtitle'),
        buttonLabel: text('buttonLabel'), buttonTarget: text('buttonTarget'),
      });
      break;
    default:
      return { error: 'قسم غير معروف.' };
  }

  // Undefined keys would fail `.strict()` parsing as present-but-empty.
  for (const key of Object.keys(config)) {
    if (config[key] === undefined) delete config[key];
  }

  try {
    await updateSection(ctx, {
      id: String(formData.get('id') ?? ''),
      type,
      enabled: flag('enabled'),
      config,
    });
  } catch (error) {
    return { error: error instanceof AppError ? error.message : 'تعذّر حفظ القسم.' };
  }

  revalidatePath(builderPath(formData));
  redirect(builderPath(formData, '?saved=1'));
}

export async function saveThemeAction(
  _prev: BuilderState,
  formData: FormData,
): Promise<BuilderState> {
  const ctx = await ctxFrom(formData);
  try {
    await saveTheme(ctx, {
      primaryColor: String(formData.get('primaryColor') ?? ''),
      accentColor: String(formData.get('accentColor') ?? ''),
      background: String(formData.get('background') ?? 'light'),
      font: String(formData.get('font') ?? 'system'),
      buttonStyle: String(formData.get('buttonStyle') ?? 'rounded'),
      width: String(formData.get('width') ?? 'normal'),
    });
  } catch (error) {
    return { error: error instanceof AppError ? error.message : 'تعذّر حفظ المظهر.' };
  }

  revalidatePath(builderPath(formData));
  redirect(builderPath(formData, '?saved=1'));
}

/**
 * Publish.
 *
 * The draft is snapshotted inside the database; this sends a slug and a note
 * and nothing else, so the published content cannot differ from what the
 * builder holds.
 */
export async function publishAction(
  _prev: BuilderState,
  formData: FormData,
): Promise<BuilderState> {
  const ctx = await ctxFrom(formData);
  let version: number;
  try {
    ({ version } = await publishWebsite(ctx, String(formData.get('note') ?? '')));
  } catch (error) {
    return { error: error instanceof AppError ? error.message : 'تعذّر نشر الموقع.' };
  }

  revalidatePath(builderPath(formData));
  // The public pages are force-dynamic, so there is no published output to
  // invalidate — the next visitor reads the new live revision.
  redirect(builderPath(formData, `?published=${version}`));
}

export async function unpublishAction(formData: FormData) {
  const ctx = await ctxFrom(formData);
  try {
    await unpublishWebsite(ctx);
  } catch {
    /* nothing actionable to report */
  }
  revalidatePath(builderPath(formData));
  redirect(builderPath(formData, '?unpublished=1'));
}
