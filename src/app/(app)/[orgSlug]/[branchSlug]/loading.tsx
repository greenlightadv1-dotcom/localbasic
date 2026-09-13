import { Skeleton } from '@/components/patterns/states';

export default function BranchLoading() {
  return (
    <div className="space-y-5">
      <Skeleton className="h-9 w-64" />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-[88px]" />
        ))}
      </div>
    </div>
  );
}
