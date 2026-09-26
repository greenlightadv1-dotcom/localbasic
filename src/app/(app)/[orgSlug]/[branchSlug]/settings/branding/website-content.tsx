'use client';

import { useState } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import { saveWebsiteAction, type WebsiteState } from '../website/actions';
import { WEEKDAYS_AR } from '@/modules/restaurant/website/shared';
import type { WebsiteSettings } from '@/modules/restaurant/website/settings';
import { ImageUpload } from '@/components/patterns/image-upload';

const FIELD = 'w-full rounded-lg border border-line bg-elevated px-3 text-sm text-fg';

function Save() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="h-12 w-full rounded-lg bg-primary text-base font-semibold text-primary-fg hover:bg-primary/90 disabled:opacity-50 sm:w-auto sm:px-8"
    >
      {pending ? 'جارٍ الحفظ…' : 'حفظ محتوى الموقع'}
    </button>
  );
}

/**
 * The restaurant's public website content: publish toggle, tagline, about,
 * cover image and opening hours. Previously its own settings/website screen
 * — folded in here so brand identity and site content are one dashboard,
 * not two. saveWebsiteAction/getWebsiteSettings are unchanged; only where
 * this form lives moved.
 */
export function WebsiteContentSection({
  organizationId,
  orgSlug,
  branchSlug,
  settings,
}: {
  organizationId: string;
  orgSlug: string;
  branchSlug: string;
  settings: WebsiteSettings;
}) {
  const [state, action] = useFormState<WebsiteState, FormData>(saveWebsiteAction, undefined);
  const [closed, setClosed] = useState<boolean[]>(settings.hours.map((d) => d.closed));
  const [heroUrl, setHeroUrl] = useState<string | null>(settings.heroUrl || null);

  return (
    <form action={action} className="space-y-6">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="branchSlug" value={branchSlug} />
      <input type="hidden" name="heroUrl" value={heroUrl ?? ''} />

      {state?.error ? (
        <p className="rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          {state.error}
        </p>
      ) : null}

      <label className="flex cursor-pointer items-start justify-between gap-4 rounded-lg border border-line bg-surface p-4">
        <span>
          <span className="block font-semibold text-fg">نشر الموقع</span>
          <span className="mt-0.5 block text-sm text-muted">
            عند الإيقاف لا يظهر الموقع للعامة إطلاقًا.
          </span>
        </span>
        <input
          type="checkbox"
          name="enabled"
          defaultChecked={settings.enabled}
          className="mt-1 h-6 w-6 shrink-0 rounded border-line accent-primary"
        />
      </label>

      <label className="block">
        <span className="mb-1.5 block font-semibold text-fg">الوصف المختصر</span>
        <span className="mb-2 block text-sm text-muted">سطر قصير يظهر أسفل اسم المطعم.</span>
        <input name="tagline" maxLength={200} defaultValue={settings.tagline}
          className={`${FIELD} h-12`} />
      </label>

      <label className="block">
        <span className="mb-1.5 block font-semibold text-fg">عن المطعم</span>
        <textarea name="about" maxLength={2000} rows={5} defaultValue={settings.about}
          className={`${FIELD} py-2 leading-relaxed`} />
      </label>

      <div>
        <span className="mb-1.5 block font-semibold text-fg">صورة الغلاف</span>
        <span className="mb-2 block text-sm text-muted">
          اتركها فارغة لاستخدام خلفية بألوان المطعم.
        </span>
        <ImageUpload
          organizationId={organizationId}
          purpose="banner"
          value={heroUrl}
          onChange={setHeroUrl}
          label="صورة الغلاف"
        />
      </div>

      <fieldset className="rounded-lg border border-line bg-surface p-4">
        <legend className="px-1 font-semibold text-fg">مواعيد العمل</legend>
        <div className="mt-2 space-y-2">
          {WEEKDAYS_AR.map((day, i) => (
            <div key={day} className="flex flex-wrap items-center gap-2">
              <span className="w-20 text-sm text-fg">{day}</span>
              <label className="flex items-center gap-1.5 text-sm text-muted">
                <input
                  type="checkbox"
                  name={`closed-${i}`}
                  defaultChecked={settings.hours[i]?.closed}
                  onChange={(e) =>
                    setClosed((c) => c.map((v, j) => (j === i ? e.target.checked : v)))
                  }
                  className="h-5 w-5 rounded border-line accent-primary"
                />
                مغلق
              </label>
              {!closed[i] ? (
                <>
                  <input type="time" name={`opens-${i}`}
                    defaultValue={settings.hours[i]?.opens ?? '12:00'}
                    aria-label={`${day} من`}
                    className="h-10 rounded-lg border border-line bg-elevated px-2 text-sm text-fg" />
                  <span className="text-muted">–</span>
                  <input type="time" name={`closes-${i}`}
                    defaultValue={settings.hours[i]?.closes ?? '23:00'}
                    aria-label={`${day} إلى`}
                    className="h-10 rounded-lg border border-line bg-elevated px-2 text-sm text-fg" />
                </>
              ) : null}
            </div>
          ))}
        </div>
      </fieldset>

      <Save />
    </form>
  );
}
