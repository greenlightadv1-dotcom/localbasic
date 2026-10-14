'use client';

import { useState } from 'react';
import { Search, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { iconForCategory } from './category-icon';
import { ALL_CATEGORIES } from './menu-filter';

export const MENU_SEARCH_ID = 'menu-search';

/** Scrolls to the top and focuses the search box (the bottom-nav "بحث" tab). */
export function focusMenuSearch() {
  window.scrollTo({ top: 0, behavior: 'smooth' });
  window.setTimeout(() => document.getElementById(MENU_SEARCH_ID)?.focus({ preventScroll: true }), 250);
}

type Cat = { id: string; name: string };

const COLLAPSED_COUNT = 7;

/** Arabic count words: نتيجة واحدة، نتيجتان، ٣ نتائج، ١١ نتيجة. */
function resultWords(n: number): React.ReactNode {
  if (n === 1) return 'نتيجة واحدة';
  if (n === 2) return 'نتيجتان';
  return <><bdi className="lb-numeric">{n}</bdi> {n >= 3 && n <= 10 ? 'نتائج' : 'نتيجة'}</>;
}

/**
 * The top of the menu: a prominent live search and a wrapped grid of category
 * pills. Nothing scrolls sideways — every category is visible (or one tap away
 * under "المزيد") and choosing one filters the menu instantly.
 */
export function MenuFilterBar({
  categories,
  selected,
  onSelect,
  query,
  onQuery,
  resultCount,
  filtering,
  onClear,
}: {
  categories: Cat[];
  selected: string;
  onSelect: (id: string) => void;
  query: string;
  onQuery: (q: string) => void;
  resultCount: number;
  filtering: boolean;
  onClear: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const many = categories.length > COLLAPSED_COUNT;
  // Collapsed, keep the selected pill visible even if it sits past the cut.
  const shown = expanded || !many
    ? categories
    : categories.filter((c, i) => i < COLLAPSED_COUNT || c.id === selected);
  const hidden = categories.length - shown.length;
  const searching = query.trim().length > 0;

  const pill = (on: boolean) =>
    cn(
      'inline-flex h-10 items-center gap-1.5 rounded-full border px-3.5 text-sm font-bold transition-all duration-150 active:scale-95',
      on
        ? 'border-primary bg-primary text-primary-fg shadow-[0_4px_12px_rgb(var(--lb-primary)/0.3)]'
        : 'border-line bg-elevated text-fg hover:border-primary/50',
    );

  return (
    <section aria-label="البحث والتصنيفات" className="space-y-3 px-4 pb-1 pt-1">
      <div className="relative">
        <Search
          className="pointer-events-none absolute inset-y-0 start-4 my-auto h-5 w-5 text-primary"
          aria-hidden="true"
        />
        <label htmlFor={MENU_SEARCH_ID} className="sr-only">ابحث في المنيو</label>
        <input
          id={MENU_SEARCH_ID}
          type="search"
          enterKeyHint="search"
          autoComplete="off"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="ابحث عن وجبة أو مشروب…"
          data-testid="menu-search"
          className="h-14 w-full rounded-2xl border border-line bg-elevated ps-12 pe-12 text-base font-semibold text-fg shadow-[0_6px_18px_rgb(var(--lb-primary)/0.07)] transition-shadow placeholder:font-normal placeholder:text-muted focus:border-primary focus:shadow-[0_6px_22px_rgb(var(--lb-primary)/0.18)] focus:outline-none [&::-webkit-search-cancel-button]:hidden"
        />
        {searching ? (
          <button
            type="button"
            onClick={() => onQuery('')}
            aria-label="مسح البحث"
            className="absolute inset-y-0 end-3 my-auto flex h-8 w-8 items-center justify-center rounded-full bg-line text-muted transition-transform active:scale-90"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        ) : null}
      </div>

      {categories.length > 1 ? (
        <ul className="flex flex-wrap gap-2" aria-label="التصنيفات">
          <li>
            <button
              type="button" aria-pressed={selected === ALL_CATEGORIES}
              onClick={() => onSelect(ALL_CATEGORIES)}
              className={pill(selected === ALL_CATEGORIES)}
            >
              الكل
            </button>
          </li>
          {shown.map((c) => {
            const Icon = iconForCategory(c.name);
            return (
              <li key={c.id}>
                <button
                  type="button" aria-pressed={selected === c.id}
                  onClick={() => onSelect(c.id)}
                  data-testid="category-pill"
                  className={pill(selected === c.id)}
                >
                  <Icon className="h-4 w-4" aria-hidden="true" />
                  {c.name}
                </button>
              </li>
            );
          })}
          {many ? (
            <li>
              <button
                type="button" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}
                className="inline-flex h-10 items-center rounded-full px-3 text-sm font-bold text-primary active:scale-95"
              >
                {expanded ? 'أقل' : `المزيد (${hidden})`}
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}

      <p className="min-h-5 text-xs font-semibold text-muted" role="status" aria-live="polite" data-testid="menu-result-count">
        {filtering
          ? resultCount > 0
            ? resultWords(resultCount)
            : null
          : null}
      </p>
      {filtering && resultCount === 0 ? (
        <div className="rounded-2xl border border-dashed border-line px-4 py-8 text-center" data-testid="menu-empty">
          <p className="text-2xl" aria-hidden="true">🔍</p>
          <p className="mt-1 text-sm font-bold text-fg">لا توجد نتائج مطابقة</p>
          <p className="text-xs text-muted">جرّب كلمة أخرى أو اختر تصنيفًا مختلفًا.</p>
          <button
            type="button" onClick={onClear}
            className="mt-3 rounded-full bg-primary px-5 py-2 text-xs font-extrabold text-primary-fg active:scale-95"
          >
            عرض كل المنيو
          </button>
        </div>
      ) : null}
    </section>
  );
}
