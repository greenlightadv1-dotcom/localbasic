import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { Card, CardBody } from '@/components/ui/card';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { changePasswordAction, signOutAction } from '../actions';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { mustChangePassword } from '@/lib/auth/password-gate';
import { isLocalDb } from '@/lib/supabase/local/db';

export const metadata: Metadata = { title: 'تغيير كلمة المرور' };
export const dynamic = 'force-dynamic';

const MESSAGES: Record<string, string> = {
  invalid: 'تحقق من كلمة المرور: 8 أحرف على الأقل، والكلمتان متطابقتان.',
  failed: 'تعذر تحديث كلمة المرور. اختر كلمة مختلفة عن المؤقتة وحاول مرة أخرى.',
};

/**
 * The mandatory step after a temporary password: a restaurant owner whose
 * account was created or reset by the platform lands here from every other
 * screen until they choose their own. Anyone without that flag (staff, or an
 * owner who already changed it) is sent on to the app.
 */
export default async function ChangePasswordPage({
  searchParams,
}: {
  searchParams?: { status?: string };
}) {
  if (isLocalDb()) redirect('/dev');

  const supabase = createSupabaseServerClient();
  const { data } = await supabase.auth.getUser();
  if (!data?.user) redirect('/sign-in');
  if (!(await mustChangePassword())) redirect('/workspace');

  const message = searchParams?.status ? MESSAGES[searchParams.status] : undefined;

  return (
    <Card>
      <CardBody className="space-y-5 p-6">
        <div className="space-y-1">
          <h1 className="text-lg font-bold">تغيير كلمة المرور</h1>
          <p className="text-sm text-muted">
            كلمة المرور الحالية مؤقتة. اختر كلمة مرور جديدة خاصة بك للمتابعة.
          </p>
        </div>

        {message && <Alert tone="danger">{message}</Alert>}

        <form action={changePasswordAction} className="space-y-4">
          <Field label="كلمة المرور الجديدة" required hint="8 أحرف على الأقل">
            {(p) => (
              <Input {...p} name="password" type="password" autoComplete="new-password" minLength={8} maxLength={72} required dir="ltr" />
            )}
          </Field>
          <Field label="تأكيد كلمة المرور" required>
            {(p) => (
              <Input {...p} name="confirm" type="password" autoComplete="new-password" minLength={8} maxLength={72} required dir="ltr" />
            )}
          </Field>
          <Button type="submit" block size="lg">
            حفظ والمتابعة
          </Button>
        </form>

        <form action={signOutAction}>
          <button type="submit" className="block w-full text-center text-sm text-muted hover:underline">
            تسجيل الخروج
          </button>
        </form>
      </CardBody>
    </Card>
  );
}
