import { describe, expect, it } from 'vitest';
import {
  MAX_OFFER_LENGTH, OFFER_TEMPLATES, buildOfferMessage, toWhatsAppNumber, whatsappOfferUrl,
} from './offer';

describe('toWhatsAppNumber', () => {
  it('adds the country code to a local number and drops the leading zero', () => {
    expect(toWhatsAppNumber('01012345678', 'EGP')).toBe('201012345678');
    expect(toWhatsAppNumber('0501234567', 'SAR')).toBe('966501234567');
  });

  it('keeps numbers that are already international, however they are written', () => {
    expect(toWhatsAppNumber('+20 101 234 5678')).toBe('201012345678');
    expect(toWhatsAppNumber('0020 101 234 5678')).toBe('201012345678');
    expect(toWhatsAppNumber('201012345678')).toBe('201012345678');
    expect(toWhatsAppNumber('+971 50 123 4567')).toBe('971501234567');
  });

  it('handles a national number typed without its leading zero', () => {
    expect(toWhatsAppNumber('1012345678', 'EGP')).toBe('201012345678');
  });

  it('refuses things that cannot be a phone number', () => {
    expect(toWhatsAppNumber('')).toBeNull();
    expect(toWhatsAppNumber('abc')).toBeNull();
    expect(toWhatsAppNumber('123')).toBeNull();
    expect(toWhatsAppNumber('1'.repeat(20))).toBeNull();
  });

  it('falls back to Egypt for a currency it does not know', () => {
    expect(toWhatsAppNumber('01012345678', 'XXX')).toBe('201012345678');
  });
});

describe('buildOfferMessage', () => {
  const vars = { name: 'منى أحمد', store: 'لافيشي', points: 72, link: 'https://x.test/r/lavechi' };

  it('fills every variable and uses the first name', () => {
    const msg = buildOfferMessage('أهلاً {الاسم} من {المتجر} — {النقاط} نقطة\n{الرابط}', vars);
    expect(msg).toBe('أهلاً منى من لافيشي — 72 نقطة\nhttps://x.test/r/lavechi');
  });

  it('leaves no blank hole when the link is left out', () => {
    const msg = buildOfferMessage('أهلاً {الاسم}\n{الرابط}\nنراك قريبًا', { ...vars, link: null });
    expect(msg).not.toContain('{');
    expect(msg).not.toMatch(/\n{3,}/);
    expect(msg.startsWith('أهلاً منى')).toBe(true);
  });

  it('copes with a customer who has no name', () => {
    expect(buildOfferMessage('أهلاً {الاسم}', { ...vars, name: '' })).toBe('أهلاً عزيزنا');
  });

  it('every built-in template resolves cleanly', () => {
    for (const t of OFFER_TEMPLATES) {
      expect(buildOfferMessage(t.body, vars)).not.toMatch(/[{}]/);
    }
  });
});

describe('whatsappOfferUrl', () => {
  it('builds an encoded wa.me deep link', () => {
    const url = whatsappOfferUrl('01012345678', 'عرض 50% & أكثر', 'EGP')!;
    expect(url.startsWith('https://wa.me/201012345678?text=')).toBe(true);
    expect(decodeURIComponent(url.split('?text=')[1]!)).toBe('عرض 50% & أكثر');
    expect(url).not.toContain(' ');
  });

  it('refuses a bad number, an empty message and an over-long one', () => {
    expect(whatsappOfferUrl('abc', 'hi')).toBeNull();
    expect(whatsappOfferUrl('01012345678', '   ')).toBeNull();
    expect(whatsappOfferUrl('01012345678', 'x'.repeat(MAX_OFFER_LENGTH + 1))).toBeNull();
  });
});
