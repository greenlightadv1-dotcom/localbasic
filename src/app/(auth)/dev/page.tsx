import { notFound, redirect } from 'next/navigation';
import { isLocalDb } from '@/lib/supabase/local/db';
import { getPool } from '@/lib/supabase/local/db';
import { LOCAL_SESSION_COOKIE } from '@/lib/supabase/local/client';
import { cookies } from 'next/headers';
import { Card, CardBody } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

export const metadata = { title: 'دخول تجريبي' };
export const dynamic = 'force-dynamic';

const ROLE_HINTS: Record<string, { label: string; note: string }> = {
  'owner@demo.local': { label: 'المالك', note: 'كل الصلاحيات' },
  'manager@demo.local': { label: 'مدير الفرع', note: 'تشغيل كامل بدون إدارة المؤسسة' },
  'cashier@demo.local': { label: 'كاشير', note: 'الطلبات والتحصيل — بدون إدارة المنيو' },
  'kitchen@demo.local': { label: 'المطبخ', note: 'شاشة المطبخ فقط — بدون أي صلاحية مالية' },
  'waiter@demo.local': { label: 'كابتن', note: 'الصالة والتقديم — بدون أي صلاحية مالية' },
};

/**
 * LOCAL DEVELOPMENT ONLY.
 *
 * Lets a developer act as any seeded staff member so each role's view can be
 * inspected. Returns 404 unless the local database adapter is active, and that
 * adapter refuses to load in production at all.
 */
export default async function DevSignInPage() {
  if (!isLocalDb()) notFound();

  const { rows } = await getPool().query<{ id: string; email: string; full_name: string }>(
    `select u.id, u.email, coalesce(p.full_name, u.email) as full_name
     from auth.users u
     left join public.profiles p on p.id = u.id
     where u.email like '%@demo.local'
     order by u.created_at`,
  );

  async function signInAs(formData: FormData) {
    'use server';
    const userId = String(formData.get('userId'));
    cookies().set(LOCAL_SESSION_COOKIE, userId, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24,
    });
    redirect('/');
  }

  return (
    <Card>
      <CardBody className="space-y-4 p-6">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-bold">دخول تجريبي</h1>
            <Badge tone="warn">بيئة محلية</Badge>
          </div>
          <p className="text-sm text-muted">
            اختر موظفًا لتصفّح النظام بصلاحياته. البيانات تجريبية على قاعدة بيانات محلية.
          </p>
        </div>

        <ul className="space-y-2">
          {rows.map((user) => {
            const hint = ROLE_HINTS[user.email];
            return (
              <li key={user.id}>
                <form action={signInAs}>
                  <input type="hidden" name="userId" value={user.id} />
                  <button
                    type="submit"
                    className="flex w-full items-center justify-between gap-3 rounded border border-line bg-elevated p-3 text-start transition-colors hover:border-primary hover:bg-primary-soft"
                  >
                    <span>
                      <span className="block font-semibold">{user.full_name}</span>
                      <span className="block text-xs text-muted">{hint?.note}</span>
                    </span>
                    <Badge tone="info">{hint?.label ?? 'موظف'}</Badge>
                  </button>
                </form>
              </li>
            );
          })}
        </ul>
      </CardBody>
    </Card>
  );
}
