import { useMemo, useState } from 'react';
import { normalizeArabic } from './category-icon';

/**
 * Live menu filtering: a text query and a selected category, applied
 * instantly on the client to data the page already holds.
 *
 * Matching is forgiving the way people actually type Arabic: diacritics,
 * alef/yaa/taa-marbuta variants and case are ignored, and every word of the
 * query must appear somewhere in the dish's name, description or category.
 */
export function queryTokens(query: string): string[] {
  return normalizeArabic(query).split(/\s+/).filter(Boolean);
}

export function matchesQuery(tokens: string[], ...fields: (string | null | undefined)[]): boolean {
  if (tokens.length === 0) return true;
  const haystack = normalizeArabic(fields.filter(Boolean).join(' '));
  return tokens.every((t) => haystack.includes(t));
}

export type FilterSection<T> = {
  id: string;
  name: string;
  imageUrl: string | null;
  description?: string | null;
  items: T[];
};

export const ALL_CATEGORIES = 'all';

export function useMenuFilter<T>(
  sections: FilterSection<T>[],
  /** The searchable text of one item (its category name is added for you). */
  textOf: (item: T) => string,
) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string>(ALL_CATEGORIES);

  // A selection that no longer exists (the menu changed) falls back to "all".
  const active = sections.some((s) => s.id === selected) ? selected : ALL_CATEGORIES;

  const visible = useMemo(() => {
    const tokens = queryTokens(query);
    return sections
      .filter((s) => active === ALL_CATEGORIES || s.id === active)
      .map((s) => ({
        ...s,
        items: tokens.length ? s.items.filter((i) => matchesQuery(tokens, textOf(i), s.name)) : s.items,
      }))
      .filter((s) => s.items.length > 0);
    // textOf is a stable accessor per page; sections and the inputs drive it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sections, query, active]);

  const count = visible.reduce((n, s) => n + s.items.length, 0);

  return {
    query, setQuery, selected: active, setSelected, visible, count,
    filtering: query.trim().length > 0 || active !== ALL_CATEGORIES,
    clear: () => { setQuery(''); setSelected(ALL_CATEGORIES); },
  };
}
