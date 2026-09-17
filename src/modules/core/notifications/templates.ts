/**
 * What a notification actually says.
 *
 * Plain data, no imports, so a client component could render a preview without
 * dragging the server client along. Arabic, because every recipient of these
 * is an Egyptian shop's customer or staff.
 *
 * An unknown template renders a safe generic line rather than throwing: a
 * queue row written by a migration the application has not caught up with
 * should still be deliverable, not stuck.
 */
export type RenderedMessage = { subject: string; text: string };

type Renderer = (payload: Record<string, unknown>) => RenderedMessage;

function str(payload: Record<string, unknown>, key: string, fallback = ''): string {
  const value = payload[key];
  return typeof value === 'string' || typeof value === 'number' ? String(value) : fallback;
}

const TEMPLATES: Record<string, Renderer> = {
  'restaurant.online_order.created': (p) => ({
    subject: 'تم استلام طلبك',
    text: `استلمنا طلبك رقم ${str(p, 'order_number', '—')}. سنبدأ التجهيز فورًا.`,
  }),
  'restaurant.online_order.confirmed': (p) => ({
    subject: 'تم تأكيد طلبك',
    text: `تم تأكيد طلبك رقم ${str(p, 'order_number', '—')} وجارٍ تجهيزه.`,
  }),
  'restaurant.online_order.ready': (p) => ({
    subject: 'طلبك جاهز',
    text: `طلبك رقم ${str(p, 'order_number', '—')} جاهز الآن.`,
  }),
  'restaurant.online_order.cancelled': (p) => ({
    subject: 'تم إلغاء طلبك',
    text: `تم إلغاء طلبك رقم ${str(p, 'order_number', '—')}. ${str(p, 'reason')}`.trim(),
  }),
  'member.invited': (p) => ({
    subject: `دعوة للانضمام إلى ${str(p, 'organization', 'فريق العمل')}`,
    text:
      `تمت دعوتك للانضمام إلى ${str(p, 'organization', 'فريق العمل')} على Local Basic. ` +
      `افتح الرابط التالي لقبول الدعوة: ${str(p, 'accept_url')}`,
  }),
};

export function renderNotification(
  template: string,
  payload: Record<string, unknown>,
): RenderedMessage {
  const renderer = TEMPLATES[template];
  if (renderer) return renderer(payload);

  return {
    subject: 'إشعار من Local Basic',
    // The template name is included so an operator reading a delivered message
    // can trace it back, rather than seeing an anonymous blank.
    text: `لديك إشعار جديد (${template}).`,
  };
}

export function knownTemplates(): string[] {
  return Object.keys(TEMPLATES);
}
