'use client';

import { useEffect } from 'react';
import { Button } from '@/components/ui/button';

/**
 * Top-level error boundary. Shows a safe message and a correlation digest —
 * never the message or stack of the underlying error, which may carry ids,
 * SQL, or internal hostnames.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[localbasic] unhandled', error.digest ?? error.message);
  }, [error]);

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-4 text-center">
      <h1 className="text-lg font-bold">حدث خطأ غير متوقع</h1>
      <p className="max-w-md text-sm text-muted">
        تم تسجيل المشكلة. حاول مرة أخرى، وإذا تكرر الأمر تواصل مع الدعم.
      </p>
      {error.digest && (
        <p className="lb-numeric text-xs text-muted/70">رمز المشكلة: {error.digest}</p>
      )}
      <Button onClick={reset}>إعادة المحاولة</Button>
    </div>
  );
}
