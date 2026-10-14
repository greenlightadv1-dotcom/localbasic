'use client';

import { useMemo } from 'react';
import { CategorySection, FoodCard, FoodGrid } from '@/components/menu/food-ui';
import { MenuFilterBar } from '@/components/menu/menu-filter-bar';
import { useMenuFilter } from '@/components/menu/menu-filter';
import { formatPrice } from '@/lib/price';
import type { MenuCategory, MenuProduct } from '@/modules/restaurant/website/service';

/** The menu without ordering: a branch that is not taking orders online. */
export function ReadOnlyMenu({ categories, currency }: { categories: MenuCategory[]; currency: string }) {
  const sections = useMemo(
    () =>
      categories.map((c) => ({
        id: c.id ?? '__uncategorised__',
        name: c.name,
        imageUrl: c.products.find((p) => p.imageUrl)?.imageUrl ?? null,
        items: c.products,
      })),
    [categories],
  );
  const filter = useMenuFilter(sections, (p: MenuProduct) => `${p.name} ${p.description ?? ''}`);

  if (categories.length === 0) {
    return <p className="px-4 py-16 text-center text-sm text-muted">المنيو غير متاح حاليًا.</p>;
  }
  return (
    <div className="pb-8">
      <p className="mx-4 mb-3 rounded-[14px] bg-primary-soft px-4 py-2.5 text-sm font-semibold text-primary">
        الطلب أونلاين غير متاح الآن في هذا الفرع. تفضّل بزيارتنا.
      </p>
      <MenuFilterBar
        categories={sections.map((c) => ({ id: c.id, name: c.name }))}
        selected={filter.selected} onSelect={filter.setSelected}
        query={filter.query} onQuery={filter.setQuery}
        resultCount={filter.count} filtering={filter.filtering} onClear={filter.clear}
      />
      {filter.visible.map((c) => (
        <CategorySection key={`${filter.selected}:${c.id}`} id={c.id} name={c.name}>
          <FoodGrid>
            {c.items.map((p) => (
              <FoodCard
                key={p.productId}
                name={p.name}
                description={p.description}
                priceLabel={`${p.variants.length > 1 ? 'من ' : ''}${formatPrice(p.fromPriceCents, currency)}`}
                imageUrl={p.imageUrl}
                categoryName={c.name}
                canOrder={false}
              />
            ))}
          </FoodGrid>
        </CategorySection>
      ))}
    </div>
  );
}
