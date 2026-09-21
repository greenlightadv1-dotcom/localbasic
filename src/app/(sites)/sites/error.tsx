'use client';

import { useEffect } from 'react';
import { ErrorState } from '@/components/patterns/states';

/**
 * Route-level boundary for the Site Engine.
 *
 * Shows the shared error state and a retry. The underlying message is never
 * rendered — it may carry ids or internal detail — only the digest reaches the
 * log, matching the root boundary's behaviour.
 */
export default function SitesError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[localbasic] sites', error.digest ?? error.message);
  }, [error]);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8">
      <ErrorState
        title="تعذّر تحميل المواقع"
        description="حدث خطأ أثناء جلب بياناتك. حاول مرة أخرى."
        retry={reset}
      />
    </div>
  );
}
