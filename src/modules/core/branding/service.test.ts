import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tier-based branding at the service boundary: a store's own colors are used
 * only on a plan that includes them (Growth / Scale), the saved choice is kept
 * untouched otherwise, and a color change from a plan without them is ignored
 * even if the form sends one.
 */
const h = vi.hoisted(() => ({
  features: {} as Record<string, unknown>,
  stored: { primary: '#024323', secondary: '#D7DE3E' },
  updates: [] as Record<string, unknown>[],
}));

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () => ({
    from: (table: string) => {
      if (table === 'branding_settings') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  display_name: 'مطعم الحارة', logo_url: null,
                  primary_color: h.stored.primary, secondary_color: h.stored.secondary,
                  phone: null, whatsapp: null, email: null, white_label: false,
                },
              }),
            }),
          }),
          update: (values: Record<string, unknown>) => ({
            eq: async () => { h.updates.push(values); return { error: null }; },
          }),
        };
      }
      return {
        select: () => ({
          eq: () => ({
            in: () => ({ maybeSingle: async () => ({ data: { status: 'active', plans: { features: h.features } } }) }),
          }),
        }),
      };
    },
  }),
}));
vi.mock('@/modules/core/tenancy/context', () => ({ requirePermission: () => {} }));

import { getBranding, updateBranding } from './service';

const CTX = { organizationId: 'org-1', organizationName: 'مطعم' } as never;
const INPUT = {
  displayName: 'مطعم الحارة', logoUrl: null, primaryColor: '#FF0000', secondaryColor: '#00FF00',
  phone: null, whatsapp: null, email: null,
};

beforeEach(() => { h.features = {}; h.updates = []; });

describe('getBranding', () => {
  it('serves the LocalBasic palette on a plan without custom colors, keeping the saved ones aside', async () => {
    h.features = { custom_colors: false };
    const b = await getBranding(CTX);
    expect(b.customColors).toBe(false);
    expect(b.primaryColor).toBe('#1E2FC8');
    expect(b.secondaryColor).toBe('#6B8BFA');
    expect(b.storedPrimaryColor).toBe('#024323');
  });

  it('serves the store\'s own colors on Growth / Scale', async () => {
    h.features = { custom_colors: true };
    const b = await getBranding(CTX);
    expect(b.customColors).toBe(true);
    expect(b.primaryColor).toBe('#024323');
    expect(b.secondaryColor).toBe('#D7DE3E');
  });

  it('treats a plan with no flag at all as no custom colors', async () => {
    h.features = { white_label: true };
    expect((await getBranding(CTX)).customColors).toBe(false);
  });
});

describe('updateBranding', () => {
  it('ignores a color change from a plan without custom colors but saves the rest', async () => {
    h.features = { custom_colors: false };
    await updateBranding(CTX, INPUT);
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]).not.toHaveProperty('primary_color');
    expect(h.updates[0]).not.toHaveProperty('secondary_color');
    expect(h.updates[0]).toMatchObject({ display_name: 'مطعم الحارة' });
  });

  it('saves the colors on a plan that includes them', async () => {
    h.features = { custom_colors: true };
    await updateBranding(CTX, INPUT);
    expect(h.updates[0]).toMatchObject({ primary_color: '#FF0000', secondary_color: '#00FF00' });
  });
});
