import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { Card, CardBody } from '@/components/ui/card';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { updatePasswordAction } from '../actions';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { isLocalDb } from '@/lib/supabase/local/db';

export const metadata: Metadata = { title: 'كلمة مرور جديدة' };
export const dynamic = 'force-dynamic';

const MESSAGES: Record<string, string> = {
  invalid: 'تحقق من كلمة المرور: 8 أحرف على الأقل، والكلمتان متطابقتان.',
  expired: 'رابط الاستعادة غير صالح أو منتهي الصلاحية. اطلب رابطًا جديدًا.',
  failed: 'تعذر تحديث كلمة المرور. حاول مرة أخرى.',
};

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams?: { status?: string };
}) {
  if (isLocalDb()) redirect('/dev');

  // Reaching this page means /callback/recovery already exchanged the code for
  // a session. No session means the link was invalid, already used or expired.
  const supabase = createSupabaseServerClient();
  const { data } = await supabase.auth.getUser();

  if (!data?.user) {
    return (
      <Card>
        <CardBody className="space-y-5 p-6">
          <h1 className="text-lg font-bold">رابط غير صالح</h1>
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

  const message = searchParams?.status ? MESSAGES[searchParams.status] : undefined;

  return (
    <Card>
      <CardBody className="space-y-5 p-6">
        <div className="space-y-1">
          <h1 className="text-lg font-bold">كلمة مرور جديدة</h1>
          <p className="text-sm text-muted" dir="ltr">
            {data.user.email}
          </p>
        </div>

        {message && <Alert tone="danger">{message}</Alert>}

        <form action={updatePasswordAction} className="space-y-4">
          <Field label="كلمة المرور الجديدة" required hint="8 أحرف على الأقل">
            {(p) => (
              <Input
                {...p}
                name="password"
                type="password"
                autoComplete="new-password"
                minLength={8}
                required
                dir="ltr"
              />
            )}
          </Field>
          <Field label="تأكيد كلمة المرور" required>
            {(p) => (
              <Input
                {...p}
                name="confirm"
                type="password"
                autoComplete="new-password"
                minLength={8}
                required
                dir="ltr"
              />
            )}
          </Field>
          <Button type="submit" block size="lg">
            حفظ كلمة المرور
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}
