import Link from 'next/link';
import type { Metadata } from 'next';
import { Card, CardBody } from '@/components/ui/card';
import { AuthForm } from '../auth-form';
import { signUpAction } from '../actions';

export const metadata: Metadata = { title: 'إنشاء حساب' };

export default function SignUpPage() {
  return (
    <Card>
      <CardBody className="space-y-5 p-6">
        <div className="space-y-1">
          <h1 className="text-lg font-bold">إنشاء حساب</h1>
          <p className="text-sm text-muted">ابدأ بإنشاء مساحة عمل لنشاطك.</p>
        </div>
        <AuthForm action={signUpAction} submitLabel="إنشاء الحساب" mode="sign-up" />
        <p className="text-center text-sm text-muted">
          لديك حساب بالفعل؟{' '}
          <Link href="/sign-in" className="font-semibold text-primary hover:underline">
            تسجيل الدخول
          </Link>
        </p>
      </CardBody>
    </Card>
  );
}
