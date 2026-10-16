import { describe, expect, it } from 'vitest';
import { classifyTag, splitNote } from './tags';

describe('kitchen tags', () => {
  it('flags removals loudly', () => {
    for (const t of ['بدون بصل', 'NO ONIONS', 'without cheese', 'من غير ملح', 'لا ثلج']) expect(classifyTag(t)).toBe('without');
  });
  it('flags additions', () => {
    for (const t of ['زيادة صوص', 'EXTRA SAUCE', 'دبل جبنة', 'إضافة بيض']) expect(classifyTag(t)).toBe('extra');
  });
  it('flags allergies above everything', () => {
    expect(classifyTag('حساسية مكسرات')).toBe('allergy');
    expect(classifyTag('no nuts — allergy')).toBe('allergy');
  });
  it('leaves plain options alone, including words that merely contain "no"', () => {
    for (const t of ['جبنة شيدر', 'Medium well', 'nori', 'piano']) expect(classifyTag(t)).toBe('option');
  });
  it('splits a note into its instructions', () => {
    expect(splitNote('بدون بصل، زيادة صوص')).toEqual(['بدون بصل', 'زيادة صوص']);
    expect(splitNote('no onions, extra sauce')).toEqual(['no onions', 'extra sauce']);
    expect(splitNote('بدون بصل وزيادة صوص')).toEqual(['بدون بصل', 'زيادة صوص']);
  });
});
