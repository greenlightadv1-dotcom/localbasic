import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { Card, CardBody } from '@/components/ui/card';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { requestPasswordResetAction } from '../actions';
import { isLocalDb } from '@/lib/supabase/local/db';

export const metadata: Metadata = { title: 'استعادة كلمة المرور' };

/**
 * Reading searchParams makes this dynamic, which is deliberate. As a
 * prerendered page its markup was built once and served from the CDN, so a
 * per-request CSP nonce could never match its script tags and every one of
 * them was blocked — leaving a form that looked fine and did nothing.
 */
export const dynamic = 'force-dynamic';

const MESSAGES: Record<string, { tone: 'success' | 'danger'; text: string }> = {
  sent: {
    tone: 'success',
    text: 'تم إرسال رابط استعادة كلمة المرور إلى بريدك الإلكتروني.',
  },
  invalid: { tone: 'danger', text: 'بريد إلكتروني غير صحيح.' },
  rate_limited: { tone: 'danger', text: 'محاولات كثيرة. برجاء المحاولة بعد قليل.' },
  unconfigured: { tone: 'danger', text: 'إعداد الموقع غير مكتمل. تواصل مع الدعم.' },
  failed: { tone: 'danger', text: 'تعذر إرسال رابط الاستعادة. حاول مرة أخرى.' },
};

export default function ForgotPasswordPage({
  searchParams,
}: {
  searchParams?: { status?: string };
}) {
  // Locally there is no Supabase Auth; the dev picker stands in for it.
  if (isLocalDb()) redirect('/dev');

  const message = searchParams?.status ? MESSAGES[searchParams.status] : undefined;

  return (
    <Card>
      <CardBody className="space-y-5 p-6">
        <div className="space-y-1">
          <h1 className="text-lg font-bold">استعادة كلمة المرور</h1>
          <p className="text-sm text-muted">
            اكتب بريدك الإلكتروني وهنبعتلك رابطًا لتعيين كلمة مرور جديدة.
          </p>
        </div>

        {message && <Alert tone={message.tone}>{message.text}</Alert>}

        {/*
          A plain HTML form bound straight to the Server Action. No client
          component, no useFormState, no useFormStatus — it posts natively and
          therefore works before hydration, without JavaScript, and under a
          policy that blocks scripts.
        */}
        <form action={requestPasswordResetAction} className="space-y-4">
          <Field label="البريد الإلكتروني" required>
            {(p) => (
              <Input {...p} name="email" type="email" autoComplete="email" required dir="ltr" />
            )}
          </Field>
          <Button type="submit" block size="lg">
            أرسل رابط الاستعادة
          </Button>
        </form>

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
