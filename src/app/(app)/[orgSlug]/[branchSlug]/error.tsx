'use client';

import { useEffect } from 'react';
import { Card } from '@/components/ui/card';
import { ErrorState } from '@/components/patterns/states';

/**
 * Keeps the dashboard shell (sidebar, header) on screen when a page fails, so
 * one broken screen doesn't look like the whole app is down. Never shows the
 * underlying message — only the correlation digest.
 */
export default function BranchError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[localbasic] page error', error.digest ?? error.message);
  }, [error]);

  return (
    <Card>
      <ErrorState
        title="تعذّر تحميل هذه الصفحة"
        description={`تم تسجيل المشكلة. حاول مرة أخرى${error.digest ? ` (رمز المشكلة: ${error.digest})` : ''}.`}
        retry={reset}
      />
    </Card>
  );
}
