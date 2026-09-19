import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { Card, CardBody } from '@/components/ui/card';
import { Alert } from '@/components/ui/alert';
import { AuthForm } from '../auth-form';
import { signInAction } from '../actions';
import { isLocalDb } from '@/lib/supabase/local/db';

export const metadata: Metadata = { title: 'تسجيل الدخول' };

export default function SignInPage({
  searchParams,
}: {
  searchParams?: { error?: string };
}) {
  // Locally there is no Supabase Auth; the dev picker stands in for it.
  if (isLocalDb()) redirect('/dev');

  return (
    <Card>
      <CardBody className="space-y-5 p-6">
        <div className="space-y-1">
          <h1 className="text-lg font-bold">تسجيل الدخول</h1>
          <p className="text-sm text-muted">ادخل إلى مساحة عملك.</p>
        </div>

        {searchParams?.error === 'link_invalid' && (
          <Alert tone="danger">
            الرابط غير صالح أو منتهي الصلاحية. الروابط تُستخدم مرة واحدة فقط —{' '}
            <Link href="/forgot-password" className="font-semibold underline">
              اطلب رابطًا جديدًا
            </Link>
            .
          </Alert>
        )}

        <AuthForm action={signInAction} submitLabel="دخول" mode="sign-in" />

        <p className="text-center text-sm">
          <Link href="/forgot-password" className="font-semibold text-primary hover:underline">
            نسيت كلمة المرور؟
          </Link>
        </p>

        <p className="text-center text-sm text-muted">
          ليس لديك حساب؟{' '}
          <Link href="/sign-up" className="font-semibold text-primary hover:underline">
            أنشئ حسابًا
          </Link>
        </p>
      </CardBody>
    </Card>
  );
}
