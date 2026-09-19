import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { Card, CardBody } from '@/components/ui/card';
import { Alert } from '@/components/ui/alert';
import { ResetPasswordForm } from '../password-forms';
import { updatePasswordAction } from '../actions';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { isLocalDb } from '@/lib/supabase/local/db';

export const metadata: Metadata = { title: 'كلمة مرور جديدة' };

export default async function ResetPasswordPage() {
  if (isLocalDb()) redirect('/dev');

  // Reaching this page means /callback already exchanged the recovery code for
  // a session. No session means the link was invalid, already used, or expired
  // — say that plainly rather than showing a form that cannot work.
  const supabase = createSupabaseServerClient();
  const { data } = await supabase.auth.getUser();

  if (!data?.user) {
    return (
      <Card>
        <CardBody className="space-y-5 p-6">
          <div className="space-y-1">
            <h1 className="text-lg font-bold">رابط غير صالح</h1>
          </div>
          <Alert tone="danger">
            رابط الاستعادة غير صالح أو منتهي الصلاحية. الروابط تُستخدم مرة واحدة فقط.
          </Alert>
          <Link
            href="/forgot-password"
            className="block text-center text-sm font-semibold text-primary hover:underline"
          >
            اطلب رابطًا جديدًا
          </Link>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardBody className="space-y-5 p-6">
        <div className="space-y-1">
          <h1 className="text-lg font-bold">كلمة مرور جديدة</h1>
          <p className="text-sm text-muted" dir="ltr">
            {data.user.email}
          </p>
        </div>
        <ResetPasswordForm action={updatePasswordAction} />
      </CardBody>
    </Card>
  );
}
