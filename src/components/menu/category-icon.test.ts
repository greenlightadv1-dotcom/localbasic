import { describe, expect, it } from 'vitest';
import {
  Beef, CakeSlice, Coffee, Croissant, CupSoda, Drumstick, EggFried, Fish, Flame, IceCream,
  Pizza, Salad, Sandwich, Soup, UtensilsCrossed,
} from 'lucide-react';
import { iconForCategory } from './category-icon';

describe('iconForCategory', () => {
  it.each([
    ['بيتزا', Pizza], ['Pizza', Pizza],
    ['برجر', Sandwich], ['شاورما', Sandwich], ['Burgers', Sandwich],
    ['مشويات', Flame], ['المشاوي', Flame], ['BBQ', Flame],
    ['دجاج', Drumstick], ['Fried Chicken', Drumstick],
    ['ستيك', Beef], ['Steak', Beef],
    ['أسماك', Fish], ['سي فود', UtensilsCrossed],
    ['سلطات', Salad], ['شوربة', Soup],
    ['فطار', EggFried], ['إفطار', EggFried],
    ['معجنات', Croissant],
    ['حلويات', CakeSlice], ['كنافة', CakeSlice], ['Desserts', CakeSlice],
    ['آيس كريم', IceCream], ['ايس كريم', IceCream],
    ['قهوة', Coffee], ['Hot Coffee', Coffee], ['شاي', Coffee],
    ['عصائر', CupSoda], ['مشروبات باردة', CupSoda], ['Juice', CupSoda],
  ])('%s → the matching icon', (name, icon) => {
    expect(iconForCategory(name)).toBe(icon);
  });

  it('is not fooled by letters inside other words', () => {
    expect(iconForCategory('Steak House')).toBe(Beef); // "tea" inside "steak"
    expect(iconForCategory('Fresh Juice')).toBe(CupSoda); // "ice" inside "juice"
  });

  it('ignores Arabic spelling variants and diacritics', () => {
    expect(iconForCategory('حَلويّات')).toBe(CakeSlice);
    expect(iconForCategory('الفطائر')).toBe(Pizza);
  });

  it('falls back to the generic plate for anything unrecognised or missing', () => {
    expect(iconForCategory('أصناف أخرى')).toBe(UtensilsCrossed);
    expect(iconForCategory('')).toBe(UtensilsCrossed);
    expect(iconForCategory(null)).toBe(UtensilsCrossed);
    expect(iconForCategory(undefined)).toBe(UtensilsCrossed);
  });
});
