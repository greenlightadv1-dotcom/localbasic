'use client';

import { ACCOUNT_WHATSAPP_MESSAGES, whatsappLink } from '@/config/site';

/**
 * "Forgot password?" for restaurant owners/admins. There is no email reset:
 * the link opens WhatsApp to platform support with the message pre-filled, and
 * support assigns a temporary password. Staff accounts are reset by their own
 * admin and never come here.
 *
 * The username typed into the sign-in form (if any) is read when the link is
 * clicked and put in the message, so support does not have to ask for it.
 */
export function ForgotPasswordLink({ className }: { className?: string }) {
  return (
    <a
      href={whatsappLink(ACCOUNT_WHATSAPP_MESSAGES.forgotPassword())}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
      onClick={(event) => {
        const typed = document
          .querySelector<HTMLInputElement>('form input[name="identifier"]')
          ?.value;
        event.currentTarget.href = whatsappLink(ACCOUNT_WHATSAPP_MESSAGES.forgotPassword(typed));
      }}
    >
      نسيت كلمة المرور؟
    </a>
  );
}

export function CreateAccountLink({ className }: { className?: string }) {
  return (
    <a
      href={whatsappLink(ACCOUNT_WHATSAPP_MESSAGES.createAccount)}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
    >
      أنشئ حسابًا
    </a>
  );
}
