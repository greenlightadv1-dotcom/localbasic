import { redirect } from 'next/navigation';

/** Recovery links are gone; the only password screen is the mandatory change. */
export default function ResetPasswordPage() {
  redirect('/change-password');
}
