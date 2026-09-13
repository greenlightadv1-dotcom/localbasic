'use client';

import { useRouter } from 'next/navigation';
import { Store } from 'lucide-react';

/**
 * Lists only branches the member can reach — the context was built under RLS,
 * so a branch they are not scoped to is not in this array to begin with.
 */
export function BranchSwitcher({
  branches,
  currentBranchId,
  organizationSlug,
}: {
  branches: { id: string; slug: string; name: string }[];
  currentBranchId: string;
  organizationSlug: string;
}) {
  const router = useRouter();
  if (branches.length <= 1) {
    return (
      <p className="flex items-center gap-2 text-sm font-medium text-muted">
        <Store className="h-4 w-4" aria-hidden="true" />
        {branches[0]?.name}
      </p>
    );
  }

  return (
    <label className="flex items-center gap-2 text-sm">
      <Store className="h-4 w-4 text-muted" aria-hidden="true" />
      <span className="sr-only">اختر الفرع</span>
      <select
        value={currentBranchId}
        onChange={(e) => {
          const next = branches.find((b) => b.id === e.target.value);
          if (next) router.push(`/${organizationSlug}/${next.slug}`);
        }}
        className="h-9 rounded border border-line bg-elevated px-2 text-sm font-medium"
      >
        {branches.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </select>
    </label>
  );
}
