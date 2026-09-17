'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { acceptInvitationAction } from './actions';

export function AcceptInvitation({ token }: { token: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="space-y-3">
      {error ? <Alert tone="danger"><span data-testid="accept-error">{error}</span></Alert> : null}

      <Button
        type="button"
        className="w-full"
        disabled={isPending}
        data-testid="accept-invite"
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const result = await acceptInvitationAction(token);
            if (!result.ok) { setError(result.error); return; }
            router.push(`/${result.organizationSlug}`);
            router.refresh();
          })
        }
      >
        {isPending ? '…' : 'قبول الدعوة والانضمام'}
      </Button>
    </div>
  );
}
