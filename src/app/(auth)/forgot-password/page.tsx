import { redirect } from 'next/navigation';

/**
 * Email password recovery no longer exists. Restaurant owners ask platform
 * support on WhatsApp (the "نسيت كلمة المرور؟" link on the sign-in page) and
 * staff ask their own admin. Old bookmarks and mailed links land here, so this
 * sends them somewhere useful instead of 404ing.
 */
export default function ForgotPasswordPage() {
  redirect('/sign-in');
}
