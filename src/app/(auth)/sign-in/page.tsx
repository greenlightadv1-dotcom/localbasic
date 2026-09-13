import Link from 'next/link';
import type { Metadata } from 'next';
import { Card, CardBody } from '@/components/ui/card';
import { AuthForm } from '../auth-form';
import { signInAction } from '../actions';

export const metadata: Metadata = { title: 'تسجيل الدخول' };

export default function SignInPage() {
  return (
    <Card>
      <CardBody className="space-y-5 p-6">
        <div className="space-y-1">
          <h1 className="text-lg font-bold">تسجيل الدخول</h1>
          <p className="text-sm text-muted">ادخل إلى مساحة عملك.</p>
        </div>
        <AuthForm action={signInAction} submitLabel="دخول" mode="sign-in" />
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
