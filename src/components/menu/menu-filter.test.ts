import { describe, expect, it } from 'vitest';
import { matchesQuery, queryTokens } from './menu-filter';

const m = (query: string, ...fields: (string | null | undefined)[]) => matchesQuery(queryTokens(query), ...fields);

describe('menu search matching', () => {
  it('matches everything for an empty query', () => {
    expect(m('', 'بيتزا')).toBe(true);
    expect(m('   ', 'بيتزا')).toBe(true);
  });

  it('is case-insensitive for Latin text', () => {
    expect(m('LATTE', 'Iced latte')).toBe(true);
    expect(m('mocha', 'Iced latte')).toBe(false);
  });

  it('ignores diacritics and alef/yaa/taa-marbuta spelling variants', () => {
    expect(m('بيتزا', 'بِيتزَا مارجريتا')).toBe(true);
    expect(m('اسبريسو', 'أسبريسو')).toBe(true);
    expect(m('شوربه', 'شوربة عدس')).toBe(true);
    expect(m('كريمه', 'كريمة كراميل')).toBe(true);
  });

  it('needs every word, in any order, across name, description and category', () => {
    expect(m('دجاج برجر', 'برجر', 'شرائح دجاج مقرمشة')).toBe(true);
    expect(m('برجر لحم', 'برجر', 'شرائح دجاج مقرمشة')).toBe(false);
    expect(m('ساندوتش دجاج', 'برجر', 'دجاج', 'ساندوتشات')).toBe(true);
  });

  it('ignores missing fields', () => {
    expect(m('بيتزا', 'بيتزا', null, undefined)).toBe(true);
  });
});
