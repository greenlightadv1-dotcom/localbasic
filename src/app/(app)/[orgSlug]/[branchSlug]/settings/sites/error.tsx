'use client';

import { useEffect } from 'react';
import { ErrorState } from '@/components/patterns/states';

/**
 * Route-level boundary for the Site Engine.
 *
 * The underlying message is never rendered — it may carry ids or internal
 * detail — only the digest reaches the log, matching the root boundary.
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
    <ErrorState
      title="تعذّر تحميل المواقع"
      description="حدث خطأ أثناء جلب البيانات. حاول مرة أخرى."
      retry={reset}
    />
  );
}
