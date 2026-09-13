'use client';

import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { useTransition, useState, useEffect } from 'react';
import { Search } from 'lucide-react';
import { Input } from '@/components/ui/field';

export function ProductSearch({ defaultValue }: { defaultValue: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [value, setValue] = useState(defaultValue);
  const [isPending, startTransition] = useTransition();

  // Debounced so typing does not fire a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (value === defaultValue) return;
      const params = new URLSearchParams(searchParams);
      if (value) params.set('q', value);
      else params.delete('q');
      startTransition(() => router.replace(`${pathname}?${params}`));
    }, 300);
    return () => clearTimeout(timer);
  }, [value, defaultValue, pathname, router, searchParams]);

  return (
    <div className="relative max-w-sm">
      <Search
        className="pointer-events-none absolute inset-y-0 start-3 my-auto h-4 w-4 text-muted"
        aria-hidden="true"
      />
      <label htmlFor="product-search" className="sr-only">
        ابحث في المنتجات
      </label>
      <Input
        id="product-search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="ابحث بالاسم…"
        className="ps-9"
        aria-busy={isPending}
      />
    </div>
  );
}
