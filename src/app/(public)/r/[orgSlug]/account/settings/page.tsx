import type { Metadata } from 'next';
import { Card, CardBody } from '@/components/ui/card';
import { Alert } from '@/components/ui/alert';
import { AccountShell, requireCustomer } from '../shell';
import { SettingsForm } from '../forms';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'إعدادات الحساب',
  robots: { index: false, follow: false },
};

export default async function SettingsPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string };
  searchParams: { saved?: string };
}) {
  const { site, profile } = await requireCustomer(params.orgSlug);

  return (
    <AccountShell site={site} orgSlug={params.orgSlug} active="/settings" title="الإعدادات">
      {searchParams.saved && <Alert tone="success">تم حفظ تفضيلاتك.</Alert>}

      {/* Say plainly what these preferences do and do not do. Recording a
          choice is not the same as having somewhere to send a message, and a
          product that implies otherwise is lying to its customers. */}
      <Alert tone="info">
        نسجّل تفضيلاتك الآن، ولم يتم تفعيل إرسال رسائل بعد. عند إتاحة الإشعارات سنلتزم بما اخترته.
      </Alert>

      <Card>
        <CardBody className="p-5">
          <SettingsForm
            orgSlug={params.orgSlug}
            marketing={profile.marketingOptIn}
            orderUpdates={profile.orderUpdatesOptIn}
          />
        </CardBody>
      </Card>
    </AccountShell>
  );
}
