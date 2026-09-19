import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { Card, CardBody } from '@/components/ui/card';
import { ForgotPasswordForm } from '../password-forms';
import { requestPasswordResetAction } from '../actions';
import { isLocalDb } from '@/lib/supabase/local/db';

export const metadata: Metadata = { title: 'استعادة كلمة المرور' };

export default function ForgotPasswordPage() {
  // Locally there is no Supabase Auth; the dev picker stands in for it.
  if (isLocalDb()) redirect('/dev');

  return (
    <Card>
      <CardBody className="space-y-5 p-6">
        <div className="space-y-1">
          <h1 className="text-lg font-bold">استعادة كلمة المرور</h1>
          <p className="text-sm text-muted">
            اكتب بريدك الإلكتروني وهنبعتلك رابطًا لتعيين كلمة مرور جديدة.
          </p>
        </div>
        <ForgotPasswordForm action={requestPasswordResetAction} />
        <p className="text-center text-sm text-muted">
          تذكرت كلمة المرور؟{' '}
          <Link href="/sign-in" className="font-semibold text-primary hover:underline">
            تسجيل الدخول
          </Link>
        </p>
      </CardBody>
    </Card>
  );
}
