import { redirect } from 'next/navigation';

/**
 * Self-service sign-up is closed: new customers are onboarded by the platform
 * (the "أنشئ حسابًا" link on the sign-in page opens WhatsApp to sales). Old
 * bookmarks and links land here, so this sends them to sign-in rather than 404.
 */
export default function SignUpPage() {
  redirect('/sign-in');
}
