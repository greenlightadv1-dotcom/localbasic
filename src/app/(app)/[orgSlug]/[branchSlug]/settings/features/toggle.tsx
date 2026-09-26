'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/components/ui/toast';
import { setRestaurantFeatureAction } from './actions';

type Scope = { organizationSlug: string; branchSlug: string };

/**
 * One operational feature, one switch. Flipping it off drops the matching
 * nav link and 404s the page directly (see app-shell.tsx and each page's own
 * guard) — this is a scale-down control, not a permission, so it stays a
 * single boolean rather than growing its own role system.
 */
export function FeatureToggle({
  scope,
  featureKey,
  title,
  description,
  initialEnabled,
}: {
  scope: Scope;
  featureKey: 'kitchen_display_enabled' | 'captain_hall_enabled';
  title: string;
  description: string;
  initialEnabled: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [enabled, setEnabled] = useState(initialEnabled);
  const [isPending, startTransition] = useTransition();

  function toggle() {
    const next = !enabled;
    setEnabled(next);
    startTransition(async () => {
      const result = await setRestaurantFeatureAction(scope, { key: featureKey, enabled: next });
      if (!result.ok) {
        setEnabled(!next);
        toast.error(result.error);
        return;
      }
      toast.success(next ? 'تم التفعيل' : 'تم الإيقاف');
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardBody className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted">{description}</p>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          disabled={isPending}
          onClick={toggle}
          className={`relative h-7 w-12 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
            enabled ? 'bg-primary' : 'bg-surface'
          }`}
        >
          <span
            className={`absolute top-1 h-5 w-5 rounded-full bg-white shadow transition-transform ${
              enabled ? 'translate-x-1' : 'translate-x-6'
            }`}
          />
        </button>
      </CardBody>
    </Card>
  );
}
