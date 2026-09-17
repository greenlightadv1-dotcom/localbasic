import Link from 'next/link';
import type { Metadata } from 'next';
import { previewInvitation } from '@/modules/core/members/invitations';
import { currentUser } from '@/modules/core/members/session';
import { Logo } from '@/components/brand/logo';
import { AcceptInvitation } from './accept-form';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'دعوة للانضمام',
  // A token in a URL must never reach a search index.
  robots: { index: false, follow: false },
};

/**
 * Accepting an invitation.
 *
 * The token in the URL says WHICH invitation this is. It does not say who the
 * visitor is — that comes from their own session, and the database refuses the
 * pair when the signed-in address is not the invited one. So a forwarded link
 * cannot be used by whoever received it.
 *
 * The preview is readable signed-out on purpose: someone has to be told which
 * business invited them, and to which address, before they can decide whether
 * to sign in or create an account.
 */
export default async function JoinPage({
  params,
}: {
  params: { token: string };
}) {
  const [invitation, user] = await Promise.all([
    previewInvitation(params.token),
    currentUser(),
  ]);

  const problem = !invitation
    ? 'هذه الدعوة غير صالحة.'
    : invitation.alreadyUsed
      ? 'هذه الدعوة استُخدمت أو سُحبت.'
      : invitation.expired
        ? 'انتهت صلاحية هذه الدعوة. اطلب من مدير الفريق إرسال دعوة جديدة.'
        : null;

  const wrongAccount =
    !problem && user && invitation
      ? user.email?.toLowerCase() !== invitation.email.toLowerCase()
      : false;

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4 py-10" dir="rtl">
      <div className="mb-6 flex justify-center">
        <Logo className="h-9" />
      </div>

      <div className="rounded-lg border border-line bg-elevated p-6 shadow-card">
        {problem ? (
          <>
            <h1 className="mb-2 text-lg font-bold text-fg">تعذّر قبول الدعوة</h1>
            <p className="text-sm text-muted" data-testid="invite-problem">{problem}</p>
          </>
        ) : (
          <>
            <h1 className="mb-1 text-lg font-bold text-fg">
              دعوة للانضمام إلى {invitation!.organizationName}
            </h1>
            <p className="mb-4 text-sm text-muted">
              أُرسلت هذه الدعوة إلى{' '}
              <span className="font-mono text-fg" dir="ltr">{invitation!.email}</span>
            </p>

            {!user ? (
              <>
                <p className="mb-4 text-sm text-muted">
                  سجّل الدخول بنفس البريد لقبول الدعوة. إن لم يكن لديك حساب، أنشئ
                  حسابًا بهذا البريد أولًا.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Link
                    href={`/sign-in?next=${encodeURIComponent(`/join/${params.token}`)}`}
                    className="inline-flex h-11 items-center justify-center rounded bg-primary px-5 text-sm font-semibold text-primary-fg hover:opacity-90"
                  >
                    تسجيل الدخول
                  </Link>
                  <Link
                    href={`/sign-up?next=${encodeURIComponent(`/join/${params.token}`)}`}
                    className="inline-flex h-11 items-center justify-center rounded border border-line px-5 text-sm font-semibold text-fg hover:bg-surface"
                  >
                    إنشاء حساب
                  </Link>
                </div>
              </>
            ) : wrongAccount ? (
              <p className="text-sm text-danger" data-testid="wrong-account">
                أنت مسجّل الدخول بحساب آخر ({user.email}). سجّل الخروج ثم ادخل
                بالبريد المدعو لقبول الدعوة.
              </p>
            ) : (
              <AcceptInvitation token={params.token} />
            )}
          </>
        )}
      </div>
    </main>
  );
}
